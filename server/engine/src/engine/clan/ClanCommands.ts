import ObjType from '#/cache/config/ObjType.js';
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { toDisplayName } from '#/util/JString.js';
import { parseRank, RANK_WORDS, rankName } from './ClanRanks.js';
import { clanStorageEnabled, clanStore } from './ClanRuntime.js';
import { ClanError, type ClanStore } from './ClanStore.js';

/**
 * "/clan ..." commands typed in public chat. The 2004 word packer has no '/', so the client
 * sends it as a space: the server sees " Clan create stud unit" (sentence case, '_' also
 * lost). A leading space or slash before "clan" marks a command; plain "clan ..." stays chat.
 */
export const CLAN_COMMAND = /^[\s/]+clan(?:\s+(.*))?$/i;

export function parseClanCommand(text: string): string[] | null {
    const m = CLAN_COMMAND.exec(text.replace(/\s+$/, ''));
    if (!m) return null;
    return (m[1] ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
}

const HELP = [
    '/clan create NAME, /clan invite PLAYER, /clan accept [NAME], /clan leave, /clan info',
    '/clan kick PLAYER, /clan rank PLAYER RANK, /clan trust PLAYER, /clan disband',
    '/clan access ITEM RANK|default [COOLDOWN e.g. 5m], /clan set SETTING VALUE'
];

const who = (name: string) => toDisplayName(name);

/** Split "bot geometry deputy owner" into ["bot geometry", "deputy owner"]. */
export function splitTrailingRank(words: string[]): { name: string; rank: string } | null {
    const line = words.join(' ');
    for (const r of [...RANK_WORDS, 'default', ...'123456789'.split('')]) {
        if (line === r) return null;
        if (line.endsWith(' ' + r)) return { name: line.slice(0, -r.length - 1).trim(), rank: r };
    }
    return null;
}

/** "5m", "300s", "1h", "2d"; a bare number is seconds. */
export function parseDuration(token: string): number | undefined {
    const m = /^(\d+)([smhd]?)$/.exec(token);
    if (!m) return undefined;
    return Number(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2] as '' | 's' | 'm' | 'h' | 'd'];
}

let byName: Map<string, number> | undefined;
let byNameSource: unknown;
/** Real (unnoted) item by its in-game name, preferring tradeable items; or a numeric id. */
export function findItem(name: string): number | undefined {
    if (/^\d+$/.test(name)) return Number(name);
    if (byNameSource !== ObjType.configs) {
        byNameSource = ObjType.configs;
        byName = new Map();
        for (const o of ObjType.configs) {
            if (!o?.name || o.certtemplate !== -1) continue;
            const key = o.name.toLowerCase();
            const current = byName.get(key);
            if (current === undefined || (!ObjType.get(current).tradeable && o.tradeable)) byName.set(key, o.id);
        }
    }
    return byName!.get(name.toLowerCase());
}

function tellMembers(store: ClanStore, clanId: number, line: string, except?: string) {
    for (const m of store.members(clanId)) {
        if (m.owner === except) continue;
        World.getPlayerByUsername(m.owner)?.messageGame(line);
    }
}

