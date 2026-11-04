import type { Database } from 'bun:sqlite';
import { parseRank, RANK, rankName } from './ClanRanks.js';

export const MAX_STACK = 2_147_483_647;
const HOUR = 3_600_000;
export const INVITE_TTL_MS = 10 * 60_000;
export const REJOIN_MS = 24 * HOUR;
export const MANAGEMENT_PER_HOUR = 20;

export type ClanReason =
    | 'disabled'
    | 'not_member'
    | 'already_member'
    | 'permission'
    | 'rank'
    | 'cooldown'
    | 'full'
    | 'capacity'
    | 'not_storable'
    | 'empty'
    | 'stale'
    | 'invalid'
    | 'name_taken'
    | 'not_found'
    | 'rate_limit'
    | 'no_invite';

export class ClanError extends Error {
    constructor(
        message: string,
        readonly reason: ClanReason
    ) {
        super(message);
    }
}

export type ClanSettings = {
    minDeposit: number;
    minWithdraw: number;
    minInvite: number;
    newMemberHours: number;
    promotionHours: number;
    hiscores: boolean;
    showMembers: boolean;
    showBankValues: boolean;
    showStorage: boolean;
};
export const DEFAULT_SETTINGS: ClanSettings = {
    minDeposit: RANK.recruit,
    minWithdraw: RANK.sergeant,
    minInvite: RANK.admin,
    newMemberHours: 24,
    promotionHours: 12,
    hiscores: true,
    showMembers: true,
    showBankValues: true,
    showStorage: false
};
/** Settings only the Owner or Deputy owner may change (clan-hiscores.md section 7). */
const PRIVACY_SETTINGS = new Set(['hiscores', 'showMembers', 'showBankValues', 'showStorage']);

export type Clan = { id: number; name: string; display: string; owner: string; created: number; home_world: number; settings: ClanSettings; revision: number };
export type ClanMember = { owner: string; clan_id: number; rank: number; prev_rank: number; joined: number; rank_since: number; invited_by: string | null; trusted: number };
export type ClanItemRow = { item: number; count: number; seq: number };
export type ClanAccessRule = { item: number; min_rank: number; cooldown_s: number };
export type ClanLogRow = { id: number; clan_id: number; at: number; actor: string; action: string; item: number | null; count: number | null; world: number | null; coord: number | null; revision: number | null; detail: string | null };

/** Item knowledge the store needs; production reads ObjType, unit tests use a table. */
export interface ClanItems {
    /** Unnoted item id for a storable item (notes map to their real item); throws ClanError('not_storable'). */
    canonical(id: number): number;
    /** The note id for a real item, or the item itself when it has no note. */
    noted(id: number): number;
    name(id: number): string;
    /** Value per unit, as the Bank hiscore board values items (ObjType.cost). */
    value(id: number): number;
    coins(): number;
}

/** The actor's backpack. Writes happen inside the ledger transaction; rollback restores it on failure. */
export interface ClanAccount {
    owner: string;
    /** Units of exactly this obj id (noted and unnoted are different ids). */
    count(id: number): number;
    /** Remove up to n units of exactly this id; returns the number removed. */
    take(id: number, n: number): number;
    /** Add up to n units; returns the number actually added (space and stack limits). */
    give(id: number, n: number): number;
    /** Every obj id in the backpack with its total count, in slot order. */
    contents(): { id: number; count: number }[];
    /** Commit the actor's full save checkpoint (production: World.checkpointPlayers). */
    save(): void;
    rollback(): void;
}

export type ClanContext = { world?: number; coord?: number };

export type ClanViewItem = { slot: number; id: number; name: string; count: number; minRank: number; cooldownS: number; canWithdraw: boolean; cooldownUntil: number | null; reason: string | null };
export type ClanView = {
    clan: { id: number; name: string };
    revision: number;
    rank: number;
    effectiveRank: number;
    canDeposit: boolean;
    capacity: { used: number; max: number };
    items: ClanViewItem[];
    cooldowns: { newMember: number | null; promotion: number | null };
};

export type ClanStoreOptions = { now?: () => number; capacity?: number; maxMembers?: number; world?: number };

function normalizeName(text: string): string {
    return text.trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
}
export function displayName(name: string): string {
    return name.replace(/\b[a-z]/g, c => c.toUpperCase());
}
/** Login names are stored as the engine's safe name (lowercase, underscores). */
export function safeName(text: string): string {
    return text.trim().toLowerCase().replace(/\s+/g, '_');
}

/**
 * Clan ledger on the GE's market.sqlite handle. Single world process, synchronous:
 * every write is one immediate transaction with no awaits, and item moves commit the
 * actor's save checkpoint in the same transaction (docs/plans/clan-storage.md).
 */
export class ClanStore {
    readonly now: () => number;
    readonly capacity: number;
    readonly maxMembers: number;
    readonly world: number;

