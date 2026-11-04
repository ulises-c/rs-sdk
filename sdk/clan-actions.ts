import type { BotSDK } from './index';
import type { BotActions } from './actions';
import type { ClanStorageItem, ClanStorageResult, ClanStorageState } from './clan-types';
import type { ActionResult, BotWorldState } from './types';

/**
 * Reserved interface ids (server/PATCHES.md "Custom content IDs", clan block 40754-40772).
 * The engine resolves them by name; the SDK needs the button before the screen exists.
 */
export const CLAN_BANK_BUTTON_ID = 40754; // bank_main:clan_storage
export const CLAN_STORAGE_ROOT_ID = 40755; // clan_storage

const MAX_STACK = 2_147_483_647;
const activeSDKs = new WeakSet<BotSDK>();

class ClanFailure extends Error {
    constructor(
        message: string,
        readonly reason: string,
        readonly unknown = false
    ) {
        super(message);
    }
}

type Amount = number | 'all';
/** INV_BUTTON option for an amount: 1, 5, 10, All, else X (count dialog). */
function optionFor(amount: Amount): { op: number; count?: number } {
    if (amount === 'all') return { op: 4 };
    if (amount === 1) return { op: 1 };
    if (amount === 5) return { op: 2 };
    if (amount === 10) return { op: 3 };
    return { op: 5, count: amount };
}

/**
 * Clan storage porcelain: open from the bank screen's "Clan storage" button, deposit and
 * withdraw with server-acknowledged revisions and verified backpack deltas. Serial and
 * observation-driven like the GE actions; a dispatched mutation is never retried.
 */
export class ClanStorageActions {
    constructor(
        private sdk: BotSDK,
        private bot: BotActions
    ) {}

    private state(): ClanStorageState {
        if (!this.sdk.isConnected() || this.sdk.getStateAge() > 5000) throw new ClanFailure('No fresh game connection. Reconnect and inspect the clan storage before acting.', 'stale_state');
        const s = this.sdk.getClanStorageState();
        if (!s) throw new ClanFailure('Open the clan storage first (bot.openClanStorage()).', 'no_interface');
        return s;
    }

    private async run(work: () => Promise<ClanStorageResult>): Promise<ClanStorageResult> {
        if (activeSDKs.has(this.sdk)) return { success: false, reason: 'busy', message: 'Another clan storage action is still running.' };
        activeSDKs.add(this.sdk);
        try {
            return await work();
        } catch (error) {
            return {
                success: false,
                message: error instanceof Error ? error.message : String(error),
                reason: error instanceof ClanFailure ? error.reason : 'error',
                outcome: error instanceof ClanFailure && error.unknown ? 'unknown' : undefined,
                state: this.sdk.getClanStorageState() ?? undefined
            };
        } finally {
            activeSDKs.delete(this.sdk);
        }
    }

    /** Send, then wait for the server to acknowledge this command (new actionRevision) and satisfy `done`. */
    private async step(send: () => Promise<ActionResult>, done: (s: ClanStorageState) => boolean, deadline: number): Promise<ClanStorageState> {
        const before = this.state();
        const result = await send();
        if (!result.success) throw new ClanFailure(result.message, result.reason ?? 'dispatch_failed', result.reason === 'timeout' || result.reason === 'disconnected');
        let observed: BotWorldState;
        try {
            observed = await this.sdk.waitForCondition(
                w => {
                    const c = w.modalOpen ? w.clanStorage : null;
                    return !c || c.session !== before.session || (c.revision > before.revision && c.actionRevision > before.actionRevision && (!!c.error || ((!c.receipt || c.receipt.token !== before.receipt?.token) && done(c))));
                },
                Math.max(1, deadline - Date.now())
            );
        } catch {
            throw new ClanFailure('Clan storage result was not observed. The action may have applied; inspect sdk.getClanStorageState() and the backpack before retrying.', 'timeout', true);
        }
        const state = observed.modalOpen ? observed.clanStorage : null;
        if (!state || state.session !== before.session) throw new ClanFailure('The clan storage closed or reopened; inspect it before retrying.', 'session_changed', true);
        if (state.error) throw new ClanFailure(state.error, state.errorReason ?? 'server_rejected');
        return state;
    }

    private inventoryCount(id: number): number {
        return (this.sdk.getState()?.inventory ?? []).filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    }

