/** Clan storage observations, delivered only through an open in-game storage screen. */
export interface ClanStorageItem {
    /** Display slot (stable first-deposit order); withdraw clicks carry slot + item id. */
    slot: number;
    /** Unnoted item id: the store holds real items, notes deposit as their item. */
    id: number;
    /** Empty only when a very large store had to drop names to fit the state component. */
    name: string;
    count: number;
    /** Rank value needed to withdraw this item (1 Recruit .. 9 Owner). */
    minRank: number;
    /** Whether this member may withdraw it right now (rank, new-member and item cooldowns). */
    canWithdraw: boolean;
    /** Server epoch ms when this member's item cooldown ends, or null. */
    cooldownUntil: number | null;
    /** Why canWithdraw is false, e.g. "Needs Captain", "New member", "Cooldown". */
    reason: string | null;
}
export interface ClanStorageState {
    isOpen: true;
    session: number;
    /** Advances with every published snapshot. */
    revision: number;
    /** Advances for handled client commands, never for passive updates. */
    actionRevision: number;
    /** The clan store's own revision (shared by every viewer of this clan). */
    storeRevision: number;
    /** Server clock (epoch ms) when this snapshot was made, for cooldown arithmetic. */
    serverTime: number;
    clan: { id: number; name: string };
    rank: number;
    rankName: string;
    /** Lower than rank while a promotion cooldown runs. */
    effectiveRank: number;
    canDeposit: boolean;
    capacity: { used: number; max: number };
    /** Withdraw as notes when true. */
    noteMode: boolean;
    items: ClanStorageItem[];
    /** Server epoch ms when each cooldown ends, or null. */
    cooldowns: { newMember: number | null; promotion: number | null };
    /** Named component ids, dispatched through the ordinary IF_BUTTON handler. */
    controls: { close: number; bank: number; mode: number; depositInventory: number };
    /** INV_BUTTON components: the storage grid (withdraw) and the storage backpack (deposit). */
    components: { inv: number; sideInv: number };
    /** A Withdraw-X / Deposit-X count dialog is waiting. */
    input: 'withdraw' | 'deposit' | null;
    notice: string;
    error: string | null;
    receipt: {
        token: number;
        kind: 'deposit' | 'withdraw' | 'depositInventory';
        item?: number;
        count: number;
        kinds?: number;
        skipped?: number;
    } | null;
    /** Set when items were cut to fit the state component. */
    truncated?: boolean;
}
export type ClanStorageReason =
    | 'not_member'
    | 'rank'
    | 'cooldown'
    | 'full'
    | 'capacity'
    | 'not_storable'
    | 'empty'
    | 'stale'
    | 'no_interface'
    | 'no_bank'
    | 'not_found'
    | 'invalid_argument'
    | 'timeout'
    | 'session_changed'
    | 'server_rejected'
    | 'busy'
    | 'stale_state'
    | 'dispatch_failed';
export interface ClanStorageResult {
    success: boolean;
    message: string;
    reason?: ClanStorageReason | string;
    /** An observation timeout after a send may have applied the action: inspect state before retrying. */
    outcome?: 'confirmed' | 'unknown';
    /** Item id and units that actually moved (backpack delta, verified). */
    item?: number;
    count?: number;
    state?: ClanStorageState;
}
