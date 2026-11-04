import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import ObjType from '#/cache/config/ObjType.js';
import ParamType from '#/cache/config/ParamType.js';
import { ParamHelper } from '#/cache/config/ParamHelper.js';
import { playerSaveStore } from '#/engine/market/MarketStore.js';
import Environment from '#/util/Environment.js';
import { tryParseBoolean } from '#/util/TryParse.js';
import { ClanError, ClanStore, type ClanItems } from './ClanStore.js';

// No World import here: the hiscore pages (also served by the standalone hiscores process) use this module.

/** Feature flags are read here, not in Environment.ts (upstream footprint rule). Off = upstream behaviour. */
export const clanStorageEnabled = () => tryParseBoolean(process.env.CLAN_STORAGE_ENABLED, false);
export const clanHiscoresEnabled = () => tryParseBoolean(process.env.CLAN_HISCORES_ENABLED, false);
const intEnv = (name: string, fallback: number) => {
    const n = Number(process.env[name]);
    return Number.isInteger(n) && n > 0 ? n : fallback;
};

/** Item rules from the packed configs: tradeable, not dummy, notes map to their real item, bank refusals kept. */
export const objItems: ClanItems = {
    canonical(id) {
        const obj = ObjType.get(id);
        const real = obj && obj.certtemplate !== -1 ? obj.certlink : id;
        const item = real >= 0 ? ObjType.get(real) : undefined;
        if (!item?.name || !item.tradeable || item.dummyitem !== 0) throw new ClanError("That item can't go into the clan storage.", 'not_storable');
        const unbankable = ParamType.getId('unbankable');
        if (unbankable !== -1 && ParamHelper.getIntParam(unbankable, item, 0) === 1) throw new ClanError("That item can't go into the clan storage.", 'not_storable');
        return item.id;
    },
    noted(id) {
        const obj = ObjType.get(id);
        if (!obj || obj.certlink === -1 || obj.certtemplate !== -1) return id;
        return obj.certlink;
    },
    name: id => ObjType.get(id)?.name ?? `Item ${id}`,
    value: id => Math.max(0, ObjType.get(id)?.cost ?? 0),
    coins: () => ObjType.getId('coins')
};

let store: ClanStore | undefined;
/**
 * The clan tables live in the GE ledger (market.sqlite): one SQLite handle, so a deposit or
 * withdrawal commits the storage change and the player save checkpoint in one transaction.
 */
export function clanStore(): ClanStore {
    if (store) return store;
    let ledger = playerSaveStore();
    if (!ledger) {
        // GE disabled and never used: create the ledger file so checkpoints and clan rows share it.
        const path = process.env.GE_DATABASE ?? 'data/market.sqlite';
        mkdirSync(dirname(path), { recursive: true });
        if (!existsSync(path)) new Database(path, { create: true }).close();
        ledger = playerSaveStore();
    }
    if (!ledger) throw new ClanError('Clan storage is not available on this server.', 'disabled');
    store = new ClanStore(ledger.db, objItems, { capacity: intEnv('CLAN_STORAGE_SIZE', 800), maxMembers: intEnv('CLAN_MAX_MEMBERS', 500), world: Environment.NODE_ID });
    return store;
}
/** Tests only: drop the cached store (a new ledger path takes effect on next use). */
export function resetClanStore() {
    store = undefined;
}
