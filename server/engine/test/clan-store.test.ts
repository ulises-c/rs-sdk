// ClanStore unit tests: ledger rules on an in-memory (or temp-file) SQLite database with a
// fake backpack, so every rule is exercised without packed content. Run from the repo root:
//   bun test server/engine/test/clan-store.test.ts
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RANK } from '../src/engine/clan/ClanRanks.js';
import { ClanError, ClanStore, MAX_STACK, MANAGEMENT_PER_HOUR, type ClanAccount, type ClanItems } from '../src/engine/clan/ClanStore.js';

const COINS = 995,
    LOGS = 1511,
    LOGS_NOTE = 1512,
    RUNE = 1079,
    QUEST = 1,
    DUMMY = 2,
    ORE = 436;
const STACKABLE = new Set([COINS, LOGS_NOTE]);
const items: ClanItems = {
    canonical(id) {
        if (id === LOGS_NOTE) return LOGS;
        if (id === QUEST || id === DUMMY) throw new ClanError("That item can't go into the clan storage.", 'not_storable');
        return id;
    },
    noted: id => (id === LOGS ? LOGS_NOTE : id),
    name: id => ({ [COINS]: 'Coins', [LOGS]: 'Logs', [RUNE]: 'Rune platelegs', [ORE]: 'Copper ore' })[id] ?? `Item ${id}`,
    value: id => ({ [COINS]: 1, [LOGS]: 4, [RUNE]: 64000, [ORE]: 3 })[id] ?? 0,
    coins: () => COINS
};

/** A 28-slot backpack that behaves like the engine's Inventory for stacking and space. */
class Bag implements ClanAccount {
    slots: ({ id: number; count: number } | null)[] = new Array(28).fill(null);
    private snapshot: string | null = null;
    failSave = false;
    saves = 0;
    constructor(
        readonly owner: string,
        private db?: Database
    ) {}
    add(id: number, n: number) {
        return this.give(id, n);
    }
    count(id: number) {
        return this.slots.reduce((n, s) => n + (s?.id === id ? s.count : 0), 0);
    }
    take(id: number, n: number) {
        this.begin();
        let left = n;
        for (let i = 0; i < this.slots.length && left; i++) {
            const s = this.slots[i];
            if (s?.id !== id) continue;
            const m = Math.min(s.count, left);
            s.count -= m;
            left -= m;
            if (!s.count) this.slots[i] = null;
        }
        return n - left;
    }
    give(id: number, n: number) {
        this.begin();
        if (STACKABLE.has(id)) {
            let i = this.slots.findIndex(s => s?.id === id);
            if (i < 0) i = this.slots.indexOf(null);
            if (i < 0) return 0;
            const have = this.slots[i]?.count ?? 0;
            const total = Math.min(MAX_STACK, have + n);
            this.slots[i] = { id, count: total };
            return total - have;
        }
        let done = 0;
        for (let i = 0; i < this.slots.length && done < n; i++) {
            if (this.slots[i]) continue;
            this.slots[i] = { id, count: 1 };
            done++;
        }
        return done;
    }
    contents() {
        return this.slots.filter(s => s).map(s => ({ id: s!.id, count: this.count(s!.id) }));
    }
    free() {
        return this.slots.filter(s => !s).length;
    }
    private begin() {
        this.snapshot ??= JSON.stringify(this.slots);
    }
    save() {
        if (this.failSave) throw new Error('forced checkpoint failure');
        // A durable write inside the same transaction, like World.checkpointPlayers.
        this.db?.query('INSERT INTO fake_saves(owner, bag) VALUES(?, ?)').run(this.owner, JSON.stringify(this.slots));
        this.saves++;
        this.snapshot = null;
    }
    rollback() {
        if (this.snapshot) this.slots = JSON.parse(this.snapshot);
        this.snapshot = null;
    }
    commitFixture() {
        this.snapshot = null;
    }
}

