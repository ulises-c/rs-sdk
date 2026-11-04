import { toDisplayName } from '#/util/JString.js';
import type { ClanTabState } from '../../../../../sdk/clan-types.js';
import { rankName } from './ClanRanks.js';
import type { Clan, ClanMember } from './ClanStore.js';

/** Hidden JSON state component of the clan tab (reserved client code block 30460+). */
export const CLAN_TAB_CLIENTCODE = 30461;
/** Rows in the tab's scroll list (clan_tab.if is sized for this many). */
export const CLAN_TAB_ROWS = 60;

/** Anything with a display name: a Player, or a test double. */
type Online = { displayName: string };

type Row = { name: string; rank: number; online: boolean };

/** Tab text for one clan: online members first (rank order), then everyone else. */
export function clanTabContent(clan: Pick<Clan, 'id' | 'display'>, members: ClanMember[], online: Map<string, Online>, seq = 0) {
    const rows: Row[] = [];
    for (const m of members) if (online.has(m.owner)) rows.push({ name: online.get(m.owner)!.displayName, rank: m.rank, online: true });
    const onlineCount = rows.length;
    for (const m of members) if (!online.has(m.owner)) rows.push({ name: toDisplayName(m.owner), rank: m.rank, online: false });
    const visible = rows.length > CLAN_TAB_ROWS ? rows.slice(0, CLAN_TAB_ROWS - 1) : rows;
    const names = visible.map(r => r.name);
    const ranks = visible.map(r => (r.online ? rankName(r.rank) : `@red@${rankName(r.rank)}`));
    if (visible.length < rows.length) {
        names.push(`@yel@...and ${rows.length - visible.length} more`);
        ranks.push('');
    }
    const state: ClanTabState = {
        seq,
        clan: { id: clan.id, name: clan.display },
        memberCount: members.length,
        onlineCount,
        members: rows.map(r => ({ name: r.name, rank: r.rank, rankName: rankName(r.rank), online: r.online }))
    };
    return {
        title: clan.display,
        members: `Members: ${members.length}`,
        online: `Online: ${onlineCount}`,
        // A literal backslash-n is this client's line break in interface text.
        names: names.join('\\n'),
        ranks: ranks.join('\\n'),
        state
    };
}


/**
 * What a player outside any clan sees in the clan tab (feature on): how to start or join one. The
 * same components as the roster (no extra interface), with an empty bot state (state.clan = null).
 */
export function clanTabHelp() {
    const lines = [
        'You are not in a clan.',
        '',
        '@yel@Start a clan:',
        '/clan create NAME',
        '',
        '@yel@Join a clan:',
        'Ask a member to invite',
        'you, then type:',
        '/clan accept NAME',
        '',
        '@yel@Clan chat:',
        'Start a line with /'
    ];
    return {
        title: 'Not in a clan',
        members: 'Type the commands in',
        online: 'the public chat box.',
        names: lines.join('\\n'),
        ranks: '',
        agent_state: ''
    };
}
