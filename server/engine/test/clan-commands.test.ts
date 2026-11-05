// "/clan" text through the client word packer and the engine unpacker, then the parser.
//   bun test server/engine/test/clan-commands.test.ts
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { parseClanCommand, parseDuration, splitTrailingRank, runClanCommand } from '../src/engine/clan/ClanCommands.js';
import { ClanStore } from '../src/engine/clan/ClanStore.js';
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

describe('clan chat commands on the wire', () => {
    test('"/clan create Stud Unit" survives packing (slash becomes a space)', () => {
        const seen = wire('/clan create Stud Unit');
        expect(seen.toLowerCase()).toBe(' clan create stud unit');
        expect(parseClanCommand(seen)).toEqual(['create', 'stud', 'unit']);
    });
    test('underscores and case are lost; names are matched space-insensitively', () => {
        expect(parseClanCommand(wire('/clan invite bot_geometry'))).toEqual(['invite', 'bot', 'geometry']);
        expect(parseClanCommand(wire('/CLAN INFO'))).toEqual(['info']);
        expect(parseClanCommand(wire('/clan'))).toEqual([]);
    });
    test('ordinary chat mentioning clans is not a command', () => {
        for (const t of ['clan create x', 'my clan is great', 'clanky', ' clanky']) expect(parseClanCommand(wire(t))).toBeNull();
    });
    test('trailing rank and durations', () => {
        expect(splitTrailingRank(['bot', 'geometry', 'deputy', 'owner'])).toEqual({ name: 'bot geometry', rank: 'deputy owner' });
        expect(splitTrailingRank(['bot', 'geometry', '6'])).toEqual({ name: 'bot geometry', rank: '6' });
        expect(parseDuration('5m')).toBe(300);
        expect(parseDuration('2d')).toBe(172800);
        expect(parseDuration('x')).toBeUndefined();
    });
    test('command runner: create, invite with a spaced name, accept, rank, info, help', () => {
        const store = new ClanStore(new Database(':memory:', { strict: true }), {
            canonical: id => id,
            noted: id => id,
            name: () => 'Coins',
            value: () => 1,
            coins: () => 995
        });
        expect(runClanCommand(store, 'bot_tester', parseClanCommand(wire('/clan create Stud Unit'))!).join(' ')).toContain('Stud Unit');
        runClanCommand(store, 'bot_tester', parseClanCommand(wire('/clan invite bot_geometry'))!);
        runClanCommand(store, 'bot_geometry', parseClanCommand(wire('/clan accept stud unit'))!);
        expect(store.member('bot_geometry')?.rank).toBe(1);
        runClanCommand(store, 'bot_tester', parseClanCommand(wire('/clan rank bot_geometry deputy owner'))!);
        expect(store.member('bot_geometry')?.rank).toBe(8);
        expect(runClanCommand(store, 'bot_geometry', ['info']).join(' ')).toContain('Deputy owner');
        expect(runClanCommand(store, 'bot_geometry', []).join(' ')).toContain('/clan create');
    });
});
