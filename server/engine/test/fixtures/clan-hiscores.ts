// Spawned by clan-hiscores.test.ts in a temp cwd: db.sqlite (hiscore tables) + GE_DATABASE ledger.
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { clanStore } from '../../src/engine/clan/ClanLedger.js';
import { handleClanHiscores, clearClanHiscoresCache } from '../../src/web/pages/ClanHiscores.js';
import { handleHiscoresPlayerPage, handleHiscoresPage } from '../../src/web/pages/hiscores.js';

const database = new Database('db.sqlite');
database.exec(`CREATE TABLE account(id INTEGER PRIMARY KEY,username TEXT,staffmodlevel INTEGER);
    CREATE TABLE hiscore(profile TEXT,account_id INTEGER,type INTEGER,level INTEGER,value INTEGER,playtime INTEGER);
    CREATE TABLE hiscore_large(profile TEXT,account_id INTEGER,type INTEGER,level INTEGER,value INTEGER,playtime INTEGER);
    CREATE TABLE hiscore_bank(profile TEXT,account_id INTEGER,value INTEGER,items TEXT,date TEXT);
    INSERT INTO account VALUES(1,'alice',0),(2,'bob',0),(3,'carol',0),(4,'hidden',0),(5,'staffy',2),(6,'dave',0),(7,'erin',0);
    INSERT INTO hiscore_large VALUES('main',1,0,300,30000,1),('main',2,0,200,20000,1),('main',3,0,100,10000,1),('main',4,0,999,999990,1),('main',5,0,999,999990,1),('main',6,0,500,99990,1),('main',7,0,500,99990,1);
    INSERT INTO hiscore VALUES('main',1,9,20,45000,1),('main',3,9,15,25000,1),('main',4,9,99,9999990,1),('main',1,100,12,12,1),('main',2,100,3,3,1),('main',4,100,99,99,1);
    INSERT INTO hiscore_bank VALUES('main',1,1000,'[]',''),('main',2,500,'[]',''),('main',3,0,'[]',''),('main',4,99999,'[]',''),('main',6,5,'[]','');`);

const store = clanStore();
store.create('alice', 'Stud Unit');
for (const n of ['bob', 'carol', 'hidden', 'staffy']) {
    store.invite('alice', n);
    store.accept(n);
}
store.setRank('alice', 'bob', 3);
store.create('dave', 'Duo');
store.invite('dave', 'erin');
store.accept('erin');
const studId = store.clanByName('stud unit')!.id;
store.db.query('INSERT INTO clan_value(clan_id,value,top_items,at) VALUES(?,?,?,?) ON CONFLICT(clan_id) DO UPDATE SET value=excluded.value').run(studId, 7000, '[]', Date.now());

const get = async (path: string) => {
    const r = await handleClanHiscores(new URL('http://localhost' + path));
    assert.ok(r, path);
    return { status: r.status, text: await r.text() };
};
const json = async (path: string) => JSON.parse((await get(path)).text);