    constructor(
        readonly db: Database,
        readonly items: ClanItems,
        options: ClanStoreOptions = {}
    ) {
        this.now = options.now ?? Date.now;
        this.capacity = options.capacity ?? 800;
        this.maxMembers = options.maxMembers ?? 500;
        this.world = options.world ?? 0;
        db.exec(`
            CREATE TABLE IF NOT EXISTS clan(
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL COLLATE NOCASE, display TEXT NOT NULL,
                owner TEXT NOT NULL, created INTEGER NOT NULL, home_world INTEGER NOT NULL DEFAULT 0,
                settings TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL DEFAULT 0, disbanded INTEGER);
            CREATE UNIQUE INDEX IF NOT EXISTS clan_name ON clan(name) WHERE disbanded IS NULL;
            CREATE TABLE IF NOT EXISTS clan_member(
                owner TEXT PRIMARY KEY, clan_id INTEGER NOT NULL, rank INTEGER NOT NULL, prev_rank INTEGER NOT NULL,
                joined INTEGER NOT NULL, rank_since INTEGER NOT NULL, invited_by TEXT, trusted INTEGER NOT NULL DEFAULT 0);
            CREATE INDEX IF NOT EXISTS clan_member_clan ON clan_member(clan_id, rank);
            CREATE TABLE IF NOT EXISTS clan_invite(clan_id INTEGER NOT NULL, owner TEXT NOT NULL, by TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(clan_id, owner));
            CREATE TABLE IF NOT EXISTS clan_item(
                clan_id INTEGER NOT NULL, item INTEGER NOT NULL, count INTEGER NOT NULL CHECK(count > 0 AND count <= ${MAX_STACK}),
                seq INTEGER NOT NULL, PRIMARY KEY(clan_id, item));
            CREATE TABLE IF NOT EXISTS clan_access(clan_id INTEGER NOT NULL, item INTEGER NOT NULL, min_rank INTEGER NOT NULL, cooldown_s INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(clan_id, item));
            CREATE TABLE IF NOT EXISTS clan_cooldown(clan_id INTEGER NOT NULL, owner TEXT NOT NULL, key TEXT NOT NULL, until INTEGER NOT NULL, PRIMARY KEY(clan_id, owner, key));
            CREATE TABLE IF NOT EXISTS clan_departure(owner TEXT NOT NULL, clan_id INTEGER NOT NULL, at INTEGER NOT NULL, reason TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS clan_departure_owner ON clan_departure(owner, at);
            CREATE TABLE IF NOT EXISTS clan_log(
                id INTEGER PRIMARY KEY AUTOINCREMENT, clan_id INTEGER NOT NULL, at INTEGER NOT NULL, actor TEXT NOT NULL,
                action TEXT NOT NULL, item INTEGER, count INTEGER, world INTEGER, coord INTEGER, revision INTEGER, detail TEXT);
            CREATE INDEX IF NOT EXISTS clan_log_clan ON clan_log(clan_id, id);
            CREATE INDEX IF NOT EXISTS clan_log_actor ON clan_log(actor, action, at);
            CREATE TABLE IF NOT EXISTS clan_value(clan_id INTEGER PRIMARY KEY, value INTEGER NOT NULL, top_items TEXT NOT NULL, at INTEGER NOT NULL);`);
    }

    // ---------------------------------------------------------------- reads

