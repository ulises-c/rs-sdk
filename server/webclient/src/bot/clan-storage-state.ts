import type { ClanStorageState } from '../../../../sdk/clan-types.js';
// Module augmentation instead of an edit to bot/types.ts (upstream footprint, clan-storage.md section 12).
declare module './types.js' {
    interface BotState {
        /** Null outside the clan storage screen. */
        clanStorage?: ClanStorageState | null;
    }
}
interface Component {
    clientCode: number;
    text: string | null;
    children: number[] | null;
}
/** Hidden JSON state component of the clan storage screen (engine ClanStorage.ts). */
export const CLAN_STORAGE_CLIENTCODE = 30460;
/** Reads the server's atomic snapshot; never reconstructs storage contents from the item grid. */
export function collectClanStorageState(list: Component[], root: number): ClanStorageState | null {
    if (root < 0) return null;
    const scan = (id: number, depth = 0): ClanStorageState | null => {
        const c = list[id];
        if (!c || depth > 12) return null;
        if (c.clientCode === CLAN_STORAGE_CLIENTCODE) {
            try {
                const s = JSON.parse(c.text ?? '') as ClanStorageState;
                return s.isOpen === true &&
                    Number.isSafeInteger(s.session) &&
                    Number.isSafeInteger(s.revision) &&
                    Number.isSafeInteger(s.actionRevision) &&
                    Array.isArray(s.items) &&
                    s.controls &&
                    s.components
                    ? s
                    : null;
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