    async open(timeout: number): Promise<ClanStorageResult> {
        return this.run(async () => {
            if (this.sdk.getClanStorageState()) return { success: true, message: 'Clan storage is open.', state: this.state(), outcome: 'confirmed' };
            const deadline = Date.now() + timeout;
            if (!this.sdk.getState()?.bank?.isOpen) {
                const bank = await this.bot.openBank(Math.max(1000, deadline - Date.now()));
                if (!bank.success) throw new ClanFailure(`Could not open a bank: ${bank.message}`, 'no_bank');
            }
            const messagesBefore = this.sdk.getState()?.gameMessages.length ?? 0;
            const sent = await this.sdk.sendClickComponent(CLAN_BANK_BUTTON_ID);
            if (!sent.success) throw new ClanFailure(sent.message, sent.reason ?? 'dispatch_failed');
            let state: BotWorldState;
            try {
                state = await this.sdk.waitForCondition(
                    w => (w.modalOpen && !!w.clanStorage) || (w.gameMessages ?? []).slice(messagesBefore).some(m => /clan/i.test(m.text)),
                    Math.max(1000, deadline - Date.now())
                );
            } catch {
                throw new ClanFailure('The clan storage did not open. Is this server running clan storage, and is the bank screen open?', 'timeout');
            }
            if (!state.clanStorage) {
                const reply = (state.gameMessages ?? []).slice(messagesBefore).find(m => /clan/i.test(m.text))?.text ?? 'The clan storage did not open.';
                throw new ClanFailure(reply, /not in a clan/i.test(reply) ? 'not_member' : 'server_rejected');
            }
            return { success: true, message: `${state.clanStorage.clan.name} storage opened.`, state: state.clanStorage, outcome: 'confirmed' };
        });
    }

    async deposit(item: number | string | RegExp, amount: Amount, timeout: number): Promise<ClanStorageResult> {
        return this.run(async () => {
            if (amount !== 'all' && (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_STACK)) throw new ClanFailure('Amount must be a positive whole number or "all".', 'invalid_argument');
            const deadline = Date.now() + timeout;
            const s = this.state();
            const inv = this.sdk.getState()?.inventory ?? [];
            const match = typeof item === 'number' ? inv.find(i => i.id === item) : inv.find(i => (typeof item === 'string' ? i.name.toLowerCase() === item.toLowerCase() : item.test(i.name)));
            if (!match) throw new ClanFailure(`No ${String(item)} in the backpack.`, 'not_found');
            const before = this.inventoryCount(match.id);
            const { op, count } = optionFor(amount);
            let state: ClanStorageState;
            if (count !== undefined) {
                await this.step(() => this.sdk.sendClickComponentWithOption(s.components.sideInv, op, match.slot), c => c.input === 'deposit', deadline);
                state = await this.step(() => this.sdk.sendCountDialog(count), c => c.receipt?.kind === 'deposit', deadline);
            } else state = await this.step(() => this.sdk.sendClickComponentWithOption(s.components.sideInv, op, match.slot), c => c.receipt?.kind === 'deposit', deadline);
            const moved = state.receipt!.count;
            const after = await this.settled(() => this.inventoryCount(match.id), before - moved, deadline);
            if (before - after !== moved) throw new ClanFailure(`Server reported ${moved} deposited but the backpack changed by ${before - after}. Inspect state.`, 'unexpected_delta', true);
            return { success: true, message: `Deposited ${moved} x ${match.name}.`, item: state.receipt!.item, count: moved, state, outcome: 'confirmed' };
        });
    }

    async depositInventory(timeout: number): Promise<ClanStorageResult> {
        return this.run(async () => {
            const deadline = Date.now() + timeout;
            const s = this.state();
            const total = () => (this.sdk.getState()?.inventory ?? []).reduce((n, i) => n + i.count, 0);
            const before = total();
            const state = await this.step(() => this.sdk.sendClickComponent(s.controls.depositInventory), c => c.receipt?.kind === 'depositInventory', deadline);
            const moved = state.receipt!.count;
            const after = await this.settled(total, before - moved, deadline);
            if (before - after !== moved) throw new ClanFailure(`Server reported ${moved} deposited but the backpack changed by ${before - after}. Inspect state.`, 'unexpected_delta', true);
            return { success: true, message: state.notice || `Deposited ${moved} items.`, count: moved, state, outcome: 'confirmed' };
        });
    }