    private clanRow(id: number): Clan | undefined {
        const row = this.db.query<Omit<Clan, 'settings'> & { settings: string }, [number]>('SELECT id,name,display,owner,created,home_world,settings,revision FROM clan WHERE id=? AND disbanded IS NULL').get(id);
        return row ? { ...row, settings: { ...DEFAULT_SETTINGS, ...(JSON.parse(row.settings) as Partial<ClanSettings>) } } : undefined;
    }
    clan(id: number): Clan | undefined {
        return this.clanRow(id);
    }
    clanByName(name: string): Clan | undefined {
        const row = this.db.query<{ id: number }, [string]>('SELECT id FROM clan WHERE name=? AND disbanded IS NULL').get(normalizeName(name));
        return row ? this.clanRow(row.id) : undefined;
    }
    clans(): Clan[] {
        return this.db
            .query<{ id: number }, []>('SELECT id FROM clan WHERE disbanded IS NULL ORDER BY id')
            .all()
            .map(r => this.clanRow(r.id)!);
    }
    member(owner: string): ClanMember | undefined {
        return this.db.query<ClanMember, [string]>('SELECT * FROM clan_member WHERE owner=?').get(safeName(owner)) ?? undefined;
    }
    members(clanId: number): ClanMember[] {
        return this.db.query<ClanMember, [number]>('SELECT * FROM clan_member WHERE clan_id=? ORDER BY rank DESC, joined ASC, owner ASC').all(clanId);
    }
    revision(clanId: number): number {
        return this.db.query<{ revision: number }, [number]>('SELECT revision FROM clan WHERE id=?').get(clanId)?.revision ?? -1;
    }
    contents(clanId: number): ClanItemRow[] {
        return this.db.query<ClanItemRow, [number]>('SELECT item,count,seq FROM clan_item WHERE clan_id=? ORDER BY seq').all(clanId);
    }
    count(clanId: number, item: number): number {
        return this.db.query<{ count: number }, [number, number]>('SELECT count FROM clan_item WHERE clan_id=? AND item=?').get(clanId, item)?.count ?? 0;
    }
    accessRules(clanId: number): ClanAccessRule[] {
        return this.db.query<ClanAccessRule, [number]>('SELECT item,min_rank,cooldown_s FROM clan_access WHERE clan_id=? ORDER BY item').all(clanId);
    }
    log(clanId: number, limit = 50, actions?: string[]): ClanLogRow[] {
        if (actions?.length) {
            const marks = actions.map(() => '?').join(',');
            return this.db.query<ClanLogRow, (number | string)[]>(`SELECT * FROM clan_log WHERE clan_id=? AND action IN (${marks}) ORDER BY id DESC LIMIT ?`).all(clanId, ...actions, limit);
        }
        return this.db.query<ClanLogRow, [number, number]>('SELECT * FROM clan_log WHERE clan_id=? ORDER BY id DESC LIMIT ?').all(clanId, limit);
    }
    storageValue(clanId: number): { value: number; top: { id: number; name: string; count: number; value: number }[] } {
        const row = this.db.query<{ value: number; top_items: string }, [number]>('SELECT value,top_items FROM clan_value WHERE clan_id=?').get(clanId);
        return row ? { value: row.value, top: JSON.parse(row.top_items) } : { value: 0, top: [] };
    }
    effectiveRank(m: ClanMember, settings: ClanSettings, now = this.now()): number {
        if (m.trusted || now >= m.rank_since + settings.promotionHours * HOUR) return m.rank;
        return Math.min(m.rank, m.prev_rank);
    }
    newMemberUntil(m: ClanMember, settings: ClanSettings): number | null {
        if (m.trusted) return null;
        const until = m.joined + settings.newMemberHours * HOUR;
        return until > this.now() ? until : null;
    }
    private rule(clan: Clan, item: number): { minRank: number; cooldownS: number } {
        const r = this.db.query<ClanAccessRule, [number, number]>('SELECT item,min_rank,cooldown_s FROM clan_access WHERE clan_id=? AND item=?').get(clan.id, item);
        return r ? { minRank: r.min_rank, cooldownS: r.cooldown_s } : { minRank: clan.settings.minWithdraw, cooldownS: 0 };
    }
    private cooldownUntil(clanId: number, owner: string, item: number): number | null {
        const row = this.db.query<{ until: number }, [number, string, string]>('SELECT until FROM clan_cooldown WHERE clan_id=? AND owner=? AND key=?').get(clanId, owner, `item:${item}`);
        return row && row.until > this.now() ? row.until : null;
    }

    /** What a member's storage screen shows, including why each item can't be withdrawn yet. */
    view(owner: string): ClanView {
        const { clan, member } = this.requireMember(owner);
        const now = this.now();
        const effective = this.effectiveRank(member, clan.settings, now);
        const newMember = this.newMemberUntil(member, clan.settings);
        const promotion = !member.trusted && effective < member.rank ? member.rank_since + clan.settings.promotionHours * HOUR : null;
        const items = this.contents(clan.id).map((row, slot): ClanViewItem => {
            const rule = this.rule(clan, row.item);
            const exempt = effective >= RANK.admin;
            const cd = exempt ? null : this.cooldownUntil(clan.id, member.owner, row.item);
            let reason: string | null = null;
            if (effective < rule.minRank) reason = `Needs ${rankName(rule.minRank)}`;
            else if (newMember) reason = 'New member';
            else if (cd) reason = 'Cooldown';
            return { slot, id: row.item, name: this.items.name(row.item), count: row.count, minRank: rule.minRank, cooldownS: rule.cooldownS, canWithdraw: reason === null, cooldownUntil: cd, reason };
        });
        return {
            clan: { id: clan.id, name: clan.display },
            revision: clan.revision,
            rank: member.rank,
            effectiveRank: effective,
            canDeposit: effective >= clan.settings.minDeposit,
            capacity: { used: items.length, max: this.capacity },
            items,
            cooldowns: { newMember, promotion }
        };
    }

    // ---------------------------------------------------------------- helpers

