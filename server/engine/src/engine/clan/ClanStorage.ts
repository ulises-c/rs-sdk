import Component from '#/cache/config/Component.js';
import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';
import { CoordGrid } from '#/engine/CoordGrid.js';
import { Inventory } from '#/engine/Inventory.js';
import type Player from '#/engine/entity/Player.js';
import ScriptProvider from '#/engine/script/ScriptProvider.js';
import ScriptRunner from '#/engine/script/ScriptRunner.js';
import IfSetHide from '#/network/game/server/model/IfSetHide.js';
import IfSetText from '#/network/game/server/model/IfSetText.js';
import PCountDialog from '#/network/game/server/model/PCountDialog.js';
import UpdateInvFull from '#/network/game/server/model/UpdateInvFull.js';
import { LoggerEventType } from '#/server/logger/LoggerEventType.js';
import Environment from '#/util/Environment.js';
import type { ClanStorageState } from '../../../../../sdk/clan-types.js';
import { rankName } from './ClanRanks.js';
import { backpack, playerAccount } from './ClanAccount.js';
import { clanStorageEnabled, clanStore } from './ClanLedger.js';
import { ClanError, MAX_STACK, type ClanContext, type ClanView } from './ClanStore.js';

/** Hidden JSON state component for bots (reserved client code block 30460+, after the GE's 30400-30451). */
export const CLAN_STATE_CLIENTCODE = 30460;
/** Bots can't read more than one var-short IF_SETTEXT; stay well below 65535 bytes. */
const MAX_STATE_BYTES = 60_000;

type Input = { kind: 'withdraw' | 'deposit'; item: number; obj: number; slot: number };
type Session = {
    serial: number;
    revision: number;
    actionRevision: number;
    storeRevision: number;
    clanId: number;
    rows: number[];
    noted: boolean;
    input?: Input;
    notice: string;
    error: string | null;
    errorReason: string | null;
    receipt: ClanStorageState['receipt'];
};
const sessions = new WeakMap<Player, Session>();
/** Per-player memory of the bank screen's clan button, resent on every bank open. */
const bankButtonSent = new WeakMap<Player, boolean>();
let nextSession = 0;
let nextReceipt = 0;

const com = (name: string) => Component.getId(`clan_storage:${name}`);
const root = () => Component.getId('clan_storage');
const sideRoot = () => Component.getId('clan_storage_side');
const sideInv = () => Component.getId('clan_storage_side:inv');
const bankRoot = () => Component.getId('bank_main');
const bankButton = () => Component.getId('bank_main:clan_storage');

function ctx(p: Player): ClanContext {
    return { world: Environment.NODE_ID, coord: CoordGrid.packCoord(p.level, p.x, p.z) };
}
function text(p: Player, name: string, value: string) {
    const id = com(name);
    if (id >= 0) p.write(new IfSetText(id, value));
}
function message(error: unknown): string {
    if (error instanceof ClanError) return error.message;
    console.error('[clan] storage error', error);
    return 'The clan storage is unavailable right now.';
}

// ------------------------------------------------------------------ bank screen button

function setBankButton(p: Player, visible: boolean) {
    const id = bankButton();
    if (id >= 0) p.write(new IfSetHide(id, !visible));
}

/** Show the bank screen's "Clan storage" button to members only, each time the bank opens. */
function tickBankButton(p: Player) {
    if (p.modalMain !== bankRoot()) {
        bankButtonSent.delete(p);
        return;
    }
    if (bankButtonSent.get(p)) return;
    bankButtonSent.set(p, true);
    let member = false;
    try {
        member = !!clanStore().member(p.username);
    } catch (error) {
        console.error('[clan] membership lookup failed', error);
    }
    setBankButton(p, member);
}

// ------------------------------------------------------------------ session

export function openClanStorage(p: Player): boolean {
    if (!clanStorageEnabled()) {
        p.messageGame('Clan storage is not available on this server.');
        return false;
    }
    let view: ClanView;
    try {
        view = clanStore().view(p.username);
    } catch (error) {
        p.messageGame(message(error));
        setBankButton(p, false);
        return false;
    }
    p.closeModal();
    sessions.set(p, { serial: ++nextSession, revision: 0, actionRevision: 0, storeRevision: -1, clanId: view.clan.id, rows: [], noted: false, notice: '', error: null, errorReason: null, receipt: null });
    p.invListenOnCom(InvType.getId('inv'), sideInv(), p.uid);
    p.openMainSideModal(root(), sideRoot());
    render(p, view);
    return true;
}

function active(p: Player): Session | undefined {
    const s = sessions.get(p);
    if (!s) return;
    if (!clanStorageEnabled() || p.modalMain !== root() || p.loggingOut) {
        sessions.delete(p);
        if (p.modalMain === root()) p.closeModal();
        return;
    }
    return s;
}

