import type { ClanChatMessage } from './clan-types';
import type { GameMessage } from './types';

/**
 * Clan chat arrives as an ordinary game message (type 0), `[Clan name] Sender: text`, because
 * this revision's chatbox has no clan channel. Sending is public chat with a leading "/"
 * (the server routes it to the clan and never shows it publicly): sdk.sendClanChat(text).
 */
const LINE = /^\[([^\]]{1,40})\] ([A-Za-z0-9 _-]{1,12}): (.*)$/s;

export function parseClanChatLine(text: string): Omit<ClanChatMessage, 'tick'> | null {
    const m = LINE.exec(text);
    return m ? { clan: m[1]!, sender: m[2]!, text: m[3]! } : null;
}

/** Clan chat lines among game messages, oldest first. */
export function clanChatFromMessages(messages: readonly GameMessage[]): ClanChatMessage[] {
    const out: ClanChatMessage[] = [];
    for (const m of messages) {
        if (m.type !== 0) continue;
        const line = parseClanChatLine(m.text);
        if (line) out.push({ ...line, tick: m.tick });
    }
    return out.sort((a, b) => a.tick - b.tick);
}

/** The text to send as public chat for a clan chat line. */
export function clanChatCommand(text: string): string {
    return '/' + text.replace(/^[\s/]+/, '');
}