    private requireMember(owner: string): { clan: Clan; member: ClanMember } {
        const member = this.member(owner);
        const clan = member ? this.clanRow(member.clan_id) : undefined;
        if (!member || !clan) throw new ClanError('You are not in a clan.', 'not_member');
        return { clan, member };
    }
    private bump(clanId: number): number {
        this.db.query('UPDATE clan SET revision=revision+1 WHERE id=?').run(clanId);
        return this.revision(clanId);
    }
    private addLog(clanId: number, actor: string, action: string, extra: { item?: number; count?: number; revision?: number; detail?: string; ctx?: ClanContext } = {}) {
        this.db
            .query('INSERT INTO clan_log(clan_id,at,actor,action,item,count,world,coord,revision,detail) VALUES(?,?,?,?,?,?,?,?,?,?)')
            .run(clanId, this.now(), actor, action, extra.item ?? null, extra.count ?? null, extra.ctx?.world ?? this.world, extra.ctx?.coord ?? null, extra.revision ?? null, extra.detail ?? null);
    }
    /** Refusals are recorded outside the failed transaction (which rolled back). */
    refused(owner: string, action: string, error: unknown, item?: number, ctx?: ClanContext) {
        const m = this.member(owner);
        if (!m || !(error instanceof ClanError)) return;
        try {
            this.addLog(m.clan_id, m.owner, 'refused', { item, ctx, detail: `${action}:${error.reason}:${error.message}`.slice(0, 200) });
        } catch {
            // an audit row must never turn a refusal into a crash
        }
    }
    private write<T>(work: () => T): T {
        let value!: T;
        this.db.transaction(() => (value = work())).immediate();
        return value;
    }
    private rejoinBlockedUntil(owner: string): number | null {
        const row = this.db.query<{ at: number }, [string]>("SELECT MAX(at) at FROM clan_departure WHERE owner=? AND reason IN ('leave','kick')").get(owner);
        if (!row?.at) return null;
        const until = row.at + REJOIN_MS;
        return until > this.now() ? until : null;
    }
    private managementBudget(clanId: number, actor: string) {
        const row = this.db.query<{ n: number }, [number, string, number]>("SELECT COUNT(*) n FROM clan_log WHERE clan_id=? AND actor=? AND action IN ('kick','rank') AND at>?").get(clanId, actor, this.now() - HOUR);
        if ((row?.n ?? 0) >= MANAGEMENT_PER_HOUR) throw new ClanError(`You can kick or change ranks at most ${MANAGEMENT_PER_HOUR} times an hour.`, 'rate_limit');
    }
    private updateValue(clanId: number) {
        const rows = this.contents(clanId).map(r => ({ id: r.item, name: this.items.name(r.item), count: r.count, value: this.items.value(r.item) * r.count }));
        const value = rows.reduce((n, r) => n + r.value, 0);
        rows.sort((a, b) => b.value - a.value || a.id - b.id);
        this.db.query('INSERT INTO clan_value(clan_id,value,top_items,at) VALUES(?,?,?,?) ON CONFLICT(clan_id) DO UPDATE SET value=excluded.value,top_items=excluded.top_items,at=excluded.at').run(clanId, value, JSON.stringify(rows.slice(0, 10)), this.now());
    }

    // ---------------------------------------------------------------- membership

    create(owner: string, name: string, ctx: ClanContext = {}): Clan {
        const actor = safeName(owner);
        const clean = normalizeName(name);
        if (!/^[a-z0-9]+( [a-z0-9]+)*$/.test(clean) || clean.length > 12) throw new ClanError('Clan names are 1-12 letters, digits and spaces.', 'invalid');
        return this.write(() => {
            if (this.member(actor)) throw new ClanError('You are already in a clan. Leave it first.', 'already_member');
            const blocked = this.rejoinBlockedUntil(actor);
            if (blocked) throw new ClanError(`You left a clan recently. You can join or create one in ${this.wait(blocked)}.`, 'cooldown');
            if (this.clanByName(clean)) throw new ClanError('A clan with that name already exists.', 'name_taken');
            const now = this.now();
            const id = Number(this.db.query('INSERT INTO clan(name,display,owner,created,home_world,settings) VALUES(?,?,?,?,?,?)').run(clean, displayName(clean), actor, now, ctx.world ?? this.world, '{}').lastInsertRowid);
            this.db.query('INSERT INTO clan_member(owner,clan_id,rank,prev_rank,joined,rank_since,invited_by,trusted) VALUES(?,?,?,?,?,?,NULL,1)').run(actor, id, RANK.owner, RANK.owner, now, now);
            // Owner decision: coins need Captain by default, with a 5 minute cooldown.
            this.db.query('INSERT INTO clan_access(clan_id,item,min_rank,cooldown_s) VALUES(?,?,?,?)').run(id, this.items.coins(), RANK.captain, 300);
            this.updateValue(id);
            this.addLog(id, actor, 'create', { detail: displayName(clean), ctx });
            return this.clanRow(id)!;
        });
    }

    invite(actor: string, target: string): { clan: Clan; target: string } {
        const by = safeName(actor);
        const who = safeName(target);
        return this.write(() => {
            const { clan, member } = this.requireMember(by);
            if (this.effectiveRank(member, clan.settings) < clan.settings.minInvite) throw new ClanError(`You need to be ${rankName(clan.settings.minInvite)} or higher to invite.`, 'permission');
            if (who === by || !/^[a-z0-9_]{1,12}$/.test(who)) throw new ClanError('Invite whom?', 'invalid');
            if (this.member(who)) throw new ClanError(`${who} is already in a clan.`, 'already_member');
            if (this.members(clan.id).length >= this.maxMembers) throw new ClanError('Your clan is full.', 'capacity');
            this.db.query('INSERT INTO clan_invite(clan_id,owner,by,created) VALUES(?,?,?,?) ON CONFLICT(clan_id,owner) DO UPDATE SET by=excluded.by, created=excluded.created').run(clan.id, who, by, this.now());
            this.addLog(clan.id, by, 'invite', { detail: who });
            return { clan, target: who };
        });
    }