function render(p: Player, view?: ClanView) {
    const s = sessions.get(p);
    if (!s) return;
    let v: ClanView;
    try {
        v = view ?? clanStore().view(p.username);
    } catch (error) {
        // Kicked, or the clan was disbanded, while the screen was open.
        p.messageGame(message(error));
        sessions.delete(p);
        p.closeModal();
        return;
    }
    s.clanId = v.clan.id;
    s.storeRevision = v.revision;
    s.rows = v.items.map(i => i.id);
    const display = new Inventory(-1, Math.max(1, v.capacity.max));
    v.items.forEach((item, slot) => display.set(slot, { id: item.id, count: item.count }));
    p.write(new UpdateInvFull(com('inv'), display));
    text(p, 'title', `${v.clan.name} storage`);
    text(p, 'capacity', `${v.capacity.used} / ${v.capacity.max}`);
    text(p, 'rank', `Your rank: ${rankName(v.rank)}${v.effectiveRank < v.rank ? ` (acting ${rankName(v.effectiveRank)})` : ''}`);
    text(p, 'mode', `Withdraw as: ${s.noted ? 'Note' : 'Item'}`);
    const store = clanStore();
    const status = v.cooldowns.newMember
        ? `New member: withdrawals in ${store.wait(v.cooldowns.newMember)}`
        : v.cooldowns.promotion
          ? `Promotion applies in ${store.wait(v.cooldowns.promotion)}`
          : (() => {
                const cd = v.items.filter(i => i.cooldownUntil).sort((a, b) => a.cooldownUntil! - b.cooldownUntil!)[0];
                return cd ? `You can withdraw ${cd.name} again in ${store.wait(cd.cooldownUntil!)}` : v.canDeposit ? '' : 'Your rank cannot deposit.';
            })();
    text(p, 'status', status);
    publish(p, v);
}

function publish(p: Player, v: ClanView) {
    const s = sessions.get(p)!;
    const state: ClanStorageState = {
        isOpen: true,
        session: s.serial,
        revision: ++s.revision,
        actionRevision: s.actionRevision,
        storeRevision: v.revision,
        serverTime: clanStore().now(),
        clan: v.clan,
        rank: v.rank,
        rankName: rankName(v.rank),
        effectiveRank: v.effectiveRank,
        canDeposit: v.canDeposit,
        capacity: v.capacity,
        noteMode: s.noted,
        items: v.items.map(i => ({ slot: i.slot, id: i.id, name: i.name, count: i.count, minRank: i.minRank, canWithdraw: i.canWithdraw, cooldownUntil: i.cooldownUntil, reason: i.reason })),
        cooldowns: v.cooldowns,
        controls: { close: com('close'), bank: com('bank'), mode: com('mode'), depositInventory: com('deposit_inv') },
        components: { inv: com('inv'), sideInv: sideInv() },
        input: s.input?.kind ?? null,
        notice: s.notice,
        error: s.error,
        errorReason: s.errorReason,
        receipt: s.receipt
    };
    let json = JSON.stringify(state);
    if (json.length > MAX_STATE_BYTES) {
        // Very large stores: drop names first, then trailing items (flagged so bots know).
        state.items = state.items.map(i => ({ ...i, name: '' }));
        json = JSON.stringify(state);
        while (json.length > MAX_STATE_BYTES && state.items.length) {
            state.items = state.items.slice(0, Math.floor(state.items.length * 0.9));
            state.truncated = true;
            json = JSON.stringify(state);
        }
    }
    text(p, 'agent_state', json);
}

function begin(s: Session) {
    s.actionRevision++;
    s.error = null;
    s.errorReason = null;
    s.notice = '';
    s.receipt = null;
}
function fail(p: Player, s: Session, action: string, error: unknown, item?: number) {
    s.error = message(error);
    s.errorReason = error instanceof ClanError ? error.reason : 'error';
    p.messageGame(s.error);
    try {
        clanStore().refused(p.username, action, error, item, ctx(p));
    } catch {
        // auditing never blocks the reply
    }
    render(p);
}

function deposit(p: Player, s: Session, obj: number, n: number) {
    try {
        const r = clanStore().deposit(playerAccount(p), obj, n, ctx(p));
        p.addSessionLog(LoggerEventType.MODERATOR, `Deposited ${ObjType.get(r.item)?.debugname ?? r.item} x${r.count} into clan storage`);
        s.receipt = { token: ++nextReceipt, kind: 'deposit', item: r.item, count: r.count };
        s.notice = `Deposited ${r.count.toLocaleString('en-US')} x ${ObjType.get(r.item)?.name ?? 'item'}.`;
        render(p);
    } catch (error) {
        fail(p, s, 'deposit', error, obj);
    }
}
function withdraw(p: Player, s: Session, item: number, n: number) {
    try {
        const r = clanStore().withdraw(playerAccount(p), item, n, s.noted, ctx(p));
        p.addSessionLog(LoggerEventType.MODERATOR, `Withdrew ${ObjType.get(item)?.debugname ?? item} x${r.given} from clan storage`);
        s.receipt = { token: ++nextReceipt, kind: 'withdraw', item, count: r.given };
        s.notice = r.given < n && n !== MAX_STACK ? `Withdrew ${r.given.toLocaleString('en-US')} (not enough room or stock for ${n.toLocaleString('en-US')}).` : `Withdrew ${r.given.toLocaleString('en-US')} x ${ObjType.get(item)?.name ?? 'item'}.`;
        if (s.noted && r.givenId === item && ObjType.get(item)?.stackable === false) p.messageGame('This item cannot be withdrawn as a note.');
        render(p);
    } catch (error) {
        fail(p, s, 'withdraw', error, item);
    }
}

