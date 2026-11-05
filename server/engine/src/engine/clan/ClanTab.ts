import Component from '#/cache/config/Component.js';
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import IfSetText from '#/network/game/server/model/IfSetText.js';
import { clanChatEnabled, clanStore } from './ClanLedger.js';
import { clanTabContent, clanTabHelp } from './ClanTabContent.js';

/**
 * The clan side tab (sidebar slot 7, the empty bottom-left slot of this revision; login.rs2 sets
 * 0-6 and 8-13) and the online roster behind it. Its icon is painted into the sidebar background
 * (content/sprites/back.png), so with the feature on every player gets the tab: members see the
 * roster, everyone else a short how-to (clanTabHelp). Event-driven: a member's arrival or departure,
 * and any /clan command that can change a roster, marks that clan dirty; only dirty clans are read
 * from the ledger and re-rendered (once, for all their online members). Nothing is polled per tick
 * except an in-memory presence check.
 */
export const CLAN_TAB = 7;
export { CLAN_TAB_CLIENTCODE, CLAN_TAB_ROWS, clanTabContent, clanTabHelp } from './ClanTabContent.js';

type Presence = { player: Player; clanId: number | null };
const presence = new Map<string, Presence>();
const dirty = new Set<number>();
const shown = new WeakMap<Player, string>();
const serial = new Map<number, number>();
let lastSweep = -1;

const root = () => Component.getId('clan_tab');
const com = (name: string) => Component.getId(`clan_tab:${name}`);

/** Online members of a clan on this world (presence is the authority; no ledger read). */
export function onlineMembers(clanId: number): Player[] {
    const out: Player[] = [];
    for (const p of presence.values()) if (p.clanId === clanId) out.push(p.player);
    return out;
}

/** Tells every online member of a clan (except one) a game message. */
export function tellOnline(clanId: number, line: string, except?: string): void {
    for (const p of onlineMembers(clanId)) if (p.username !== except) p.messageGame(line);
}

function clear(p: Player) {
    shown.delete(p);
    if (root() >= 0 && p.tabs[CLAN_TAB] === root()) p.setTab(-1, CLAN_TAB);
}

const HELP = 'help';
/** The not-in-a-clan view (feature on, player outside any clan). */
function help(p: Player) {
    if (root() < 0) return;
    if (p.tabs[CLAN_TAB] !== root()) p.setTab(root(), CLAN_TAB);
    if (shown.get(p) === HELP) return;
    shown.set(p, HELP);
    for (const [name, value] of Object.entries(clanTabHelp())) p.write(new IfSetText(com(name), value));
}

/** Ordinary side tabs are up (login.rs2 has run, no cutscene/tutorial tab reset in progress). */
const tabsUp = (p: Player) => p.tabs[3] !== -1;

function notice(clanId: number, who: string, text: string, except: string) {
    try {
        const clan = clanStore().clan(clanId);
        if (clan?.settings.notices) tellOnline(clanId, `[${clan.display}] ${who} ${text}`, except);
    } catch (error) {
        console.error('[clan] notice failed', error);
    }
}

/** Departures (logout, relog with a new Player object) since the last tick. */
function sweep() {
    const live = new Set<Player>(World.playerLoop.all());
    for (const [name, p] of presence) {
        if (live.has(p.player)) continue;
        presence.delete(name);
        if (p.clanId !== null) {
            dirty.add(p.clanId);
            notice(p.clanId, p.player.displayName, 'has logged out.', name);
        }
    }
}

function arrive(p: Player) {
    let clanId: number | null = null;
    try {
        clanId = clanStore().member(p.username)?.clan_id ?? null;
    } catch (error) {
        console.error('[clan] membership lookup failed', error);
    }
    presence.set(p.username, { player: p, clanId });
    if (clanId !== null) {
        dirty.add(clanId);
        notice(clanId, p.displayName, 'has logged in.', p.username);
    }
}

/**
 * Re-reads the membership of every online player after a /clan command (commands are rare;
 * a kick, accept or disband changes someone other than the speaker). `touched` are clans whose
 * ranks or names may have changed without a membership change.
 */
export function clanRosterChanged(touched: (number | null | undefined)[] = []): void {
    if (!clanChatEnabled()) return;
    for (const id of touched) if (typeof id === 'number') dirty.add(id);
    let store;
    try {
        store = clanStore();
    } catch {
        return;
    }
    for (const p of presence.values()) {
        const now = store.member(p.player.username)?.clan_id ?? null;
        if (now === p.clanId) continue;
        if (p.clanId !== null) dirty.add(p.clanId);
        if (now !== null) dirty.add(now);
        else if (tabsUp(p.player)) help(p.player);
        else clear(p.player);
        p.clanId = now;
    }
}

function render(clanId: number) {
    const store = clanStore();
    const clan = store.clan(clanId);
    const viewers = onlineMembers(clanId);
    if (!clan) {
        for (const p of viewers) help(p);
        return;
    }
    const online = new Map(viewers.map(p => [p.username, p]));
    const seq = (serial.get(clanId) ?? 0) + 1;
    serial.set(clanId, seq);
    const content = clanTabContent(clan, store.members(clanId), online, seq);
    const { state, ...texts } = content;
    const signature = JSON.stringify({ ...texts, members: state.members });
    for (const p of viewers) {
        if (root() < 0) return;
        if (p.tabs[CLAN_TAB] !== root()) p.setTab(root(), CLAN_TAB);
        if (shown.get(p) === signature) continue;
        shown.set(p, signature);
        for (const [name, value] of Object.entries(texts)) p.write(new IfSetText(com(name), value));
        p.write(new IfSetText(com('agent_state'), JSON.stringify(state)));
    }
}

/** Per-player tick (delegated through ClanHooks.clanTick): presence, tab ownership, dirty clans. */
export function clanTabTick(p: Player): void {
    if (!clanChatEnabled()) {
        if (shown.has(p) || (root() >= 0 && p.tabs[CLAN_TAB] === root())) clear(p);
        return;
    }
    if (World.currentTick !== lastSweep) {
        lastSweep = World.currentTick;
        sweep();
    }
    const cur = presence.get(p.username);
    if (!cur || cur.player !== p) arrive(p);
    else if (cur.clanId !== null && p.tabs[CLAN_TAB] === -1 && tabsUp(p)) {
        // A script reset the side tabs (e.g. a cutscene, then initalltabs): put the clan tab back.
        p.setTab(root(), CLAN_TAB);
    }
    const now = presence.get(p.username);
    if (now && now.player === p && now.clanId === null && tabsUp(p) && (p.tabs[CLAN_TAB] !== root() || shown.get(p) !== HELP)) help(p);
    if (!dirty.size) return;
    const ids = [...dirty];
    dirty.clear();
    for (const id of ids) {
        try {
            render(id);
        } catch (error) {
            console.error('[clan] tab render failed', error);
        }
    }
}

/** Tests only. */
export function resetClanTab(): void {
    presence.clear();
    dirty.clear();
    serial.clear();
    lastSweep = -1;
}
