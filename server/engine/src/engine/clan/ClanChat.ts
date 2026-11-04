import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { clanStorageEnabled, clanStore } from './ClanLedger.js';
import { ClanError } from './ClanStore.js';
import { parseClanCommand, runClanCommand } from './ClanCommands.js';

const notify = (owner: string, line: string) => World.getPlayerByUsername(owner)?.messageGame(line);

/** Public chat hook: true when the text was a clan command (never broadcast). Delegated from MessagePublicHandler. */
export function clanPublicChat(p: Player, text: string): boolean {
    if (!clanStorageEnabled()) return false;
    const args = parseClanCommand(text);
    if (!args) return false;
    p.socialProtect = true;
    let lines: string[];
    try {
        lines = runClanCommand(clanStore(), p.username, args, notify);
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