    /** Pending invites addressed to an account (newest first, unexpired). */
    invites(owner: string): { clan: Clan; by: string; created: number }[] {
        return this.db
            .query<{ clan_id: number; by: string; created: number }, [string, number]>('SELECT clan_id,by,created FROM clan_invite WHERE owner=? AND created>? ORDER BY created DESC')
            .all(safeName(owner), this.now() - INVITE_TTL_MS)
            .flatMap(r => {
                const clan = this.clanRow(r.clan_id);
                return clan ? [{ clan, by: r.by, created: r.created }] : [];
            });
    }

    accept(owner: string, clanName?: string): Clan {
        const who = safeName(owner);
        return this.write(() => {
            if (this.member(who)) throw new ClanError('You are already in a clan.', 'already_member');
            const invites = this.invites(who).filter(i => !clanName || normalizeName(clanName) === i.clan.name.toLowerCase());
            if (!invites.length) throw new ClanError(clanName ? `You have no invite from ${displayName(normalizeName(clanName))} (invites expire after 10 minutes).` : 'You have no clan invite (invites expire after 10 minutes).', 'no_invite');
            const blocked = this.rejoinBlockedUntil(who);
            if (blocked) throw new ClanError(`You left a clan recently. You can join one in ${this.wait(blocked)}.`, 'cooldown');
            const { clan, by } = invites[0];
            if (this.members(clan.id).length >= this.maxMembers) throw new ClanError('That clan is full.', 'capacity');
            const now = this.now();
            this.db.query('INSERT INTO clan_member(owner,clan_id,rank,prev_rank,joined,rank_since,invited_by,trusted) VALUES(?,?,?,?,?,?,?,0)').run(who, clan.id, RANK.recruit, RANK.recruit, now, now, by);
            this.db.query('DELETE FROM clan_invite WHERE owner=?').run(who);
            this.addLog(clan.id, who, 'join', { detail: by });
            this.bump(clan.id);
            return clan;
        });
    }

    private depart(m: ClanMember, reason: 'leave' | 'kick' | 'disband') {
        this.db.query('DELETE FROM clan_member WHERE owner=?').run(m.owner);
        this.db.query('DELETE FROM clan_cooldown WHERE clan_id=? AND owner=?').run(m.clan_id, m.owner);
        this.db.query('INSERT INTO clan_departure(owner,clan_id,at,reason) VALUES(?,?,?,?)').run(m.owner, m.clan_id, this.now(), reason);
    }

    leave(owner: string): Clan {
        const who = safeName(owner);
        return this.write(() => {
            const { clan, member } = this.requireMember(who);
            if (member.rank === RANK.owner) throw new ClanError('The Owner cannot leave. Give ownership to another member (/clan rank NAME owner) or disband an empty clan (/clan disband).', 'permission');
            this.depart(member, 'leave');
            this.addLog(clan.id, who, 'leave');
            this.bump(clan.id);
            return clan;
        });
    }

    kick(actor: string, target: string): { clan: Clan; target: string } {
        const by = safeName(actor);
        const who = safeName(target);
        return this.write(() => {
            const { clan, member } = this.requireMember(by);
            const victim = this.member(who);
            if (!victim || victim.clan_id !== clan.id) throw new ClanError(`${who} is not in your clan.`, 'not_found');
            const rank = this.effectiveRank(member, clan.settings);
            if (rank < RANK.admin || victim.rank >= rank || who === by) throw new ClanError('You can only kick members ranked below you, and only as Admin or higher.', 'permission');
            this.managementBudget(clan.id, by);
            this.depart(victim, 'kick');
            this.addLog(clan.id, by, 'kick', { detail: who });
            this.bump(clan.id);
            return { clan, target: who };
        });
    }

