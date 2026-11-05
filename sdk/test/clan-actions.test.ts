/**
 * Logic tests for the clan storage porcelain (sdk/clan-actions.ts) and the openBank fix,
 * against a small simulated server. The real handlers are covered by
 * `bun run test:clan:integration`.
 */
import { describe, expect, test } from 'bun:test';
import { BotSDK } from '../index';
import { BotActions } from '../actions';
import { CLAN_BANK_BUTTON_ID } from '../clan-actions';
import type { ClanStorageState } from '../clan-types';

type Inv = { slot: number; id: number; name: string; count: number }[];
function sim(opts: { member?: boolean; items?: ClanStorageState['items']; inv?: Inv; lie?: boolean; silent?: boolean } = {}) {
    const sdk = new BotSDK({ botUsername: 'clan-test', autoLaunchBrowser: false } as any);
    let modal: 'none' | 'bank' | 'clan' | 'shop' = 'none';
    let inv: Inv = opts.inv ?? [{ slot: 0, id: 1511, name: 'Logs', count: 1 }, { slot: 1, id: 995, name: 'Coins', count: 50 }];
    const messages: { text: string; type: number; sender: string }[] = [];
    let s: ClanStorageState = {
        isOpen: true, session: 7, revision: 1, actionRevision: 0, storeRevision: 1, serverTime: 0,
        clan: { id: 1, name: 'Stud Unit' }, rank: 9, rankName: 'Owner', effectiveRank: 9, canDeposit: true,
        capacity: { used: 1, max: 800 }, noteMode: false,
        items: opts.items ?? [{ slot: 0, id: 436, name: 'Copper ore', count: 5, minRank: 3, canWithdraw: true, cooldownUntil: null, reason: null }],
        cooldowns: { newMember: null, promotion: null },
        controls: { close: 10, bank: 11, mode: 12, depositInventory: 13 },
        components: { inv: 20, sideInv: 21 },
        input: null, notice: '', error: null, errorReason: null, receipt: null
    };
    let pendingCount: { kind: 'deposit' | 'withdraw'; slot: number } | null = null;
    let token = 0;
    const sent: any[] = [];
    const sync = () => {
        (sdk as any).state = { modalOpen: modal !== 'none', bank: { isOpen: modal === 'bank', items: [] }, interface: { isOpen: modal !== 'none' }, clanStorage: modal === 'clan' ? s : null, inventory: inv, gameMessages: messages };
    };
    const bump = (patch: Partial<ClanStorageState>) => (s = { ...s, revision: s.revision + 1, actionRevision: s.actionRevision + 1, error: null, errorReason: null, receipt: null, ...patch });
    const moveIn = (slot: number, n: number) => {
        const it = inv.find(i => i.slot === slot) as Inv[number];
        const m = Math.min(n, it.count);
        it.count -= opts.lie ? m - 1 : m;
        inv = inv.filter(i => i.count > 0);
        const have = s.items.find(i => i.id === it.id);
        if (have) have.count += m;
        else s.items = [...s.items, { slot: s.items.length, id: it.id, name: it.name, count: m, minRank: 3, canWithdraw: true, cooldownUntil: null, reason: null }];
        bump({ receipt: { token: ++token, kind: 'deposit', item: it.id, count: m } });
    };
    const moveOut = (slot: number, n: number) => {
        const it = s.items[slot] as ClanStorageState['items'][number];
        const m = Math.min(n, it.count);
        it.count -= m;
        const have = inv.find(i => i.id === it.id);
        if (have) have.count += m;
        else inv = [...inv, { slot: inv.length + 5, id: it.id, name: it.name, count: m }];
        bump({ receipt: { token: ++token, kind: 'withdraw', item: it.id, count: m } });
    };
    (sdk as any).isConnected = () => true;
    (sdk as any).getStateAge = () => 0;
    (sdk as any).sendAction = async (a: any) => {
        sent.push(a);
        if (opts.silent) return { success: true, message: 'sent' };
        if (a.type === 'clickComponent') {
            if (a.componentId === CLAN_BANK_BUTTON_ID && modal === 'bank') {
                if (opts.member === false) messages.push({ text: "You're not in a clan.", type: 0, sender: '' });
                else modal = 'clan';
            } else if (a.componentId === s.controls.close) modal = 'none';
            else if (a.componentId === s.controls.bank) modal = 'bank';
            else if (a.componentId === s.controls.mode) bump({ noteMode: !s.noteMode });
            else if (a.componentId === s.controls.depositInventory) {
                const total = inv.reduce((n, i) => n + i.count, 0);
                for (const i of [...inv]) moveIn(i.slot, i.count);
                bump({ receipt: { token: ++token, kind: 'depositInventory', count: total, kinds: 2, skipped: 0 } });
            }
        } else if (a.type === 'clickComponentWithOption') {
            const amount = [1, 5, 10, 2 ** 31 - 1][a.optionIndex - 1];
            const kind = a.componentId === s.components.sideInv ? 'deposit' : 'withdraw';
            if (!amount) {
                pendingCount = { kind, slot: a.slot };
                bump({ input: kind });
            } else if (kind === 'deposit') moveIn(a.slot, amount);
            else if (!s.items[a.slot]?.canWithdraw) bump({ error: 'You can withdraw that again in 4m.', errorReason: 'cooldown' });
            else moveOut(a.slot, amount);
        } else if (a.type === 'submitCountDialog' && pendingCount) {
            const p = pendingCount;
            pendingCount = null;
            s = { ...s, input: null };
            if (p.kind === 'deposit') moveIn(p.slot, a.value);
            else moveOut(p.slot, a.value);
        }
        sync();
        return { success: true, message: 'Dispatched' };
    };
    (sdk as any).waitForCondition = async (pred: (st: any) => boolean, timeout: number) => {
        sync();
        if (pred((sdk as any).state)) return (sdk as any).state;
        await Bun.sleep(Math.min(timeout, 30));
        sync();
        if (pred((sdk as any).state)) return (sdk as any).state;
        throw new Error('timeout');
    };
    sync();
    const bot = new BotActions(sdk);
    // bank opening: stub the walking part
    (bot as any).helpers.findNearbyBank = undefined;
    return {
        sdk, bot, sent,
        setModal: (m: typeof modal) => { modal = m; sync(); },
        inv: () => inv, store: () => s
    };
}