const AMOUNTS = [1, 5, 10, MAX_STACK, 0];

/** INV_BUTTON on the storage grid or the storage backpack. Delegated from InvButtonHandler. */
export function clanInvButton(p: Player, component: number, slot: number, obj: number, op: number): boolean {
    if (component !== com('inv') && component !== sideInv()) return false;
    const s = active(p);
    if (!s || op < 1 || op > 5) return true;
    begin(s);
    if (s.input) s.input = undefined;
    const amount = AMOUNTS[op - 1];
    if (component === sideInv()) {
        if (!backpack(p).hasAt(slot, obj)) return true;
        if (!amount) {
            s.input = { kind: 'deposit', item: obj, obj, slot };
            p.write(new PCountDialog());
            publish(p, clanStore().view(p.username));
            return true;
        }
        deposit(p, s, obj, amount);
        return true;
    }
    // Map the clicked slot to the item at the viewer's revision; never act on a different item.
    if (s.rows[slot] !== obj) {
        fail(p, s, 'withdraw', new ClanError('The storage has changed, try again.', 'stale'), obj);
        return true;
    }
    if (!amount) {
        s.input = { kind: 'withdraw', item: obj, obj, slot };
        p.write(new PCountDialog());
        publish(p, clanStore().view(p.username));
        return true;
    }
    withdraw(p, s, obj, amount);
    return true;
}

/** RESUME_P_COUNTDIALOG for Withdraw-X / Deposit-X. Delegated from ResumePCountDialogHandler. */
export function clanCount(p: Player, value: number): boolean {
    const s = active(p);
    if (!s?.input) return false;
    const input = s.input;
    begin(s);
    s.input = undefined;
    if (!Number.isInteger(value) || value <= 0) {
        render(p);
        return true;
    }
    if (input.kind === 'deposit') {
        if (!backpack(p).hasAt(input.slot, input.obj) && backpack(p).getItemCount(input.obj) === 0) {
            fail(p, s, 'deposit', new ClanError("You don't have that item.", 'empty'), input.obj);
            return true;
        }
        deposit(p, s, input.obj, value);
    } else withdraw(p, s, input.item, value);
    return true;
}

/** IF_BUTTON on the bank screen's clan button or the storage screen. Delegated from IfButtonHandler. */
export function clanButton(p: Player, id: number): boolean {
    if (id >= 0 && id === bankButton()) {
        if (p.modalMain === bankRoot()) openClanStorage(p);
        return true;
    }
    if (Component.get(id)?.rootLayer !== root()) return false;
    const s = active(p);
    if (!s) return true;
    begin(s);
    s.input = undefined;
    if (id === com('close')) {
        sessions.delete(p);
        p.closeModal();
        return true;
    }
    if (id === com('bank')) {
        sessions.delete(p);
        p.closeModal();
        const script = ScriptProvider.getByName('[label,openbank]');
        if (script) p.executeScript(ScriptRunner.init(script, p), true);
        return true;
    }
    if (id === com('mode')) {
        s.noted = !s.noted;
        render(p);
        return true;
    }
    if (id === com('deposit_inv')) {
        try {
            const r = clanStore().depositInventory(playerAccount(p), ctx(p));
            const count = r.moved.reduce((n, m) => n + m.count, 0);
            p.addSessionLog(LoggerEventType.MODERATOR, `Deposited inventory into clan storage: ${r.moved.map(m => `${ObjType.get(m.item)?.debugname ?? m.item} x${m.count}`).join(', ')}`);
            s.receipt = { token: ++nextReceipt, kind: 'depositInventory', count, kinds: r.moved.length, skipped: r.skipped.length };
            s.notice = r.skipped.length ? `Deposited ${count.toLocaleString('en-US')} items; ${r.skipped.length} kind(s) can't go into clan storage.` : `Deposited ${count.toLocaleString('en-US')} items.`;
            if (r.skipped.length) p.messageGame(s.notice);
            render(p);
        } catch (error) {
            fail(p, s, 'depositInventory', error);
        }
        return true;
    }
    render(p);
    return true;
}

/** World tick: push store changes to every open viewer and keep the bank button in step. */
export function clanTick(p: Player): void {
    if (!clanStorageEnabled()) return;
    tickBankButton(p);
    const s = sessions.get(p);
    if (!s) return;
    if (!active(p) || s.input) return;
    let revision: number;
    try {
        revision = clanStore().revision(s.clanId);
        const member = clanStore().member(p.username);
        if (!member || member.clan_id !== s.clanId) revision = -2;
    } catch (error) {
        console.error('[clan] tick failed', error);
        return;
    }
    if (revision !== s.storeRevision) render(p);
}