    setRank(actor: string, target: string, rank: number): { clan: Clan; target: string; rank: number; delayedUntil: number | null } {
        const by = safeName(actor);
        const who = safeName(target);
        if (!Number.isInteger(rank) || rank < RANK.recruit || rank > RANK.owner) throw new ClanError('Unknown rank.', 'invalid');
        return this.write(() => {
            const { clan, member } = this.requireMember(by);
            const victim = this.member(who);
            if (!victim || victim.clan_id !== clan.id) throw new ClanError(`${who} is not in your clan.`, 'not_found');
            if (who === by) throw new ClanError('You cannot change your own rank.', 'permission');
            const mine = this.effectiveRank(member, clan.settings);
            const now = this.now();
            if (rank === RANK.owner) {
                if (member.rank !== RANK.owner || mine !== RANK.owner) throw new ClanError('Only the Owner can hand over ownership.', 'permission');
                this.managementBudget(clan.id, by);
                // Handing over ownership is the Owner's own trust decision: no promotion wait.
                this.db.query('UPDATE clan_member SET rank=?, prev_rank=?, rank_since=?, trusted=1 WHERE owner=?').run(RANK.owner, RANK.owner, now, who);
                this.changeRank(member, RANK.deputy, clan.settings, now);
                this.db.query('UPDATE clan SET owner=? WHERE id=?').run(who, clan.id);
                this.addLog(clan.id, by, 'rank', { detail: `${who}:${RANK.owner}:owner-transfer` });
                this.bump(clan.id);
                return { clan, target: who, rank, delayedUntil: null };
            }
            // Admins manage below Admin; a Deputy up to Admin; the Owner up to Deputy.
            const ceiling = mine >= RANK.owner ? RANK.deputy : mine >= RANK.deputy ? RANK.admin : mine >= RANK.admin ? RANK.general : 0;
            if (!ceiling || victim.rank >= mine || rank > ceiling) throw new ClanError(`You can set ranks up to ${ceiling ? rankName(ceiling) : 'nothing'} for members ranked below you.`, 'permission');
            this.managementBudget(clan.id, by);
            const delayed = this.changeRank(victim, rank, clan.settings, now);
            this.addLog(clan.id, by, 'rank', { detail: `${who}:${rank}` });
            this.bump(clan.id);
            return { clan, target: who, rank, delayedUntil: delayed };
        });
    }

    /** Lowered ranks apply at once; raised ranks give their extra rights after the promotion cooldown. */
    private changeRank(m: ClanMember, rank: number, settings: ClanSettings, now: number): number | null {
        const effective = this.effectiveRank(m, settings, now);
        const prev = rank > effective ? effective : rank;
        this.db.query('UPDATE clan_member SET rank=?, prev_rank=?, rank_since=? WHERE owner=?').run(rank, prev, now, m.owner);
        return rank > effective && !m.trusted ? now + settings.promotionHours * HOUR : null;
    }

    trust(actor: string, target: string): { clan: Clan; target: string } {
        const by = safeName(actor);
        const who = safeName(target);
        return this.write(() => {
            const { clan, member } = this.requireMember(by);
            if (this.effectiveRank(member, clan.settings) < RANK.deputy) throw new ClanError('Only the Owner or a Deputy owner can waive cooldowns.', 'permission');
            const victim = this.member(who);
            if (!victim || victim.clan_id !== clan.id) throw new ClanError(`${who} is not in your clan.`, 'not_found');
            this.db.query('UPDATE clan_member SET trusted=1 WHERE owner=?').run(who);
            this.addLog(clan.id, by, 'trust', { detail: who });
            this.bump(clan.id);
            return { clan, target: who };
        });
    }

    setAccess(actor: string, item: number, minRank: number | null, cooldownS = 0): { clan: Clan; item: number } {
        const by = safeName(actor);
        const id = this.items.canonical(item);
        if (minRank !== null && (!Number.isInteger(minRank) || minRank < RANK.recruit || minRank > RANK.owner)) throw new ClanError('Unknown rank.', 'invalid');
        if (!Number.isInteger(cooldownS) || cooldownS < 0 || cooldownS > 7 * 24 * 3600) throw new ClanError('Cooldowns are 0 to 7 days.', 'invalid');
        return this.write(() => {
            const { clan, member } = this.requireMember(by);
            if (this.effectiveRank(member, clan.settings) < RANK.admin) throw new ClanError('You need to be Admin or higher to change item access.', 'permission');
            if (minRank === null) this.db.query('DELETE FROM clan_access WHERE clan_id=? AND item=?').run(clan.id, id);
            else this.db.query('INSERT INTO clan_access(clan_id,item,min_rank,cooldown_s) VALUES(?,?,?,?) ON CONFLICT(clan_id,item) DO UPDATE SET min_rank=excluded.min_rank,cooldown_s=excluded.cooldown_s').run(clan.id, id, minRank, cooldownS);
            this.addLog(clan.id, by, 'access', { item: id, detail: minRank === null ? 'default' : `${minRank}:${cooldownS}` });
            this.bump(clan.id);
            return { clan, item: id };
        });
    }

