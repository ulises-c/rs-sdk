/** Pure clan board ranking (docs/plans/clan-hiscores.md phase 1). No database or world access. */

export type ClanMemberStats = {
    owner: string;
    rank: number;
    joined: number;
    /** False for hidden names and staff accounts: never listed, summed or counted. */
    visible: boolean;
    totalLevel: number;
    totalXp: number;
    /** XP per skill id from `hiscore` rows (level >= 15 only, as the player boards). */
    skills: Record<number, number>;
    qp: number;
    bank: number;
};
export type ClanSummary = {
    id: number;
    name: string;
    created: number;
    hiscores: boolean;
    showMembers: boolean;
    showBankValues: boolean;
    storageValue: number;
    members: ClanMemberStats[];
};
export type ClanTotals = {
    members: number;
    totalLevel: number;
    totalXp: number;
    skills: Record<number, number>;
    qp: number;
    bank: number;
    storage: number;
    wealth: number;
    average: number;
};
export type BoardRow = { rank: number; id: number; name: string; members: number; value: number; totals: ClanTotals };

export const CLAN_METRICS = ['overall', 'qp', 'bank', 'storage', 'wealth', 'average'] as const;
export type ClanMetric = (typeof CLAN_METRICS)[number] | `skill:${number}`;

export function totals(clan: ClanSummary): ClanTotals {
    const shown = clan.members.filter(m => m.visible);
    const skills: Record<number, number> = {};
    for (const m of shown) for (const [id, xp] of Object.entries(m.skills)) skills[Number(id)] = (skills[Number(id)] ?? 0) + xp;
    const sum = (f: (m: ClanMemberStats) => number) => shown.reduce((n, m) => n + f(m), 0);
    const bank = sum(m => m.bank);
    const totalLevel = sum(m => m.totalLevel);
    return {
        members: shown.length,
        totalLevel,
        totalXp: sum(m => m.totalXp),
        skills,
        qp: sum(m => m.qp),
        bank,
        storage: clan.storageValue,
        wealth: bank + clan.storageValue,
        average: shown.length ? Math.floor(totalLevel / shown.length) : 0
    };
}

export function metricValue(t: ClanTotals, metric: ClanMetric): number {
    if (metric.startsWith('skill:')) return t.skills[Number(metric.slice(6))] ?? 0;
    switch (metric) {
        case 'overall':
            return t.totalXp;
        case 'qp':
            return t.qp;
        case 'bank':
            return t.bank;
        case 'storage':
            return t.storage;
        case 'wealth':
            return t.wealth;
        case 'average':
            return t.average;
    }
    return 0;
}

/** A clan is ranked only with hiscores on and at least `minMembers` visible members. */
export function eligible(clan: ClanSummary, minMembers: number): boolean {
    return clan.hiscores && clan.members.filter(m => m.visible).length >= minMembers;
}

/**
 * Ranked board. Ties: Overall by total level then founding date; Average by total XP then
 * founding date; everything else by founding date. Clan id breaks the last tie.
 */
export function rankClans(clans: ClanSummary[], metric: ClanMetric, minMembers: number): BoardRow[] {
    const rows = clans
        .filter(c => eligible(c, minMembers))
        .map(c => {
            const t = totals(c);
            return { id: c.id, name: c.name, created: c.created, members: t.members, value: metricValue(t, metric), totals: t };
        });
    const second = (r: (typeof rows)[number]) => (metric === 'overall' ? r.totals.totalLevel : metric === 'average' ? r.totals.totalXp : 0);
    rows.sort((a, b) => b.value - a.value || second(b) - second(a) || a.created - b.created || a.id - b.id);
    return rows.map((r, i) => ({ rank: i + 1, id: r.id, name: r.name, members: r.members, value: r.value, totals: r.totals }));
}

/** Members of one clan ranked by a metric (visible members only). */
export function rankMembers(clan: ClanSummary, metric: ClanMetric): (ClanMemberStats & { position: number; value: number })[] {
    const value = (m: ClanMemberStats) => {
        if (metric.startsWith('skill:')) return m.skills[Number(metric.slice(6))] ?? 0;
        if (metric === 'qp') return m.qp;
        if (metric === 'bank' || metric === 'wealth') return m.bank;
        if (metric === 'average') return m.totalLevel;
        return m.totalXp;
    };
    return clan.members
        .filter(m => m.visible)
        .map(m => ({ ...m, value: value(m) }))
        .sort((a, b) => b.value - a.value || b.totalLevel - a.totalLevel || a.joined - b.joined || a.owner.localeCompare(b.owner))
        .map((m, i) => ({ ...m, position: i + 1 }));
}
