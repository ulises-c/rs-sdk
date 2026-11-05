import type { ClanTabState } from '../../../../sdk/clan-types.js';
// Module augmentation instead of an edit to bot/types.ts (upstream footprint, clan-storage.md section 12).
declare module './types.js' {
    interface BotState {
        /** The clan side tab (sidebar slot 7); null when not in a clan. */
        clan?: ClanTabState | null;
    }
}
interface Component {
    clientCode: number;
    text: string | null;
    children: number[] | null;
}
/** Hidden JSON state component of the clan side tab (engine ClanTab.ts). */
export const CLAN_TAB_CLIENTCODE = 30461;
/** Reads the server's roster snapshot from the interface in sidebar slot 7 (`root` = its id, -1 = none). */
export function collectClanTabState(list: Component[], root: number): ClanTabState | null {
    if (root < 0) return null;
    const scan = (id: number, depth = 0): ClanTabState | null => {
        const c = list[id];
        if (!c || depth > 6) return null;
        if (c.clientCode === CLAN_TAB_CLIENTCODE) {
            try {
                const s = JSON.parse(c.text ?? '') as ClanTabState;
                return Number.isSafeInteger(s.seq) && s.clan && Array.isArray(s.members) ? s : null;
            } catch {
                return null;
            }
        }
        for (const child of c.children ?? []) {
            const state = scan(child, depth + 1);
            if (state) return state;
        }
        return null;
    };
    return scan(root);
}