try {
    const board = await get('/hiscores/clans');
    assert.equal(board.status, 200);
    assert.ok(board.text.includes('Stud Unit'));
    assert.ok(!board.text.includes('>Duo<'), 'a 2-member clan is not ranked');
    const overall = await json('/api/hiscores/clans?metric=overall');
    assert.deepEqual(overall.rows, [{ rank: 1, name: 'Stud Unit', members: 3, value: 6000 }], 'hidden and staff members are not summed or counted');
    assert.equal((await json('/api/hiscores/clans?metric=wealth')).rows[0].value, 1500 + 7000, 'wealth = members bank values + storage');
    assert.equal((await json('/api/hiscores/clans?metric=bank')).rows[0].value, 1500);
    assert.equal((await json('/api/hiscores/clans?metric=storage')).rows[0].value, 7000);
    assert.equal((await json('/api/hiscores/clans?metric=qp')).rows[0].value, 15);
    assert.equal((await json('/api/hiscores/clans?metric=woodcutting')).rows[0].value, 4500 + 2500, 'skill sums use rows at 15+ only (bob has none)');
    assert.equal((await json('/api/hiscores/clans?metric=average')).rows[0].value, 200);
    assert.equal((await get('/api/hiscores/clans?metric=nope')).status, 400);
    const page = await get('/hiscores/clan/stud%20unit');
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('Founded') && page.text.includes('alice founded the clan') && page.text.includes('bob joined') && page.text.includes('bob is now Sergeant'), 'overview + activity feed');
    const members = await get('/hiscores/clan/stud%20unit?tab=members&metric=overall');
    assert.ok(members.text.includes('alice') && members.text.includes('Sergeant'));
    assert.ok(!members.text.includes('hidden') && !members.text.includes('staffy'), 'hidden and staff accounts are not listed');
    const duo = await get('/hiscores/clan/duo');
    assert.equal(duo.status, 200);
    assert.ok(duo.text.includes('Not ranked yet'), 'small clans have a page that says why they are unranked');
    const data = await json('/api/hiscores/clan/stud%20unit');
    assert.equal(data.members, 3);
    assert.equal(data.ranks.overall, 1);
    assert.equal(data.totals.bankValue, 1500);
    assert.equal(data.memberList.length, 3);
    // player page link and sidebar link
    const player = await (await handleHiscoresPlayerPage(new URL('http://localhost/hiscores/player/alice')))!.text();
    assert.ok(player.includes('Clan: <a href="/hiscores/clan/stud%20unit?profile=main"'), 'player page links the clan');
    const nonMember = await (await handleHiscoresPlayerPage(new URL('http://localhost/hiscores/player/hidden')))?.text();
    void nonMember;
    const list = await (await handleHiscoresPage(new URL('http://localhost/hiscores?category=0')))!.text();
    assert.ok(list.includes('href="/hiscores/clans?profile=main"'), 'Clans link in the board sidebar');
    // privacy: bank values off, member list off, then hiscores off
    store.setSetting('alice', 'showBankValues', 'off');
    clearClanHiscoresCache();
    assert.equal((await json('/api/hiscores/clan/stud%20unit')).totals.bankValue, null);
    assert.equal((await json('/api/hiscores/clan/stud%20unit')).memberList[0].bankValue, null);
    store.setSetting('alice', 'showMembers', 'off');
    clearClanHiscoresCache();
    assert.equal((await json('/api/hiscores/clan/stud%20unit')).memberList, null);
    assert.ok((await get('/hiscores/clan/stud%20unit?tab=members')).text.includes('keeps its member list private'));
    store.setSetting('alice', 'hiscores', 'off');
    clearClanHiscoresCache();
    assert.equal((await get('/hiscores/clan/stud%20unit')).status, 404);
    assert.deepEqual((await json('/api/hiscores/clans')).rows, []);
    assert.ok(!(await (await handleHiscoresPlayerPage(new URL('http://localhost/hiscores/player/alice')))!.text()).includes('Clan:'));
    // 60 s cache: a new member does not show until the cache expires (or is cleared)
    store.setSetting('alice', 'hiscores', 'on');
    clearClanHiscoresCache();
    const before = (await json('/api/hiscores/clan/stud%20unit')).members;
    store.invite('alice', 'erin2');
    store.accept('erin2');
    assert.equal((await json('/api/hiscores/clan/stud%20unit')).members, before, 'cached for 60 s');
    // disabled flag: routes fall through
    process.env.CLAN_HISCORES_ENABLED = 'false';
    assert.equal(await handleClanHiscores(new URL('http://localhost/hiscores/clans')), null);
    console.log('PASS clan hiscore pages: boards, min members, privacy, sub-15 rule, QP/bank/storage/wealth/average, activity, player link, JSON, cache, flag');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    store.db.close();
    database.close();
    process.exit(process.exitCode ?? 0);
}
