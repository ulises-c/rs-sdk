// Clan chat ("/" lines) parsing on the wire and the clan side tab's content. The routing itself
// (members only, online only, mute, filter, ignore, never public) runs against the real handlers
// in `bun run test:clan:integration`.
//   bun test server/engine/test/clan-chat.test.ts
import { describe, expect, test } from 'bun:test';
import { CLAN_CHAT_LINE, clanChatLine, parseClanCommand } from '../src/engine/clan/ClanCommands.js';
import { CLAN_TAB_ROWS, clanTabContent } from '../src/engine/clan/ClanTabContent.js';
import type { ClanMember } from '../src/engine/clan/ClanStore.js';
import EnginePacket from '../src/io/Packet.js';
import EngineWordPack from '../src/wordenc/WordPack.js';
import ClientPacket from '../../webclient/src/io/Packet.js';
import ClientWordPack from '../../webclient/src/wordfilter/WordPack.js';

function wire(text: string): string {
    const out = new ClientPacket(new Uint8Array(512));
    ClientWordPack.pack(out, text);
    const bytes = out.data.slice(0, out.pos);
    const buf = EnginePacket.alloc(1);
    buf.pdata(bytes, 0, bytes.length);
    buf.pos = 0;
    const s = EngineWordPack.unpack(buf, bytes.length);
    buf.release();
    return s;
}
const chat = (typed: string) => {
    const seen = wire(typed);
    if (parseClanCommand(seen)) return { command: true, text: null };
    return { command: false, text: CLAN_CHAT_LINE.exec(seen)?.[1] ?? null };
};

describe('clan chat lines on the wire', () => {
    test('"/text" arrives as " Text" and is a clan line', () => {
        expect(wire('/hello all')).toBe(' Hello all');
        expect(chat('/hello all')).toEqual({ command: false, text: 'Hello all' });
    });
    test('"/clan ..." stays a command, not a chat line', () => {
        expect(chat('/clan info').command).toBe(true);
        expect(chat('/clans are fun')).toEqual({ command: false, text: 'Clans are fun' });
    });
    test('ordinary public chat is untouched', () => {
        expect(chat('hello all').text).toBeNull();
        expect(chat('clan info').command).toBe(false);
        expect(chat('/').text).toBeNull();
        expect(chat('/   ').text).toBeNull();
    });
    test('digits and punctuation survive', () => {
        expect(chat('/meet at varrock west, 5 min!').text).toBe('Meet at varrock west, 5 min!');
    });
    test('the game message format', () => {
        expect(clanChatLine('Stud Unit', 'Clan Founder', 'Hi')).toBe('[Stud Unit] Clan Founder: Hi');
    });
});

const member = (owner: string, rank: number): ClanMember => ({ owner, clan_id: 1, rank, prev_rank: rank, joined: 0, rank_since: 0, invited_by: null, trusted: 0 });

describe('clan tab content', () => {
    const members = [member('clan_founder', 9), member('bot_tester', 5), member('member_one', 3), member('bot_geometry', 1)];
    test('online first in rank order, offline after in red, counts', () => {
        const online = new Map([
            ['bot_geometry', { displayName: 'Bot Geometry' }],
            ['bot_tester', { displayName: 'Bot Tester' }]
        ]);
        const c = clanTabContent({ id: 1, display: 'Stud Unit' }, members, online, 4);
        expect(c.title).toBe('Stud Unit');
        expect(c.members).toBe('Members: 4');
        expect(c.online).toBe('Online: 2');
        expect(c.names.split('\\n')).toEqual(['Bot Tester', 'Bot Geometry', 'Clan Founder', 'Member One']);
        expect(c.ranks.split('\\n')).toEqual(['Captain', 'Recruit', '@red@Owner', '@red@Sergeant']);
        expect(c.state).toMatchObject({ seq: 4, clan: { id: 1, name: 'Stud Unit' }, memberCount: 4, onlineCount: 2 });
        expect(c.state.members.map(m => m.online)).toEqual([true, true, false, false]);
    });
    test('a roster longer than the list ends with "...and N more"; the JSON keeps everyone', () => {
        const many = Array.from({ length: CLAN_TAB_ROWS + 25 }, (_, i) => member(`bot_${i}`, 1));
        const c = clanTabContent({ id: 2, display: 'Big' }, many, new Map());
        const rows = c.names.split('\\n');
        expect(rows.length).toBe(CLAN_TAB_ROWS);
        expect(rows.at(-1)).toBe('@yel@...and 26 more');
        expect(c.state.members.length).toBe(CLAN_TAB_ROWS + 25);
    });
});