describe('clan storage actions', () => {
    test('openClanStorage clicks the bank-screen button and confirms the screen', async () => {
        const t = sim();
        t.setModal('bank');
        const r = await t.bot.openClanStorage(500);
        expect(r.success).toBe(true);
        expect(t.sent[0]).toMatchObject({ type: 'clickComponent', componentId: CLAN_BANK_BUTTON_ID });
        expect(t.sdk.getClanStorageState()?.clan.name).toBe('Stud Unit');
    });
    test('openClanStorage reports not_member from the game message', async () => {
        const t = sim({ member: false });
        t.setModal('bank');
        const r = await t.bot.openClanStorage(500);
        expect(r).toMatchObject({ success: false, reason: 'not_member' });
    });
    test('deposit all / deposit X verify the backpack delta', async () => {
        const t = sim();
        t.setModal('clan');
        const x = await t.bot.clanDeposit('Coins', 20, 500);
        expect(x).toMatchObject({ success: true, count: 20, item: 995 });
        expect(t.sent.map(a => a.type)).toEqual(['clickComponentWithOption', 'submitCountDialog']);
        const all = await t.bot.clanDeposit(/^logs$/i, 'all', 500);
        expect(all).toMatchObject({ success: true, count: 1 });
        expect(t.inv().find(i => i.id === 1511)).toBeUndefined();
    });
    test('a mismatched backpack delta is reported as unknown, never retried', async () => {
        const t = sim({ lie: true });
        t.setModal('clan');
        const r = await t.bot.clanDeposit('Coins', 10, 500);
        expect(r).toMatchObject({ success: false, reason: 'unexpected_delta', outcome: 'unknown' });
        expect(t.sent.length).toBe(1);
    });
    test('withdraw items and notes; mode toggles only when needed', async () => {
        const t = sim();
        t.setModal('clan');
        expect(await t.bot.clanWithdraw('Copper ore', 1, {}, 500)).toMatchObject({ success: true, count: 1 });
        const n = await t.bot.clanWithdraw(436, 2, { noted: true }, 500);
        expect(n.success).toBe(true);
        expect(t.store().noteMode).toBe(true);
        expect(t.sent.filter(a => a.componentId === t.store().controls.mode).length).toBe(1);
    });
    test('local refusal on rank/cooldown without dispatch; force surfaces the server reason', async () => {
        const t = sim({ items: [{ slot: 0, id: 995, name: 'Coins', count: 100, minRank: 5, canWithdraw: false, cooldownUntil: 5, reason: 'Cooldown' }, { slot: 1, id: 1079, name: 'Rune platelegs', count: 1, minRank: 6, canWithdraw: false, cooldownUntil: null, reason: 'Needs General' }] });
        t.setModal('clan');
        expect(await t.bot.clanWithdraw('Rune platelegs', 1, {}, 500)).toMatchObject({ success: false, reason: 'rank' });
        expect(await t.bot.clanWithdraw('Coins', 1, {}, 500)).toMatchObject({ success: false, reason: 'cooldown' });
        expect(t.sent.length).toBe(0);
        expect(await t.bot.clanWithdraw('Coins', 1, { force: true }, 500)).toMatchObject({ success: false, reason: 'cooldown' });
        expect(t.sent.length).toBe(1);
    });
    test('deposit inventory, invalid amounts, missing screen and timeouts', async () => {
        const t = sim();
        expect(await t.bot.clanDeposit('Coins', 1, 500)).toMatchObject({ success: false, reason: 'no_interface' });
        t.setModal('clan');
        expect(await t.bot.clanDeposit('Coins', 0, 500)).toMatchObject({ success: false, reason: 'invalid_argument' });
        expect(await t.bot.clanDepositInventory(500)).toMatchObject({ success: true, count: 51 });
        expect(t.inv()).toEqual([]);
        const silent = sim({ silent: true });
        silent.setModal('clan');
        expect(await silent.bot.clanDeposit('Coins', 1, 100)).toMatchObject({ success: false, reason: 'timeout', outcome: 'unknown' });
    });
    test('openBank: another open interface is not the bank; from clan storage it returns to the bank', async () => {
        const t = sim();
        t.setModal('clan');
        const r = await t.bot.openBank(500);
        expect(r).toMatchObject({ success: true, message: 'Bank opened from clan storage' });
        t.setModal('bank');
        expect((await t.bot.openBank(500)).message).toBe('Bank already open');
        const c = await t.bot.closeClanStorage(500);
        expect(c.message).toBe('Clan storage is not open.');
    });
});