    setSetting(actor: string, key: string, raw: string): { clan: Clan; key: keyof ClanSettings; value: number | boolean } {
        const by = safeName(actor);
        const settingKey = (Object.keys(DEFAULT_SETTINGS) as (keyof ClanSettings)[]).find(k => k.toLowerCase() === key.toLowerCase());
        if (!settingKey) throw new ClanError(`Settings: ${Object.keys(DEFAULT_SETTINGS).join(', ')}.`, 'invalid');
        const def = DEFAULT_SETTINGS[settingKey];
        let value: number | boolean;
        if (typeof def === 'boolean') {
            if (!/^(on|off|yes|no|true|false)$/i.test(raw)) throw new ClanError(`${settingKey} is on or off.`, 'invalid');
            value = /^(on|yes|true)$/i.test(raw);
        } else if (settingKey.startsWith('min')) {
            const r = parseRank(raw);
            if (!r) throw new ClanError(`${settingKey} takes a rank.`, 'invalid');
            value = r;
        } else {
            value = Number(raw);
            if (!Number.isInteger(value) || value < 0 || value > 24 * 30) throw new ClanError(`${settingKey} is a whole number of hours (0-720).`, 'invalid');
        }
        return this.write(() => {
            const { clan, member } = this.requireMember(by);
            const need = PRIVACY_SETTINGS.has(settingKey) ? RANK.deputy : RANK.admin;
            if (this.effectiveRank(member, clan.settings) < need) throw new ClanError(`You need to be ${rankName(need)} or higher to change ${settingKey}.`, 'permission');
            const settings = { ...clan.settings, [settingKey]: value };
            const stored: Partial<ClanSettings> = {};
            for (const k of Object.keys(settings) as (keyof ClanSettings)[]) if (settings[k] !== DEFAULT_SETTINGS[k]) (stored as Record<string, unknown>)[k] = settings[k];
            this.db.query('UPDATE clan SET settings=? WHERE id=?').run(JSON.stringify(stored), clan.id);
            this.addLog(clan.id, by, 'setting', { detail: `${settingKey}=${value}` });
            this.bump(clan.id);
            return { clan, key: settingKey, value };
        });
    }

    disband(actor: string): Clan {
        const by = safeName(actor);
        return this.write(() => {
            const { clan, member } = this.requireMember(by);
            if (member.rank !== RANK.owner) throw new ClanError('Only the Owner can disband the clan.', 'permission');
            if (this.contents(clan.id).length) throw new ClanError('Empty the clan storage before disbanding.', 'permission');
            for (const m of this.members(clan.id)) this.depart(m, 'disband');
            this.db.query('DELETE FROM clan_invite WHERE clan_id=?').run(clan.id);
            this.db.query('UPDATE clan SET disbanded=? WHERE id=?').run(this.now(), clan.id);
            this.addLog(clan.id, by, 'disband');
            this.bump(clan.id);
            return clan;
        });
    }

    wait(until: number): string {
        const s = Math.max(1, Math.ceil((until - this.now()) / 1000));
        if (s < 60) return `${s}s`;
        const m = Math.ceil(s / 60);
        if (m < 60) return `${m}m`;
        const h = Math.floor(m / 60);
        return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
    }

    // ---------------------------------------------------------------- storage

    private transfer<T>(account: ClanAccount, work: () => T): T {
        try {
            let value!: T;
            this.db
                .transaction(() => {
                    value = work();
                    account.save();
                })
                .immediate();
            return value;
        } catch (error) {
            account.rollback();
            throw error;
        }
    }

    private depositOne(clan: Clan, account: ClanAccount, objId: number, requested: number, ctx: ClanContext): { item: number; count: number } {
        const item = this.items.canonical(objId);
        const have = account.count(objId);
        const n = Math.min(requested, have);
        if (n <= 0) throw new ClanError("You don't have that item.", 'empty');
        const stored = this.count(clan.id, item);
        if (!stored && this.contents(clan.id).length >= this.capacity) throw new ClanError(`The clan storage is full (${this.capacity} kinds of item).`, 'capacity');
        const room = MAX_STACK - stored;
        const moved = Math.min(n, room);
        if (moved <= 0) throw new ClanError('The clan storage cannot hold any more of that item.', 'full');
        const taken = account.take(objId, moved);
        if (taken !== moved) throw new ClanError('Your inventory changed. Please try again.', 'stale');
        if (stored) this.db.query('UPDATE clan_item SET count=count+? WHERE clan_id=? AND item=?').run(moved, clan.id, item);
        else {
            const seq = (this.db.query<{ s: number | null }, [number]>('SELECT MAX(seq) s FROM clan_item WHERE clan_id=?').get(clan.id)?.s ?? 0) + 1;
            this.db.query('INSERT INTO clan_item(clan_id,item,count,seq) VALUES(?,?,?,?)').run(clan.id, item, moved, seq);
        }
        const revision = this.bump(clan.id);
        this.addLog(clan.id, account.owner, 'deposit', { item, count: moved, revision, ctx });
        return { item, count: moved };
    }

    private depositCheck(owner: string): Clan {
        const { clan, member } = this.requireMember(owner);
        const rank = this.effectiveRank(member, clan.settings);
        if (rank < clan.settings.minDeposit) throw new ClanError(`You need to be ${rankName(clan.settings.minDeposit)} or higher to deposit.`, 'rank');
        return clan;
    }