/** Run one command; returns the reply lines. Exposed for tests. */
export function runClanCommand(store: ClanStore, actor: string, args: string[]): string[] {
    const [verb = 'help', ...rest] = args;
    const arg = rest.join(' ');
    switch (verb) {
        case 'create': {
            if (!arg) return ['Usage: /clan create NAME'];
            const clan = store.create(actor, arg);
            return [`You founded the clan ${clan.display}. Invite members with /clan invite PLAYER.`];
        }
        case 'invite': {
            if (!arg) return ['Usage: /clan invite PLAYER'];
            const r = store.invite(actor, arg);
            World.getPlayerByUsername(r.target)?.messageGame(`${who(actor)} invites you to join the clan ${r.clan.display}. Type /clan accept ${r.clan.display} within 10 minutes.`);
            return [`You invited ${who(r.target)} to ${r.clan.display}. The invite lasts 10 minutes.`];
        }
        case 'accept': {
            const clan = store.accept(actor, arg || undefined);
            tellMembers(store, clan.id, `[Clan] ${who(actor)} joined ${clan.display}.`, actor);
            return [`You joined ${clan.display} as a Recruit. New members can withdraw from the clan storage after ${clan.settings.newMemberHours}h.`];
        }
        case 'leave': {
            const clan = store.leave(actor);
            tellMembers(store, clan.id, `[Clan] ${who(actor)} left ${clan.display}.`);
            return [`You left ${clan.display}. You can join or create another clan in 24h.`];
        }
        case 'kick': {
            if (!arg) return ['Usage: /clan kick PLAYER'];
            const r = store.kick(actor, arg);
            World.getPlayerByUsername(r.target)?.messageGame(`You were removed from ${r.clan.display}.`);
            tellMembers(store, r.clan.id, `[Clan] ${who(r.target)} was removed by ${who(actor)}.`, actor);
            return [`You removed ${who(r.target)} from ${r.clan.display}.`];
        }
        case 'rank': {
            const split = splitTrailingRank(rest);
            const rank = split ? parseRank(split.rank) : undefined;
            if (!split || !rank) return ['Usage: /clan rank PLAYER RANK (recruit, corporal, sergeant, lieutenant, captain, general, admin, deputy owner, owner)'];
            const r = store.setRank(actor, split.name, rank);
            const delay = r.delayedUntil ? ` The new rights start in ${store.wait(r.delayedUntil)}.` : '';
            tellMembers(store, r.clan.id, `[Clan] ${who(r.target)} is now ${rankName(r.rank)}.`, actor);
            return [`${who(r.target)} is now ${rankName(r.rank)}.${delay}`];
        }
        case 'trust': {
            if (!arg) return ['Usage: /clan trust PLAYER'];
            const r = store.trust(actor, arg);
            return [`${who(r.target)} no longer waits for new-member or promotion cooldowns.`];
        }
        case 'access': {
            const words = [...rest];
            let cooldown = 0;
            // A cooldown carries a unit (30s, 5m, 1h, 1d) so it never reads as a rank digit.
            const last = words[words.length - 1];
            if (words.length > 2 && last !== undefined && /^\d+[smhd]$/.test(last)) cooldown = parseDuration(words.pop()!)!;
            const split = splitTrailingRank(words);
            if (!split || !split.name) return ['Usage: /clan access ITEM RANK|default [COOLDOWN e.g. 5m]'];
            const item = findItem(split.name);
            if (item === undefined) return [`No item called "${split.name}".`];
            const rank = split.rank === 'default' ? null : parseRank(split.rank);
            if (rank === undefined) return ['Unknown rank.'];
            const r = store.setAccess(actor, item, rank, cooldown);
            const name = ObjType.get(r.item)?.name ?? split.name;
            return [rank === null ? `${name} now follows the clan's default withdraw rank.` : `${name}: ${rankName(rank)} or higher to withdraw${cooldown ? `, ${store.wait(store.now() + cooldown * 1000)} cooldown` : ''}.`];
        }
        case 'set': {
            const [key, ...value] = rest;
            if (!key || !value.length) return ['Usage: /clan set SETTING VALUE (minDeposit, minWithdraw, minInvite, newMemberHours, promotionHours, hiscores, showMembers, showBankValues, showStorage)'];
            const r = store.setSetting(actor, key, value.join(' '));
            return [`${r.key} is now ${typeof r.value === 'number' && r.key.startsWith('min') ? rankName(r.value) : r.value === true ? 'on' : r.value === false ? 'off' : r.value}.`];
        }
        case 'disband': {
            const clan = store.disband(actor);
            return [`You disbanded ${clan.display}.`];
        }
        case 'info': {
            const lines = [store.describeMember(actor)];
            const m = store.member(actor);
            if (!m) {
                const invites = store.invites(actor);
                if (invites.length) lines.push(`Invites: ${invites.map(i => i.clan.display).join(', ')} (/clan accept NAME).`);
            }
            return lines;
        }
        case 'members': {
            const m = store.member(actor);
            if (!m) return ['You are not in a clan.'];
            const list = store.members(m.clan_id).map(x => `${who(x.owner)} (${rankName(x.rank)})`);
            const lines: string[] = [];
            for (let i = 0; i < list.length; i += 6) lines.push(list.slice(i, i + 6).join(', '));
            return lines;
        }
        default:
            return HELP;
    }
}

/** Public chat hook: true when the text was a clan command (never broadcast). Delegated from MessagePublicHandler. */
export function clanPublicChat(p: Player, text: string): boolean {
    if (!clanStorageEnabled()) return false;
    const args = parseClanCommand(text);
    if (!args) return false;
    p.socialProtect = true;
    let lines: string[];
    try {
        lines = runClanCommand(clanStore(), p.username, args);
    } catch (error) {
        if (error instanceof ClanError) lines = [error.message];
        else {
            console.error('[clan] command failed', error);
            lines = ['Clan commands are unavailable right now.'];
        }
    }
    for (const line of lines) p.messageGame(line);
    return true;
}