function setup(path = ':memory:') {
    let clock = Date.UTC(2026, 10, 3, 12);
    const db = new Database(path, { create: true, strict: true });
    db.exec('CREATE TABLE IF NOT EXISTS fake_saves(owner TEXT, bag TEXT)');
    const store = new ClanStore(db, items, { now: () => clock, capacity: 5, maxMembers: 50, world: 10 });
    const bag = (owner: string) => new Bag(owner, db);
    const advance = (ms: number) => (clock += ms);
    return { db, store, bag, advance, now: () => clock };
}
const H = 3_600_000;
/** Founder + two members joined long enough ago to withdraw. */
function clanOf3() {
    const t = setup();
    t.store.create('founder', 'Stud Unit');
    for (const name of ['alice', 'bob']) {
        t.store.invite('founder', name);
        t.store.accept(name, 'stud unit');
    }
    t.advance(25 * H);
    return t;
}
const reason = (fn: () => unknown) => {
    try {
        fn();
    } catch (e) {
        if (e instanceof ClanError) return e.reason;
        throw e;
    }
    return 'ok';
};

describe('membership', () => {
    test('create, invite, accept, info, members; names normalized and title-cased', () => {
        const { store } = setup();
        const clan = store.create('Founder', '  stud   UNIT ');
        expect(clan.display).toBe('Stud Unit');
        expect(store.clanByName('STUD unit')?.id).toBe(clan.id);
        expect(reason(() => store.create('other', 'stud unit'))).toBe('name_taken');
        expect(reason(() => store.create('other', 'bad_name!'))).toBe('invalid');
        expect(reason(() => store.create('other', 'thirteen chars'))).toBe('invalid');
        expect(reason(() => store.accept('bot_geometry'))).toBe('no_invite');
        store.invite('founder', 'bot geometry');
        expect(store.invites('bot_geometry')[0].clan.id).toBe(clan.id);
        store.accept('bot_geometry', 'Stud Unit');
        expect(store.member('bot_geometry')!.rank).toBe(RANK.recruit);
        expect(store.members(clan.id).map(m => m.owner)).toEqual(['founder', 'bot_geometry']);
        expect(store.describeMember('bot_geometry')).toContain('Recruit');
        // coins default rule: Captain, 5 minute cooldown
        expect(store.accessRules(clan.id)).toEqual([{ item: COINS, min_rank: RANK.captain, cooldown_s: 300 }]);
    });
    test('invites expire after 10 minutes and need the invite rank', () => {
        const t = setup();
        t.store.create('founder', 'Stud Unit');
        t.store.invite('founder', 'late');
        t.advance(11 * 60_000);
        expect(reason(() => t.store.accept('late'))).toBe('no_invite');
        t.store.invite('founder', 'alice');
        t.store.accept('alice');
        expect(reason(() => t.store.invite('alice', 'carol'))).toBe('permission');
        t.store.setSetting('founder', 'minInvite', 'recruit');
        expect(reason(() => t.store.invite('alice', 'carol'))).toBe('ok');
    });
    test('owner cannot leave; ownership transfer; disband only when empty', () => {
        const t = clanOf3();
        expect(reason(() => t.store.leave('founder'))).toBe('permission');
        t.store.setRank('founder', 'alice', RANK.owner);
        expect(t.store.member('alice')!.rank).toBe(RANK.owner);
        expect(t.store.member('founder')!.rank).toBe(RANK.deputy);
        expect(t.store.clan(t.store.member('alice')!.clan_id)!.owner).toBe('alice');
        const bag = t.bag('alice');
        bag.add(ORE, 1);
        bag.commitFixture();
        t.store.deposit(bag, ORE, 1);
        expect(reason(() => t.store.disband('alice'))).toBe('permission');
        t.store.withdraw(bag, ORE, 1);
        t.store.disband('alice');
        expect(t.store.member('bob')).toBeUndefined();
        expect(t.store.clanByName('stud unit')).toBeUndefined();
        // a disbanded name can be founded again; disband is no rejoin penalty
        expect(t.store.create('bob', 'Stud Unit').display).toBe('Stud Unit');
    });
    test('kick and rank permissions follow the OSRS ladder', () => {
        const t = clanOf3();
        expect(reason(() => t.store.kick('alice', 'bob'))).toBe('permission');
        expect(reason(() => t.store.setRank('alice', 'bob', RANK.sergeant))).toBe('permission');
        t.store.trust('founder', 'alice');
        t.store.setRank('founder', 'alice', RANK.admin);
        expect(reason(() => t.store.setRank('alice', 'bob', RANK.admin))).toBe('permission'); // admin ranks below admin only
        t.store.setRank('alice', 'bob', RANK.general);
        expect(reason(() => t.store.kick('alice', 'founder'))).toBe('permission');
        expect(reason(() => t.store.setRank('alice', 'alice', RANK.recruit))).toBe('permission');
        t.store.kick('alice', 'bob');
        expect(t.store.member('bob')).toBeUndefined();
    });
    test('rejoin cooldown after leave or kick: 24h for joining or founding any clan', () => {
        const t = clanOf3();
        t.store.leave('bob');
        expect(reason(() => t.store.create('bob', 'Bobs'))).toBe('cooldown');
        t.store.invite('founder', 'bob');
        expect(reason(() => t.store.accept('bob'))).toBe('cooldown');
        t.advance(24 * H + 1);
        t.store.invite('founder', 'bob');
        expect(reason(() => t.store.accept('bob'))).toBe('ok');
    });
    test('management rate limit: kicks and rank changes per actor per hour', () => {
        const t = setup();
        t.store.create('founder', 'Stud Unit');
        for (let i = 0; i < MANAGEMENT_PER_HOUR + 1; i++) {
            t.store.invite('founder', `m${i}`);
            t.store.accept(`m${i}`);
        }
        for (let i = 0; i < MANAGEMENT_PER_HOUR; i++) t.store.setRank('founder', `m${i}`, RANK.corporal);
        expect(reason(() => t.store.kick('founder', `m${MANAGEMENT_PER_HOUR}`))).toBe('rate_limit');
        t.advance(H + 1);
        expect(reason(() => t.store.kick('founder', `m${MANAGEMENT_PER_HOUR}`))).toBe('ok');
    });
    test('settings: privacy needs Deputy, others Admin; values validated', () => {
        const t = clanOf3();
        t.store.trust('founder', 'alice');
        t.store.setRank('founder', 'alice', RANK.admin);
        expect(reason(() => t.store.setSetting('alice', 'hiscores', 'off'))).toBe('permission');
        expect(reason(() => t.store.setSetting('alice', 'minWithdraw', 'corporal'))).toBe('ok');
        expect(reason(() => t.store.setSetting('alice', 'newMemberHours', 'lots'))).toBe('invalid');
        expect(reason(() => t.store.setSetting('founder', 'nonsense', '1'))).toBe('invalid');
        t.store.setSetting('founder', 'hiscores', 'off');
        const clan = t.store.clanByName('stud unit')!;
        expect(clan.settings.hiscores).toBe(false);
        expect(clan.settings.minWithdraw).toBe(RANK.corporal);
    });
});