    /** Deposit up to n of exactly this obj id (a note deposits its real item). */
    deposit(account: ClanAccount, objId: number, n: number, ctx: ClanContext = {}): { item: number; count: number; revision: number } {
        if (!Number.isInteger(n) || n <= 0) throw new ClanError('Deposit how many?', 'invalid');
        return this.transfer(account, () => {
            const clan = this.depositCheck(account.owner);
            const r = this.depositOne(clan, account, objId, n, ctx);
            this.updateValue(clan.id);
            return { ...r, revision: this.revision(clan.id) };
        });
    }

    /** Every storable backpack item in one transaction; the rest stays in the backpack. */
    depositInventory(account: ClanAccount, ctx: ClanContext = {}): { moved: { item: number; count: number }[]; skipped: number[]; revision: number } {
        return this.transfer(account, () => {
            const clan = this.depositCheck(account.owner);
            const moved: { item: number; count: number }[] = [];
            const skipped: number[] = [];
            const seen = new Set<number>();
            for (const { id } of account.contents()) {
                if (seen.has(id)) continue;
                seen.add(id);
                try {
                    moved.push(this.depositOne(clan, account, id, account.count(id), ctx));
                } catch (error) {
                    if (!(error instanceof ClanError) || error.reason === 'stale') throw error;
                    skipped.push(id);
                }
            }
            if (!moved.length) throw new ClanError(skipped.length ? 'Nothing in your backpack can go into the clan storage.' : 'Your backpack is empty.', 'empty');
            this.updateValue(clan.id);
            return { moved, skipped, revision: this.revision(clan.id) };
        });
    }

    /**
     * Withdraw up to n of a stored item. Rank, new-member, promotion and item cooldowns are
     * checked inside the transaction; the item cooldown row is written in the same one.
     */
    withdraw(account: ClanAccount, item: number, n: number, noted = false, ctx: ClanContext = {}): { item: number; given: number; givenId: number; revision: number } {
        if (!Number.isInteger(n) || n <= 0) throw new ClanError('Withdraw how many?', 'invalid');
        return this.transfer(account, () => {
            const { clan, member } = this.requireMember(account.owner);
            const stored = this.count(clan.id, item);
            if (!stored) throw new ClanError('The storage has changed, try again.', 'stale');
            const rank = this.effectiveRank(member, clan.settings);
            const rule = this.rule(clan, item);
            if (rank < rule.minRank) {
                const pending = member.rank >= rule.minRank ? ` Your promotion applies in ${this.wait(member.rank_since + clan.settings.promotionHours * HOUR)}.` : '';
                throw new ClanError(`You need to be ${rankName(rule.minRank)} or higher to withdraw ${this.items.name(item)}.${pending}`, 'rank');
            }
            const fresh = this.newMemberUntil(member, clan.settings);
            if (fresh) throw new ClanError(`New members can withdraw after ${this.wait(fresh)}.`, 'cooldown');
            const exempt = rank >= RANK.admin;
            const cd = exempt ? null : this.cooldownUntil(clan.id, member.owner, item);
            if (cd) throw new ClanError(`You can withdraw ${this.items.name(item)} again in ${this.wait(cd)}.`, 'cooldown');
            const want = Math.min(n, stored);
            const givenId = noted ? this.items.noted(item) : item;
            const given = account.give(givenId, want);
            if (!Number.isInteger(given) || given < 0 || given > want) throw new Error('Invalid inventory transfer.');
            if (!given) throw new ClanError("You don't have enough inventory space.", 'full');
            if (given === stored) this.db.query('DELETE FROM clan_item WHERE clan_id=? AND item=?').run(clan.id, item);
            else this.db.query('UPDATE clan_item SET count=count-? WHERE clan_id=? AND item=?').run(given, clan.id, item);
            if (!exempt && rule.cooldownS > 0) {
                this.db.query('INSERT INTO clan_cooldown(clan_id,owner,key,until) VALUES(?,?,?,?) ON CONFLICT(clan_id,owner,key) DO UPDATE SET until=excluded.until').run(clan.id, member.owner, `item:${item}`, this.now() + rule.cooldownS * 1000);
            }
            const revision = this.bump(clan.id);
            this.addLog(clan.id, account.owner, 'withdraw', { item, count: given, revision, ctx, detail: noted && givenId !== item ? 'noted' : undefined });
            this.updateValue(clan.id);
            return { item, given, givenId, revision };
        });
    }

    describeMember(owner: string): string {
        const m = this.member(owner);
        const clan = m ? this.clanRow(m.clan_id) : undefined;
        if (!m || !clan) return 'You are not in a clan.';
        const eff = this.effectiveRank(m, clan.settings);
        const bits = [`Clan: ${clan.display} (${this.members(clan.id).length} members). Your rank: ${rankName(m.rank)}`];
        if (eff < m.rank) bits.push(` (acting ${rankName(eff)} for ${this.wait(m.rank_since + clan.settings.promotionHours * HOUR)})`);
        const fresh = this.newMemberUntil(m, clan.settings);
        if (fresh) bits.push(`. New member: withdrawals in ${this.wait(fresh)}`);
        return bits.join('') + '.';
    }
}

