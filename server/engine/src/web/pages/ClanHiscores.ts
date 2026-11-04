import { db } from '#/db/query.js';
import { clanHiscoresEnabled, clanStore } from '#/engine/clan/ClanLedger.js';
import { rankName } from '#/engine/clan/ClanRanks.js';
import type { Clan, ClanStore } from '#/engine/clan/ClanStore.js';
import Environment from '#/util/Environment.js';
import { tryParseInt } from '#/util/TryParse.js';
import { escapeHtml, ENABLED_SKILLS, QUEST_POINTS_HISCORE_TYPE } from '../utils.js';
import { CLAN_METRICS, rankClans, rankMembers, totals, metricValue, type ClanMemberStats, type ClanMetric, type ClanSummary } from './ClanBoards.js';

/** Clan hiscores, phase 1: boards from current values, clan page Overview/Members, activity, JSON. */
const CACHE_MS = Number(process.env.CLAN_HISCORES_CACHE_MS ?? 60_000);
const PAGE = 21;
export const minMembers = () => {
    const n = Number(process.env.CLAN_HISCORE_MIN_MEMBERS);
    return Number.isInteger(n) && n > 0 ? n : 3;
};

type Snapshot = { at: number; clans: ClanSummary[]; pending: Promise<ClanSummary[]> | null };
const cache = new Map<string, Snapshot>();

function profileOf(url: URL): string {
    return (url.searchParams.get('profile') || 'main').replace(/[^a-zA-Z0-9_-]/g, '');
}

async function loadSummaries(store: ClanStore, profile: string): Promise<ClanSummary[]> {
    const clans = store.clans();
    const members = clans.flatMap(c => store.members(c.id).map(m => ({ clan: c, m })));
    const names = [...new Set(members.map(x => x.m.owner.toLowerCase()))];
    const stats = new Map<string, ClanMemberStats>();
    if (names.length) {
        const accounts = await db
            .selectFrom('account')
            .select(['id', 'username', 'staffmodlevel'])
            .where(eb => eb(eb.fn('lower', ['username']), 'in', names))
            .execute();
        const byId = new Map(accounts.map(a => [a.id, a]));
        const ids = accounts.map(a => a.id);
        const large = ids.length ? await db.selectFrom('hiscore_large').select(['account_id', 'level', 'value']).where('profile', '=', profile).where('type', '=', 0).where('account_id', 'in', ids).execute() : [];
        const small = ids.length ? await db.selectFrom('hiscore').select(['account_id', 'type', 'level', 'value']).where('profile', '=', profile).where('account_id', 'in', ids).execute() : [];
        const banks = ids.length ? await db.selectFrom('hiscore_bank').select(['account_id', 'value']).where('profile', '=', profile).where('account_id', 'in', ids).execute() : [];
        const hidden = new Set(Environment.HISCORES_HIDDEN_NAMES);
        for (const a of accounts) {
            stats.set(a.username.toLowerCase(), { owner: a.username.toLowerCase(), rank: 0, joined: 0, visible: a.staffmodlevel <= 1 && !hidden.has(a.username.toLowerCase()), totalLevel: 0, totalXp: 0, skills: {}, qp: 0, bank: 0 });
        }
        const get = (accountId: number) => stats.get(byId.get(accountId)!.username.toLowerCase())!;
        for (const r of large) {
            const s = get(r.account_id);
            s.totalLevel = r.level;
            s.totalXp = Math.floor(Number(r.value) / 10);
        }
        for (const r of small) {
            const s = get(r.account_id);
            if (r.type === QUEST_POINTS_HISCORE_TYPE) s.qp = r.level;
            else if (r.type >= 1 && r.type <= 50) s.skills[r.type - 1] = Math.floor(Number(r.value) / 10);
        }
        for (const r of banks) get(r.account_id).bank = Number(r.value);
    }
    return clans.map(c => ({
        id: c.id,
        name: c.display,
        created: c.created,
        hiscores: c.settings.hiscores,
        showMembers: c.settings.showMembers,
        showBankValues: c.settings.showBankValues,
        storageValue: store.storageValue(c.id).value,
        members: members
            .filter(x => x.clan.id === c.id)
            .map(({ m }) => {
                const s = stats.get(m.owner.toLowerCase());
                // A member with no account row in this profile still counts as a member with zero stats.
                return { ...(s ?? { owner: m.owner, visible: true, totalLevel: 0, totalXp: 0, skills: {}, qp: 0, bank: 0 }), rank: m.rank, joined: m.joined };
            })
    }));
}

