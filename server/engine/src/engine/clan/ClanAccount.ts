import InvType from '#/cache/config/InvType.js';
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import type { ClanAccount } from './ClanStore.js';

export const backpack = (p: Player) => p.getInventory(InvType.getId('inv'))!;

/** The actor's real backpack, with the GE's world-wide save checkpoint as the commit point. */
export function playerAccount(p: Player): ClanAccount {
    const inv = backpack(p);
    const before = inv.items.map(i => (i ? { ...i } : null));
    return {
        owner: p.username,
        count: id => inv.getItemCount(id),
        take: (id, n) => inv.remove(id, n),
        give: (id, n) => inv.add(id, n),
        contents: () => inv.itemsFiltered.map(i => ({ id: i.id, count: inv.getItemCount(i.id) })),
        save: () => {
            const save = p.save(false);
            World.checkpointPlayers(p, save);
        },
        rollback: () => before.forEach((item, i) => inv.set(i, item))
    };
}
