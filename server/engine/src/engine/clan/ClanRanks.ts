/** OSRS clan-chat ranks. Values are stored in the ledger: never renumber. */
export const RANK = {
    recruit: 1,
    corporal: 2,
    sergeant: 3,
    lieutenant: 4,
    captain: 5,
    general: 6,
    admin: 7,
    deputy: 8,
    owner: 9
} as const;
export type RankValue = (typeof RANK)[keyof typeof RANK];

const NAMES: Record<number, string> = {
    1: 'Recruit',
    2: 'Corporal',
    3: 'Sergeant',
    4: 'Lieutenant',
    5: 'Captain',
    6: 'General',
    7: 'Admin',
    8: 'Deputy owner',
    9: 'Owner'
};

export function rankName(rank: number): string {
    return NAMES[rank] ?? `Rank ${rank}`;
}

/** Accepts "deputy owner", "deputy", "deputy_owner", "8"; returns undefined for anything else. */
export function parseRank(text: string): RankValue | undefined {
    const t = text.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
    if (/^[1-9]$/.test(t)) return Number(t) as RankValue;
    if (t === 'deputy owner' || t === 'deputy') return RANK.deputy;
    return (RANK as Record<string, RankValue>)[t];
}

/** Rank words that can end a command line, longest first ("deputy owner" before "owner"). */
export const RANK_WORDS = ['deputy owner', 'deputy', 'owner', 'admin', 'general', 'captain', 'lieutenant', 'sergeant', 'corporal', 'recruit'];