/** Clan summaries for a profile, cached for CLAN_HISCORES_CACHE_MS (60 s) so a page view never scans the tables. */
export async function clanSummaries(profile: string): Promise<ClanSummary[]> {
    const hit = cache.get(profile);
    if (hit?.pending) return hit.pending;
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.clans;
    const entry: Snapshot = { at: hit?.at ?? 0, clans: hit?.clans ?? [], pending: null };
    entry.pending = loadSummaries(clanStore(), profile)
        .then(clans => {
            entry.clans = clans;
            entry.at = Date.now();
            return clans;
        })
        .finally(() => (entry.pending = null));
    cache.set(profile, entry);
    return entry.pending;
}
export function clearClanHiscoresCache() {
    cache.clear();
}

export function parseMetric(raw: string | null): ClanMetric | null {
    const t = (raw ?? 'overall').toLowerCase();
    if ((CLAN_METRICS as readonly string[]).includes(t)) return t as ClanMetric;
    if (t === 'quest' || t === 'questpoints') return 'qp';
    const skill = ENABLED_SKILLS.find(s => s.name.toLowerCase() === t);
    return skill ? `skill:${skill.id}` : null;
}
export function metricLabel(metric: ClanMetric): string {
    if (metric.startsWith('skill:')) return ENABLED_SKILLS.find(s => s.id === Number(metric.slice(6)))?.name ?? metric;
    return { overall: 'Overall', qp: 'Quest Points', bank: 'Bank value', storage: 'Clan storage value', wealth: 'Wealth', average: 'Average level' }[metric as (typeof CLAN_METRICS)[number]];
}
function metricKey(metric: ClanMetric): string {
    return metric.startsWith('skill:') ? metricLabel(metric).toLowerCase() : metric;
}
const allMetrics = (): ClanMetric[] => ['overall', ...ENABLED_SKILLS.map(s => `skill:${s.id}` as ClanMetric), 'qp', 'bank', 'storage', 'wealth', 'average'];
const fmt = (n: number) => n.toLocaleString('en-US');
function formatValue(metric: ClanMetric, n: number): string {
    if (metric === 'bank' || metric === 'storage' || metric === 'wealth') return `${fmt(n)} gp`;
    if (metric === 'average') return `${fmt(n)} total`;
    if (metric === 'qp') return `${fmt(n)} QP`;
    return `${fmt(n)} XP`;
}
const clanHref = (name: string, profile: string, extra = '') => `/hiscores/clan/${encodeURIComponent(name.toLowerCase())}?profile=${profile}${extra}`;

