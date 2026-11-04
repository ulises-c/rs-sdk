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
    /**
     * `item` / `note` select the withdraw mode (bank-style select boxes); `mode` is the Note box,
     * kept for SDKs that predate the two boxes.
     */
    controls: { close: number; bank: number; mode: number; item?: number; note?: number; depositInventory: number };
    /** INV_BUTTON components: the storage grid (withdraw) and the storage backpack (deposit). */
    components: { inv: number; sideInv: number };
    /** A Withdraw-X / Deposit-X count dialog is waiting. */
    input: 'withdraw' | 'deposit' | null;
    notice: string;
    error: string | null;
    /** Machine-readable refusal: rank, cooldown, full, capacity, not_storable, empty, stale, not_member, ... */
    errorReason: string | null;
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

/** One clan member as the clan side tab lists them (online first, then by rank). */
export interface ClanTabMember {
    name: string;
    rank: number;
    rankName: string;
    /** Logged in on this world (the roster is per world; other worlds are not seen). */
    online: boolean;
}
/** The clan side tab (sidebar slot 7), present while the player is in a clan and clan chat is on. */
export interface ClanTabState {
    /** Advances whenever the server re-renders the tab for this clan. */
    seq: number;
    clan: { id: number; name: string };
    memberCount: number;
    onlineCount: number;
    members: ClanTabMember[];
}
/** A clan chat line, parsed from the game message `[Clan name] Sender: text`. */
export interface ClanChatMessage {
    clan: string;
    sender: string;
    text: string;
    tick: number;
}

// Module augmentation instead of an edit to sdk/types.ts (upstream footprint, clan-storage.md section 12).
declare module './types' {
    interface BotWorldState {
        /** Null outside the clan storage screen; absent on older clients and servers without clans. */
        clanStorage?: ClanStorageState | null;
        /** The clan side tab; null when not in a clan (or the server has no clan chat). */
        clan?: ClanTabState | null;
    }
}