describe('storage', () => {
    test('conservation: backpack + store totals constant across every op (notes deposit as items)', () => {
        const t = clanOf3();
        t.store.trust('founder', 'alice');
        t.store.setRank('founder', 'alice', RANK.captain);
        const a = t.bag('alice');
        a.add(LOGS, 3);
        a.add(LOGS_NOTE, 40);
        a.add(COINS, 1000);
        a.add(ORE, 5);
        a.commitFixture();
        const clanId = t.store.member('alice')!.clan_id;
        const total = (id: number) => a.count(id) + (id === LOGS ? a.count(LOGS_NOTE) : 0) + t.store.count(clanId, id);
        const before = [LOGS, COINS, ORE].map(total);
        const check = () => expect([LOGS, COINS, ORE].map(total)).toEqual(before);
        t.store.deposit(a, LOGS_NOTE, 15);
        check();
        expect(t.store.count(clanId, LOGS)).toBe(15);
        t.store.deposit(a, LOGS, 2);
        check();
        t.store.deposit(a, COINS, 600);
        check();
        t.store.withdraw(a, LOGS, 10, true);
        check();
        expect(a.count(LOGS_NOTE)).toBe(35);
        t.store.withdraw(a, LOGS, 2, false);
        check();
        t.store.withdraw(a, COINS, 100);
        check();
        const r = t.store.depositInventory(a);
        check();
        expect(r.moved.length).toBeGreaterThan(0);
        expect(a.contents()).toEqual([]);
        expect(t.store.contents(clanId).map(c => c.item)).toEqual([LOGS, COINS, ORE]); // first-deposit order
        expect(t.store.storageValue(clanId).value).toBe(t.store.contents(clanId).reduce((n, c) => n + items.value(c.item) * c.count, 0));
        expect(a.saves).toBe(7);
    });
    test('rank refusal names the rank; coins need Captain; per-item rules and default rank', () => {
        const t = clanOf3();
        const founder = t.bag('founder');
        founder.add(COINS, 500);
        founder.add(RUNE, 1);
        founder.add(ORE, 2);
        founder.commitFixture();
        t.store.deposit(founder, COINS, 500);
        t.store.deposit(founder, RUNE, 1);
        t.store.deposit(founder, ORE, 2);
        const alice = t.bag('alice');
        expect(reason(() => t.store.withdraw(alice, ORE, 1))).toBe('rank'); // recruit < sergeant default
        t.store.trust('founder', 'alice');
        t.store.setRank('founder', 'alice', RANK.sergeant);
        expect(reason(() => t.store.withdraw(alice, ORE, 1))).toBe('ok');
        try {
            t.store.withdraw(alice, COINS, 1);
        } catch (e) {
            expect((e as ClanError).message).toContain('Captain');
        }
        t.store.setAccess('founder', RUNE, RANK.lieutenant, 0);
        expect(reason(() => t.store.withdraw(alice, RUNE, 1))).toBe('rank');
        t.store.setAccess('founder', RUNE, null);
        expect(reason(() => t.store.withdraw(alice, RUNE, 1))).toBe('ok');
        const view = t.store.view('alice');
        expect(view.items.find(i => i.id === COINS)).toMatchObject({ canWithdraw: false, reason: 'Needs Captain', minRank: RANK.captain });
    });
    test('deposit rank: minDeposit setting', () => {
        const t = clanOf3();
        t.store.setSetting('founder', 'minDeposit', 'corporal');
        const bob = t.bag('bob');
        bob.add(ORE, 1);
        bob.commitFixture();
        expect(reason(() => t.store.deposit(bob, ORE, 1))).toBe('rank');
        expect(bob.count(ORE)).toBe(1);
    });
    test('new-member cooldown 24h; Owner/Deputy waiver (/clan trust)', () => {
        const t = setup();
        t.store.create('founder', 'Stud Unit');
        const f = t.bag('founder');
        f.add(ORE, 3);
        f.commitFixture();
        t.store.deposit(f, ORE, 3);
        t.store.setSetting('founder', 'minWithdraw', 'recruit');
        t.store.invite('founder', 'alice');
        t.store.accept('alice');
        t.store.invite('founder', 'bob');
        t.store.accept('bob');
        const alice = t.bag('alice'),
            bob = t.bag('bob');
        expect(reason(() => t.store.withdraw(alice, ORE, 1))).toBe('cooldown');
        expect(t.store.view('alice').cooldowns.newMember).toBe(t.now() + 24 * H);
        expect(reason(() => t.store.trust('alice', 'bob'))).toBe('permission');
        t.store.trust('founder', 'bob');
        expect(reason(() => t.store.withdraw(bob, ORE, 1))).toBe('ok');
        t.advance(24 * H + 1);
        expect(reason(() => t.store.withdraw(alice, ORE, 1))).toBe('ok');
        // the founder never waited
        expect(reason(() => t.store.withdraw(f, ORE, 1))).toBe('ok');
    });
    test('promotion cooldown: raised rights start after 12h, lowered ranks apply at once', () => {
        const t = clanOf3();
        const f = t.bag('founder');
        f.add(COINS, 100);
        f.add(ORE, 1);
        f.commitFixture();
        t.store.deposit(f, COINS, 100);
        t.store.deposit(f, ORE, 1);
        const alice = t.bag('alice');
        const r = t.store.setRank('founder', 'alice', RANK.captain);
        expect(r.delayedUntil).toBe(t.now() + 12 * H);
        expect(t.store.view('alice').effectiveRank).toBe(RANK.recruit);
        expect(reason(() => t.store.withdraw(alice, COINS, 10))).toBe('rank');
        t.advance(12 * H + 1);
        expect(reason(() => t.store.withdraw(alice, COINS, 10))).toBe('ok');
        // lowered: applies at once
        t.store.setRank('founder', 'alice', RANK.recruit);
        expect(t.store.view('alice').effectiveRank).toBe(RANK.recruit);
        expect(reason(() => t.store.withdraw(alice, ORE, 1))).toBe('rank');
        // raised again then lowered within the window: still the lower rank
        t.store.setRank('founder', 'alice', RANK.general);
        t.store.setRank('founder', 'alice', RANK.corporal);
        expect(t.store.view('alice').effectiveRank).toBe(RANK.recruit);
        // trusted members skip the promotion wait
        t.store.trust('founder', 'bob');
        expect(t.store.setRank('founder', 'bob', RANK.captain).delayedUntil).toBeNull();
        expect(t.store.view('bob').effectiveRank).toBe(RANK.captain);
    });
    test('item cooldown: coins 5 minutes; Admin and above exempt', () => {
        const t = clanOf3();
        const f = t.bag('founder');
        f.add(COINS, 1000);
        f.commitFixture();
        t.store.deposit(f, COINS, 1000);
        for (const name of ['alice', 'bob']) t.store.trust('founder', name);
        t.store.setRank('founder', 'alice', RANK.captain);
        t.store.setRank('founder', 'bob', RANK.admin);
        const alice = t.bag('alice'),
            bob = t.bag('bob');
        t.store.withdraw(alice, COINS, 10);
        expect(reason(() => t.store.withdraw(alice, COINS, 10))).toBe('cooldown');
        expect(t.store.view('alice').items[0].cooldownUntil).toBe(t.now() + 300_000);
        t.store.withdraw(bob, COINS, 10);
        expect(reason(() => t.store.withdraw(bob, COINS, 10))).toBe('ok');
        t.advance(300_001);
        expect(reason(() => t.store.withdraw(alice, COINS, 10))).toBe('ok');
        // custom cooldown rule
        t.store.setAccess('founder', COINS, RANK.captain, 3600);
        t.advance(400_000);
        t.store.withdraw(alice, COINS, 1);
        t.advance(1_800_000);
        expect(reason(() => t.store.withdraw(alice, COINS, 1))).toBe('cooldown');
    });
    test('full backpack: nothing moves; partial withdraw gives what fits', () => {
        const t = clanOf3();
        t.store.setSetting('founder', 'minWithdraw', 'recruit');
        const f = t.bag('founder');
        f.add(ORE, 10);
        f.commitFixture();
        t.store.deposit(f, ORE, 10);
        const alice = t.bag('alice');
        alice.add(RUNE, 28);
        alice.commitFixture();
        const clanId = t.store.member('alice')!.clan_id;
        expect(reason(() => t.store.withdraw(alice, ORE, 5))).toBe('full');
        expect(t.store.count(clanId, ORE)).toBe(10);
        expect(alice.count(RUNE)).toBe(28);
        alice.take(RUNE, 3);
        alice.commitFixture();
        const r = t.store.withdraw(alice, ORE, 5);
        expect(r.given).toBe(3);
        expect(t.store.count(clanId, ORE)).toBe(7);
    });
    test('stack overflow: store and backpack stacks cap at 2^31-1 without loss', () => {
        const t = clanOf3();
        const f = t.bag('founder');
        f.add(COINS, MAX_STACK);
        f.commitFixture();
        t.store.deposit(f, COINS, MAX_STACK - 5);
        expect(f.count(COINS)).toBe(5);
        f.add(COINS, 100);
        f.commitFixture();
        const r = t.store.deposit(f, COINS, 105);
        expect(r.count).toBe(5);
        expect(f.count(COINS)).toBe(100);
        expect(reason(() => t.store.deposit(f, COINS, 1))).toBe('full');
        // withdrawing into a full coin stack gives only what fits
        const clanId = t.store.member('founder')!.clan_id;
        f.slots[0] = { id: COINS, count: MAX_STACK - 2 };
        f.commitFixture();
        const w = t.store.withdraw(f, COINS, 50);
        expect(w.given).toBe(2);
        expect(t.store.count(clanId, COINS)).toBe(MAX_STACK - 2);
    });
    test('rollback on a forced failure: checkpoint error and SQLite error leave both sides unchanged', () => {
        const t = clanOf3();
        const f = t.bag('founder');
        f.add(ORE, 4);
        f.commitFixture();
        const clanId = t.store.member('founder')!.clan_id;
        f.failSave = true;
        expect(() => t.store.deposit(f, ORE, 4)).toThrow('forced checkpoint failure');
        expect(f.count(ORE)).toBe(4);
        expect(t.store.count(clanId, ORE)).toBe(0);
        expect(t.db.query('SELECT COUNT(*) n FROM fake_saves').get()).toEqual({ n: 0 });
        expect(t.store.log(clanId, 10, ['deposit'])).toEqual([]);
        f.failSave = false;
        t.store.deposit(f, ORE, 4);
        // A forced SQLite error inside the transaction (trigger) rolls back the backpack too.
        t.db.exec("CREATE TRIGGER boom BEFORE UPDATE ON clan_item BEGIN SELECT RAISE(ABORT, 'forced sqlite failure'); END");
        expect(() => t.store.withdraw(f, ORE, 2)).toThrow('forced sqlite failure');
        expect(f.count(ORE)).toBe(0);
        expect(t.store.count(clanId, ORE)).toBe(4);
        t.db.exec('DROP TRIGGER boom');
        expect(t.store.withdraw(f, ORE, 2).given).toBe(2);
    });
    test('capacity in item kinds; unstorable items refused; deposit-inventory skips them', () => {
        const t = clanOf3();
        const f = t.bag('founder');
        for (const id of [ORE, LOGS, RUNE, COINS, 600, 601, QUEST]) f.add(id, 1);
        f.commitFixture();
        expect(reason(() => t.store.deposit(f, QUEST, 1))).toBe('not_storable');
        const r = t.store.depositInventory(f);
        expect(r.moved.length).toBe(5); // capacity 5 kinds
        expect(r.skipped).toContain(QUEST);
        expect(f.count(QUEST)).toBe(1);
        expect(f.count(601)).toBe(1);
        expect(reason(() => t.store.deposit(f, 601, 1))).toBe('capacity');
    });
    test('stale: an item another viewer emptied is refused, not substituted', () => {
        const t = clanOf3();
        t.store.setSetting('founder', 'minWithdraw', 'recruit');
        const f = t.bag('founder');
        f.add(ORE, 1);
        f.commitFixture();
        t.store.deposit(f, ORE, 1);
        const before = t.store.view('alice');
        t.store.withdraw(t.bag('bob'), ORE, 1);
        expect(t.store.view('alice').revision).toBeGreaterThan(before.revision);
        expect(reason(() => t.store.withdraw(t.bag('alice'), ORE, 1))).toBe('stale');
    });
    test('restart persistence: a reopened ledger file has the same clans, items, rules and cooldowns', () => {
        const dir = mkdtempSync(join(tmpdir(), 'clan-store-'));
        try {
            const path = join(dir, 'market.sqlite');
            const t = setup(path);
            t.store.create('founder', 'Stud Unit');
            t.store.invite('founder', 'alice');
            t.store.accept('alice');
            const f = t.bag('founder');
            f.add(COINS, 77);
            f.add(ORE, 2);
            f.commitFixture();
            t.store.deposit(f, COINS, 77);
            t.store.deposit(f, ORE, 2);
            const snapshot = { members: t.store.members(1), items: t.store.contents(1), rules: t.store.accessRules(1), rev: t.store.revision(1) };
            t.db.close();
            const db = new Database(path, { strict: true });
            const again = new ClanStore(db, items);
            expect({ members: again.members(1), items: again.contents(1), rules: again.accessRules(1), rev: again.revision(1) }).toEqual(snapshot);
            expect(again.storageValue(1).value).toBe(77 + 6);
            db.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    test('audit log: create/join/deposit/withdraw/rank rows with world, coord and revision', () => {
        const t = clanOf3();
        const f = t.bag('founder');
        f.add(ORE, 1);
        f.commitFixture();
        t.store.deposit(f, ORE, 1, { coord: 123, world: 100 });
        const clanId = t.store.member('founder')!.clan_id;
        const [row] = t.store.log(clanId, 1, ['deposit']);
        expect(row).toMatchObject({ actor: 'founder', item: ORE, count: 1, world: 100, coord: 123 });
        expect(row.revision).toBe(t.store.revision(clanId));
        t.store.refused('alice', 'withdraw', new ClanError('nope', 'rank'), ORE);
        expect(t.store.log(clanId, 1, ['refused'])[0].detail).toBe('withdraw:rank:nope');
        expect(t.store.log(clanId, 100).map(r => r.action)).toEqual(expect.arrayContaining(['create', 'invite', 'join', 'deposit', 'refused']));
    });
});