const STYLE = `body,p,td{font-family:Arial,Helvetica,sans-serif;font-size:13px}body{background:#000;color:#fff;margin:0;padding:0}
a{text-decoration:none}.c{color:#fff}.c:hover{text-decoration:underline}.e{border:2px solid #382418}.yellow{color:#FFE139}.text-orange{color:#ffbb22}
.dim{color:#9a8f7d}table.list td{padding:2px 6px}`;
function page(title: string, body: string): Response {
    const html = `<!DOCTYPE html><html><head><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><center><div style="width:640px;margin-top:20px">
<table width="640" bgcolor="black" cellpadding="6"><tr><td class="e"><center><b>${escapeHtml(title)}</b><br>
<a href="/" class="c">Main menu</a> | <a href="/hiscores" class="c">All Hiscores</a> | <a href="/hiscores/clans" class="c">Clan Hiscores</a></center></td></tr></table><br>
${body}</div></center></body></html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html' } });
}
function metricLinks(profile: string, current: ClanMetric, base: (m: string) => string): string {
    return allMetrics()
        .map(m => (m === current ? `<b class="yellow">${metricLabel(m)}</b>` : `<a class="c" href="${base(metricKey(m))}">${metricLabel(m)}</a>`))
        .join(' &middot; ');
}

function boardJson(profile: string, metric: ClanMetric, clans: ClanSummary[]) {
    return {
        profile,
        metric: metricKey(metric),
        label: metricLabel(metric),
        minMembers: minMembers(),
        cacheSeconds: CACHE_MS / 1000,
        rows: rankClans(clans, metric, minMembers()).map(r => ({ rank: r.rank, name: r.name, members: r.members, value: r.value }))
    };
}

function findClan(clans: ClanSummary[], name: string): ClanSummary | undefined {
    const key = decodeURIComponent(name).replace(/[_+]/g, ' ').trim().toLowerCase();
    return clans.find(c => c.name.toLowerCase() === key);
}

function activity(store: ClanStore, clanId: number, limit = 20) {
    return store.log(clanId, limit, ['create', 'join', 'leave', 'kick', 'rank', 'disband']).map(r => {
        const who = r.actor.replace(/_/g, ' ');
        let text: string;
        const [target, rank] = (r.detail ?? '').split(':');
        const t = target?.replace(/_/g, ' ');
        if (r.action === 'create') text = `${who} founded the clan`;
        else if (r.action === 'join') text = `${who} joined`;
        else if (r.action === 'leave') text = `${who} left`;
        else if (r.action === 'kick') text = `${t} was removed by ${who}`;
        else if (r.action === 'rank') text = `${t} is now ${rankName(Number(rank))}`;
        else text = `${who} disbanded the clan`;
        return { at: r.at, action: r.action, text };
    });
}

function clanJson(store: ClanStore, clan: ClanSummary, clans: ClanSummary[], profile: string) {
    const t = totals(clan);
    const ranks: Record<string, number | null> = {};
    for (const m of allMetrics()) ranks[metricKey(m)] = rankClans(clans, m, minMembers()).find(r => r.id === clan.id)?.rank ?? null;
    const full: Clan | undefined = store.clan(clan.id);
    return {
        name: clan.name,
        profile,
        founded: clan.created,
        homeWorld: full?.home_world ?? null,
        members: t.members,
        ranked: t.members >= minMembers(),
        minMembers: minMembers(),
        ranks,
        totals: { totalLevel: t.totalLevel, totalXp: t.totalXp, questPoints: t.qp, bankValue: clan.showBankValues ? t.bank : null, storageValue: t.storage, wealth: t.wealth, averageLevel: t.average },
        memberList: clan.showMembers
            ? rankMembers(clan, 'overall').map(m => ({ name: m.owner.replace(/_/g, ' '), rank: rankName(m.rank), totalLevel: m.totalLevel, totalXp: m.totalXp, questPoints: m.qp, bankValue: clan.showBankValues ? m.bank : null }))
            : null,
        activity: activity(store, clan.id)
    };
}

/** Routes: /hiscores/clans, /hiscores/clan/NAME, /api/hiscores/clans, /api/hiscores/clan/NAME. Off unless CLAN_HISCORES_ENABLED. */
export async function handleClanHiscores(url: URL): Promise<Response | null> {
    const path = url.pathname.replace(/\/+$/, '');
    const board = /^\/(api\/)?hi(?:gh)?scores\/clans$/.exec(path);
    const one = /^\/(api\/)?hi(?:gh)?scores\/clan\/([^/]+)$/.exec(path);
    if (!board && !one) return null;
    if (!clanHiscoresEnabled()) return null;
    const profile = profileOf(url);
    const store = clanStore();
    const clans = (await clanSummaries(profile)).filter(c => c.hiscores);
    const metric = parseMetric(url.searchParams.get('metric'));
    if (!metric) return new Response('Unknown metric', { status: 400 });
    if (board) {
        const search = url.searchParams.get('clan');
        if (search && !board[1]) {
            const found = findClan(clans, search);
            if (found) return Response.redirect(clanHref(found.name, profile), 302);
        }
        if (board[1]) return Response.json(boardJson(profile, metric, clans), { headers: { 'Cache-Control': `max-age=${Math.floor(CACHE_MS / 1000)}` } });
        const rows = rankClans(clans, metric, minMembers());
        const start = Math.max(0, tryParseInt(url.searchParams.get('rank'), 1) - 1);
        const shown = rows.slice(start, start + PAGE);
        const table = shown.length
            ? shown.map(r => `<tr><td align="right">${r.rank}</td><td><a class="c" href="${clanHref(r.name, profile)}">${escapeHtml(r.name)}</a></td><td align="right">${r.members}</td><td align="right">${formatValue(metric, r.value)}</td></tr>`).join('\n')
            : `<tr><td colspan="4" class="dim">No clan has ${minMembers()} or more members yet.</td></tr>`;
        const nav = `${start > 0 ? `<a class="yellow" href="/hiscores/clans?metric=${metricKey(metric)}&rank=${Math.max(1, start - PAGE + 1)}&profile=${profile}">&#9650; Prev</a>` : ''} ${start + PAGE < rows.length ? `<a class="yellow" href="/hiscores/clans?metric=${metricKey(metric)}&rank=${start + PAGE + 1}&profile=${profile}">Next &#9660;</a>` : ''}`;
        return page(
            `Clan Hiscores: ${metricLabel(metric)}`,
            `<table width="640" bgcolor="black" cellpadding="6"><tr><td class="e" style="font-size:11px">${metricLinks(profile, metric, m => `/hiscores/clans?metric=${m}&profile=${profile}`)}</td></tr></table><br>
<table width="640" bgcolor="black" cellpadding="6"><tr><td class="e"><table class="list" width="100%"><tr><td align="right"><b>Rank</b></td><td><b>Clan</b></td><td align="right"><b>Members</b></td><td align="right"><b>${metricLabel(metric)}</b></td></tr>
${table}</table><center>${nav}</center><p class="dim" style="font-size:11px">Clans need ${minMembers()} or more members to be ranked. Sums count current members only; skill sums use rows at level 15+ (as the player boards), Overall uses true totals. Values update when members log out; this board refreshes every ${Math.round(CACHE_MS / 1000)} s.</p>
<form action="/hiscores/clans" method="get"><input type="hidden" name="profile" value="${profile}">Find clan: <input name="clan" maxlength="12" size="14"> <input type="submit" value="Search"></form></td></tr></table>`
        );
    }
    const clan = findClan(clans, one![2]);
    if (!clan) return one![1] ? Response.json({ error: 'Clan not found' }, { status: 404 }) : new Response('Clan not found.', { status: 404, headers: { 'Content-Type': 'text/html' } });
    const data = clanJson(store, clan, clans, profile);
    if (one![1]) return Response.json(data, { headers: { 'Cache-Control': `max-age=${Math.floor(CACHE_MS / 1000)}` } });
    const tab = url.searchParams.get('tab') === 'members' ? 'members' : 'overview';
    const tabs = `<a class="${tab === 'overview' ? 'yellow' : 'c'}" href="${clanHref(clan.name, profile)}">Overview</a> | <a class="${tab === 'members' ? 'yellow' : 'c'}" href="${clanHref(clan.name, profile, '&tab=members')}">Members</a>`;
    let body: string;
    if (tab === 'overview') {
        const t = data.totals;
        const rankRows = allMetrics()
            .map(m => `<tr><td><a class="c" href="/hiscores/clans?metric=${metricKey(m)}&profile=${profile}">${metricLabel(m)}</a></td><td align="right">${data.ranks[metricKey(m)] ?? '-'}</td><td align="right">${formatValue(m, metricValue(totals(clan), m))}</td></tr>`)
            .join('\n');
        const feed = data.activity.length ? data.activity.map(a => `<tr><td class="dim">${new Date(a.at).toISOString().slice(0, 16).replace('T', ' ')}</td><td>${escapeHtml(a.text)}</td></tr>`).join('\n') : '<tr><td class="dim">No activity yet.</td></tr>';
        body = `<p>Founded ${new Date(clan.created).toISOString().slice(0, 10)} &middot; ${data.members} member${data.members === 1 ? '' : 's'} &middot; home world ${data.homeWorld ?? '-'}</p>
${data.ranked ? '' : `<p class="text-orange">Not ranked yet: clans need ${minMembers()} or more members.</p>`}
<p>Total level ${fmt(t.totalLevel)} &middot; ${fmt(t.totalXp)} XP &middot; ${fmt(t.questPoints)} QP &middot; average level ${fmt(t.averageLevel)}<br>
${t.bankValue !== null ? `Bank value ${fmt(t.bankValue)} gp &middot; ` : ''}Clan storage ${fmt(t.storageValue)} gp &middot; Wealth ${fmt(t.wealth)} gp</p>
<table class="list" width="100%"><tr><td><b>Board</b></td><td align="right"><b>Rank</b></td><td align="right"><b>Value</b></td></tr>${rankRows}</table>
<br><b>Activity</b><table class="list" width="100%">${feed}</table>`;
    } else if (!clan.showMembers) {
        body = '<p class="dim">This clan keeps its member list private.</p>';
    } else {
        const rows = rankMembers(clan, metric)
            .map(m => `<tr><td align="right">${m.position}</td><td><a class="c" href="/hiscores/player/${encodeURIComponent(m.owner)}?profile=${profile}">${escapeHtml(m.owner.replace(/_/g, ' '))}</a></td><td>${rankName(m.rank)}</td><td align="right">${fmt(m.totalLevel)}</td><td align="right">${fmt(m.qp)}</td><td align="right">${clan.showBankValues ? fmt(m.bank) : '-'}</td><td align="right">${formatValue(metric, m.value)}</td></tr>`)
            .join('\n');
        body = `<p style="font-size:11px">${metricLinks(profile, metric, m => clanHref(clan.name, profile, `&tab=members&metric=${m}`))}</p>
<table class="list" width="100%"><tr><td align="right"><b>#</b></td><td><b>Member</b></td><td><b>Rank</b></td><td align="right"><b>Total</b></td><td align="right"><b>QP</b></td><td align="right"><b>Bank gp</b></td><td align="right"><b>${metricLabel(metric)}</b></td></tr>${rows}</table>`;
    }
    return page(`${clan.name}`, `<table width="640" bgcolor="black" cellpadding="6"><tr><td class="e"><center>${tabs}</center>${body}</td></tr></table>`);
}

/** Sidebar link on the player boards (one call from hiscores.ts). */
export function clanHiscoreTableLink(profile: string): string {
    return clanHiscoresEnabled() ? `\n<tr><td><a href="/hiscores/clans?profile=${profile}" class="c text-orange">Clans</a></td></tr>` : '';
}

/** "Clan: <name>" line on a player page (one call from hiscores.ts). Empty when not in a public clan. */
export function clanPlayerLink(username: string, profile: string): string {
    if (!clanHiscoresEnabled()) return '';
    try {
        const store = clanStore();
        const m = store.member(username);
        const clan = m ? store.clan(m.clan_id) : undefined;
        if (!clan || !clan.settings.hiscores) return '';
        return `Clan: <a href="${clanHref(clan.display, profile)}" class="c yellow">${escapeHtml(clan.display)}</a><br>`;
    } catch {
        return '';
    }
}
