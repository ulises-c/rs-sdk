// Clan board ranking (pure) and the clan hiscore pages against a temporary db.sqlite + ledger.
//   bun test server/engine/test/clan-hiscores.test.ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eligible, rankClans, rankMembers, totals, type ClanMemberStats, type ClanSummary } from '../src/web/pages/ClanBoards.js';

const member = (owner: string, over: Partial<ClanMemberStats> = {}): ClanMemberStats => ({ owner, rank: 1, joined: 0, visible: true, totalLevel: 100, totalXp: 1000, skills: {}, qp: 0, bank: 0, ...over });
const clan = (id: number, name: string, members: ClanMemberStats[], over: Partial<ClanSummary> = {}): ClanSummary => ({ id, name, created: id * 1000, hiscores: true, showMembers: true, showBankValues: true, storageValue: 0, members, ...over });

describe('clan boards', () => {
    test('minimum members: only visible members count; hiscores off hides the clan', () => {
        const small = clan(1, 'Pair', [member('a'), member('b')]);
        const padded = clan(2, 'Padded', [member('a'), member('b'), member('staff', { visible: false })]);
        const ok = clan(3, 'Trio', [member('a'), member('b'), member('c')]);
        const off = clan(4, 'Private', [member('a'), member('b'), member('c')], { hiscores: false });
        expect([small, padded, ok, off].map(c => eligible(c, 3))).toEqual([false, false, true, false]);
        expect(rankClans([small, padded, ok, off], 'overall', 3).map(r => r.name)).toEqual(['Trio']);
        expect(totals(padded).members).toBe(2);
    });
    test('overall ranks by total XP, ties by total level then founding date', () => {
        const three = (lvl: number, xp: number) => [member('a', { totalLevel: lvl, totalXp: xp }), member('b', { totalLevel: lvl, totalXp: xp }), member('c', { totalLevel: lvl, totalXp: xp })];
        const rows = rankClans([clan(5, 'Young', three(100, 500)), clan(1, 'Old', three(100, 500)), clan(3, 'Higher', three(120, 500)), clan(9, 'Rich', three(50, 900))], 'overall', 3);
        expect(rows.map(r => [r.rank, r.name])).toEqual([
            [1, 'Rich'],
            [2, 'Higher'],
            [3, 'Old'],
            [4, 'Young']
        ]);
    });
    test('skill boards sum hiscore rows only (sub-15 skills have none and add 0)', () => {
        const a = clan(1, 'A', [member('x', { skills: { 8: 5000 } }), member('y', { skills: {} /* woodcutting < 15: no row */ }), member('z', { skills: { 8: 100 } })]);
        const b = clan(2, 'B', [member('x', { skills: { 8: 2000 } }), member('y', { skills: { 8: 2000 } }), member('z', { skills: { 8: 2000 } })]);
        expect(rankClans([a, b], 'skill:8', 3).map(r => [r.name, r.value])).toEqual([
            ['B', 6000],
            ['A', 5100]
        ]);
    });
    test('quest points, bank value, storage and wealth = bank values + storage', () => {
        const a = clan(1, 'A', [member('x', { qp: 10, bank: 100 }), member('y', { qp: 5, bank: 50 }), member('z', { qp: 1, bank: 0 })], { storageValue: 1000 });
        const b = clan(2, 'B', [member('x', { qp: 20, bank: 900 }), member('y', { qp: 0, bank: 0 }), member('z', { qp: 0, bank: 0 })], { storageValue: 10 });
        expect(rankClans([a, b], 'qp', 3).map(r => [r.name, r.value])).toEqual([
            ['B', 20],
            ['A', 16]
        ]);
        expect(rankClans([a, b], 'bank', 3).map(r => [r.name, r.value])).toEqual([
            ['B', 900],
            ['A', 150]
        ]);
        expect(rankClans([a, b], 'storage', 3).map(r => r.name)).toEqual(['A', 'B']);
        expect(rankClans([a, b], 'wealth', 3).map(r => [r.name, r.value])).toEqual([
            ['A', 1150],
            ['B', 910]
        ]);
    });
    test('average level per visible member; hidden members excluded from sums', () => {
        const a = clan(1, 'A', [member('x', { totalLevel: 300 }), member('y', { totalLevel: 100 }), member('z', { totalLevel: 200 }), member('h', { totalLevel: 2000, visible: false })]);
        expect(totals(a).average).toBe(200);
        expect(rankMembers(a, 'overall').map(m => m.owner)).not.toContain('h');
        expect(rankMembers(a, 'average').map(m => m.owner)).toEqual(['x', 'z', 'y']);
    });
});

test('clan pages, JSON, player link and privacy against a real db.sqlite and ledger', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clan-hiscores-'));
    try {
        const result = Bun.spawnSync([process.execPath, join(import.meta.dir, 'fixtures/clan-hiscores.ts')], {
            cwd: dir,
            env: { ...process.env, DB_BACKEND: 'sqlite', HISCORES_HIDDEN_NAMES: 'hidden', CLAN_HISCORES_ENABLED: 'true', CLAN_STORAGE_ENABLED: 'true', GE_DATABASE: join(dir, 'market.sqlite') }
        });
        const out = result.stdout.toString() + result.stderr.toString();
        if (result.exitCode !== 0) throw new Error(out);
        expect(out).toContain('PASS clan hiscore pages');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
