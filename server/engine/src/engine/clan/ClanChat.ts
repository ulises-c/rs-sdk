import WordEnc from '#/cache/wordenc/WordEnc.js';
import { db } from '#/db/query.js';
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import Environment from '#/util/Environment.js';
import { clanChatEnabled, clanStorageEnabled, clanStore } from './ClanLedger.js';
import { ClanError } from './ClanStore.js';
import { CLAN_CHAT_LINE, clanChatLine, parseClanCommand, runClanCommand } from './ClanCommands.js';
import { clanRosterChanged, onlineMembers } from './ClanTab.js';

const notify = (owner: string, line: string) => World.getPlayerByUsername(owner)?.messageGame(line);

/** Commands that can't change a roster, a rank or a clan name. */
const READ_ONLY = new Set(['info', 'members', 'help', 'invite', 'access']);

/** Usernames (safe login names) that ignore `sender`. The friend server keeps ignore lists in db.sqlite. */
export type IgnoreLookup = (sender: string) => Promise<Set<string>>;
const dbIgnoreLookup: IgnoreLookup = async sender => {
    const rows = await db
        .selectFrom('ignorelist as i')
        .innerJoin('account as a', 'a.id', 'i.account_id')
        .select('a.username')
        .where('i.value', '=', sender)
        .where('i.profile', '=', Environment.node.profile)
        .execute();
    return new Set(rows.map(r => r.username));
};
let ignoreLookup: IgnoreLookup = dbIgnoreLookup;
let ignoreWarned = false;
/** Delivery stays in send order even though the ignore lookup is asynchronous. */
let queue: Promise<void> = Promise.resolve();

/** Tests only: replace the ignore-list lookup (null restores the db.sqlite lookup). */
export function setClanChatIgnoreLookup(fn: IgnoreLookup | null): void {
    ignoreLookup = fn ?? dbIgnoreLookup;
}
/** Tests only: resolves when every queued clan chat line has been delivered. */
export function clanChatDrained(): Promise<void> {
    return queue;
}

function sendClanChat(p: Player, body: string): void {
    if (p.muted_until !== null && p.muted_until > new Date()) return; // as public chat: muted players are silent
    const store = clanStore();
    const member = store.member(p.username);
    const clan = member ? store.clan(member.clan_id) : undefined;
    if (!member || !clan) {
        p.messageGame('You are not in a clan. Lines starting with / go to your clan chat.');
        return;
    }
    const line = clanChatLine(clan.display, p.displayName, WordEnc.filter(body));
    // Logged like public chat (World logs logMessage), tagged so moderators can tell it apart.
    p.logMessage = `[clan ${clan.display}] ${body}`;
    const recipients = onlineMembers(clan.id);
    if (!recipients.includes(p)) recipients.push(p);
    const sender = p.username;
    queue = queue
        .then(() => ignoreLookup(sender))
        .catch(error => {
            if (!ignoreWarned) console.error('[clan] ignore-list lookup failed; delivering clan chat without it', error);
            ignoreWarned = true;
            return new Set<string>();
        })
        .then(ignoring => {
            for (const r of recipients) {
                if (r.username !== sender && ignoring.has(r.username)) continue;
                if (World.getPlayerByUsername(r.username) !== r) continue; // logged out meanwhile
                r.messageGame(line);
            }
        });
}

/**
 * Public chat hook (delegated from MessagePublicHandler, after its mute check): true when the text
 * was a clan command or a clan chat line. Either way it is never broadcast publicly.
 */
export function clanPublicChat(p: Player, text: string): boolean {
    if (!clanStorageEnabled()) return false;
    const args = parseClanCommand(text);
    if (args) {
        p.socialProtect = true;
        let lines: string[];
        let before: number | undefined;
        try {
            before = clanStore().member(p.username)?.clan_id;
            lines = runClanCommand(clanStore(), p.username, args, notify);
        } catch (error) {
            if (error instanceof ClanError) lines = [error.message];
            else {
                console.error('[clan] command failed', error);
                lines = ['Clan commands are unavailable right now.'];
            }
        }
        for (const line of lines) p.messageGame(line);
        if (!READ_ONLY.has(args[0] ?? 'help')) {
            try {
                clanRosterChanged([before, clanStore().member(p.username)?.clan_id]);
            } catch (error) {
                console.error('[clan] roster refresh failed', error);
            }
        }
        return true;
    }
    if (!clanChatEnabled()) return false;
    const m = CLAN_CHAT_LINE.exec(text);
    if (!m) return false;
    p.socialProtect = true;
    try {
        sendClanChat(p, m[1].trimEnd());
    } catch (error) {
        console.error('[clan] chat failed', error);
        p.messageGame('Clan chat is unavailable right now.');
    }
    return true;
}
