import type Player from '#/engine/entity/Player.js';
import { clanTick as storageTick } from './ClanStorage.js';
import { clanTabTick } from './ClanTab.js';

/**
 * The only clan entry points upstream files call (one delegation line each, see
 * docs/plans/clan-storage.md section 12). Each returns false when the event is not ours.
 */
export { clanButton, clanCount, clanInvButton } from './ClanStorage.js';
export { clanPublicChat } from './ClanChat.js';

/** Per-player world tick: storage screen refresh, bank button, clan tab and presence. */
export function clanTick(p: Player): void {
    storageTick(p);
    clanTabTick(p);
}