    /**
     * Withdraw by item id or name. Checks canWithdraw from the screen first and refuses
     * locally with the server's reason ('rank', 'cooldown') unless `force` is set.
     */
    async withdraw(item: number | string | RegExp, amount: Amount, options: { noted?: boolean; force?: boolean }, timeout: number): Promise<ClanStorageResult> {
        return this.run(async () => {
            if (amount !== 'all' && (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_STACK)) throw new ClanFailure('Amount must be a positive whole number or "all".', 'invalid_argument');
            const deadline = Date.now() + timeout;
            let s = this.state();
            const find = (st: ClanStorageState): ClanStorageItem | undefined =>
                typeof item === 'number' ? st.items.find(i => i.id === item) : st.items.find(i => (typeof item === 'string' ? i.name.toLowerCase() === item.toLowerCase() : item.test(i.name)));
            const entry = find(s);
            if (!entry) throw new ClanFailure(`The clan storage holds no ${String(item)}.`, 'not_found');
            if (!entry.canWithdraw && !options.force) {
                const why = /^Needs/.test(entry.reason ?? '') ? 'rank' : 'cooldown';
                throw new ClanFailure(`Cannot withdraw ${entry.name}: ${entry.reason}.`, why);
            }
            const noted = !!options.noted;
            if (s.noteMode !== noted) s = await this.step(() => this.sdk.sendClickComponent(s.controls.mode), c => c.noteMode === noted, deadline);
            const target = find(s);
            if (!target) throw new ClanFailure('The storage has changed, try again.', 'stale');
            const ids = new Set((this.sdk.getState()?.inventory ?? []).map(i => i.id));
            const snapshot = new Map([...ids].map(id => [id, this.inventoryCount(id)]));
            const sum = () => {
                const now = this.sdk.getState()?.inventory ?? [];
                let gained = 0;
                const seen = new Map<number, number>();
                for (const i of now) seen.set(i.id, (seen.get(i.id) ?? 0) + i.count);
                for (const [id, n] of seen) gained += n - (snapshot.get(id) ?? 0);
                for (const [id, n] of snapshot) if (!seen.has(id)) gained -= n;
                return gained;
            };
            const { op, count } = optionFor(amount);
            let state: ClanStorageState;
            if (count !== undefined) {
                await this.step(() => this.sdk.sendClickComponentWithOption(s.components.inv, op, target.slot), c => c.input === 'withdraw', deadline);
                state = await this.step(() => this.sdk.sendCountDialog(count), c => c.receipt?.kind === 'withdraw', deadline);
            } else state = await this.step(() => this.sdk.sendClickComponentWithOption(s.components.inv, op, target.slot), c => c.receipt?.kind === 'withdraw', deadline);
            const moved = state.receipt!.count;
            const gained = await this.settled(sum, moved, deadline);
            if (gained !== moved) throw new ClanFailure(`Server reported ${moved} withdrawn but the backpack gained ${gained}. Inspect state.`, 'unexpected_delta', true);
            return { success: true, message: `Withdrew ${moved} x ${target.name}${noted ? ' (noted)' : ''}.`, item: target.id, count: moved, state, outcome: 'confirmed' };
        });
    }

    async close(timeout: number): Promise<ClanStorageResult> {
        return this.run(async () => {
            const s = this.sdk.getClanStorageState();
            if (!s) return { success: true, message: 'Clan storage is not open.', outcome: 'confirmed' };
            const sent = await this.sdk.sendClickComponent(s.controls.close);
            if (!sent.success) throw new ClanFailure(sent.message, sent.reason ?? 'dispatch_failed');
            try {
                await this.sdk.waitForCondition(w => !w.modalOpen || !w.clanStorage, timeout);
            } catch {
                throw new ClanFailure('The clan storage did not close.', 'timeout', true);
            }
            return { success: true, message: 'Clan storage closed.', outcome: 'confirmed' };
        });
    }

    /** Wait (briefly) for a backpack reading to reach the expected value; returns the last reading. */
    private async settled(read: () => number, expected: number, deadline: number): Promise<number> {
        if (read() === expected) return expected;
        try {
            await this.sdk.waitForCondition(() => read() === expected, Math.max(1, Math.min(3000, deadline - Date.now())));
        } catch {
            // report the observed delta
        }
        return read();
    }
}
