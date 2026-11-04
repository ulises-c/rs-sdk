// Clan storage integration: real packed content, Player inventories/saves, compiled bank scripts,
// native handlers (bank-screen button, storage grid, count dialog, public chat), the SDK porcelain
// over the encoded hidden state, and the clan hiscore routes. Temp ledger only.
//   bun run test:clan:integration
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
const dir = mkdtempSync(join(tmpdir(), 'clan-integration-'));
process.env.GE_DATABASE = join(dir, 'market.sqlite');
process.env.CLAN_STORAGE_ENABLED = 'true';
process.env.CLAN_HISCORES_ENABLED = 'true';
process.env.CLAN_CHAT_ENABLED = 'true';
const { default: World } = await import('../src/engine/World.js');
const { default: Component } = await import('../src/cache/config/Component.js');
const { default: ObjType } = await import('../src/cache/config/ObjType.js');
const { default: InvType } = await import('../src/cache/config/InvType.js');
const { default: LocType } = await import('../src/cache/config/LocType.js');
const { default: Packet } = await import('../src/io/Packet.js');
const { PlayerLoading } = await import('../src/engine/entity/PlayerLoading.js');
const { default: IfButtonHandler } = await import('../src/network/game/client/handler/IfButtonHandler.js');
const { default: InvButtonHandler } = await import('../src/network/game/client/handler/InvButtonHandler.js');
const { default: InvButton } = await import('../src/network/game/client/model/InvButton.js');
const { default: IfButton } = await import('../src/network/game/client/model/IfButton.js');
const { default: CountHandler } = await import('../src/network/game/client/handler/ResumePCountDialogHandler.js');
const { default: Count } = await import('../src/network/game/client/model/ResumePCountDialog.js');
const { default: ChatHandler } = await import('../src/network/game/client/handler/MessagePublicHandler.js');
const { default: MessagePublic } = await import('../src/network/game/client/model/MessagePublic.js');
const { default: ScriptProvider } = await import('../src/engine/script/ScriptProvider.js');
const { default: ScriptRunner } = await import('../src/engine/script/ScriptRunner.js');
const { default: ServerTriggerType } = await import('../src/engine/script/ServerTriggerType.js');
const { default: TextEncoder } = await import('../src/network/game/server/codec/IfSetTextEncoder.js');
const { clanStore, resetClanStore } = await import('../src/engine/clan/ClanLedger.js');
const { clanTick } = await import('../src/engine/clan/ClanHooks.js');
const { CLAN_STATE_CLIENTCODE } = await import('../src/engine/clan/ClanStorage.js');
const { CLAN_TAB, CLAN_TAB_CLIENTCODE } = await import('../src/engine/clan/ClanTab.js');
const { setClanChatIgnoreLookup, clanChatDrained } = await import('../src/engine/clan/ClanChat.js');
const { default: WordEnc } = await import('../src/cache/wordenc/WordEnc.js');
const { PlayerInfoProt } = await import('../src/network/rsbuf/index.js');
const { handleClanHiscores, clearClanHiscoresCache } = await import('../src/web/pages/ClanHiscores.js');
// Client-side word packer, as the lite client and the standard client use it.
const { default: ClientWordPack } = await import('../../webclient/src/wordfilter/WordPack.ts' as string);
const { default: ClientPacket } = await import('../../webclient/src/io/Packet.ts' as string);
const sdkModule = '../../../sdk/index.ts',
    actionsModule = '../../../sdk/actions.ts',
    clanActionsModule = '../../../sdk/clan-actions.ts',
    stateModule = '../../webclient/src/bot/clan-storage-state.ts',
    tabStateModule = '../../webclient/src/bot/clan-tab-state.ts',
    clanChatModule = '../../../sdk/clan-chat.ts';
const { BotSDK } = await import(sdkModule);
const { BotActions } = await import(actionsModule);
const { CLAN_BANK_BUTTON_ID, CLAN_STORAGE_ROOT_ID } = await import(clanActionsModule);
const { collectClanStorageState, CLAN_STORAGE_CLIENTCODE } = await import(stateModule);
const { collectClanTabState, CLAN_TAB_CLIENTCODE: LITE_TAB_CLIENTCODE } = await import(tabStateModule);
const { parseClanChatLine, clanChatCommand } = await import(clanChatModule);

let passed = 0;
const ok = (cond: unknown, what: string) => {
    assert(cond, what);
    passed++;
};
try {
    World.reload();
    World.gameMap.init();
    WordEnc.load('data/pack');
    // Ignore lists live in db.sqlite (friend server); the test injects them instead.
    let ignores = new Map<string, Set<string>>();
    setClanChatIgnoreLookup(async sender => ignores.get(sender) ?? new Set());
    const inv = InvType.getId('inv'),
        coins = ObjType.getId('coins'),
        logs = ObjType.getId('logs'),
        lobster = ObjType.getId('lobster'),
        rune = ObjType.getId('rune_platelegs');
    const logsNote = ObjType.get(logs).certlink;
    ok(logsNote > 0 && ObjType.get(logsNote).certtemplate >= 0, 'logs have a note');
    ok(Component.getId('bank_main:clan_storage') === CLAN_BANK_BUTTON_ID, 'SDK bank button id matches the packed interface');
    ok(Component.getId('clan_storage') === CLAN_STORAGE_ROOT_ID, 'SDK root id matches');
    ok(CLAN_STATE_CLIENTCODE === CLAN_STORAGE_CLIENTCODE, 'engine and lite-client agree on the state clientcode');
    ok(Component.get(Component.getId('bank_main:clan_storage_layer')).hide, 'bank button is hidden by default (upstream look for everyone else)');

    // Two real bank booths: Varrock west and Varrock east.
    const booth = LocType.getId('bankbooth');
    const findBooth = (x0: number, x1: number, z0: number, z1: number) => {
        for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
            const l = World.getLoc(x, z, 0, booth);
            if (l) return l;
        }
        return null;
    };
    const west = findBooth(3180, 3192, 3433, 3447);
    const east = findBooth(3250, 3258, 3416, 3424);
    ok(west && east, 'found two bank booths');
    const boothScript = ScriptProvider.getByTrigger(ServerTriggerType.OPLOC2, booth, -1);
    ok(boothScript, 'compiled oploc2 bankbooth (Bank) trigger');

    let slot = 1;
    const agentState = new Map<string, any>();
    const messages = new Map<string, string[]>();
    const tabText = new Map<string, Map<number, string>>();
    const publicHeard = new Map<string, number>();
    const load = (name: string) => {
        const p = PlayerLoading.load(name, new Packet(new Uint8Array()), null);
        p.x = west!.x + 1;
        p.z = west!.z;
        p.level = 0;
        p.slot = slot++;
        p.uid = ((Number(p.username37 & 0x1fffffn) << 11) | p.slot) >>> 0;
        World.players[p.slot] = p;
        World.playerLoop.add(BigInt(p.slot), p);
        messages.set(name, []);
        tabText.set(name, new Map());
        publicHeard.set(name, 0);
        const stateId = Component.getId('clan_storage:agent_state');
        const tabRoot = Component.getId('clan_tab');
        p.write = (m: any) => {
            if (m.msg !== undefined) messages.get(name)!.push(m.msg);
            if (m.constructor?.name === 'MessagePublic') publicHeard.set(name, publicHeard.get(name)! + 1);
            if (m.component !== undefined && m.text !== undefined && Component.get(m.component)?.rootLayer === tabRoot) tabText.get(name)!.set(m.component, m.text);
            if (m.component !== stateId || !m.text) return;
            // Encode with the real IF_SETTEXT encoder into a socket-sized buffer, then parse like the lite client.
            const packet = Packet.alloc(1);
            new TextEncoder().encode(packet, m);
            assert(packet.pos < 4997, 'state fits the native packet buffer');
            packet.pos = 0;
            assert.equal(packet.g2(), stateId);
            const text = packet.gjstr();
            packet.release();
            agentState.set(name, collectClanStorageState([{ clientCode: CLAN_STORAGE_CLIENTCODE, text, children: null }], 0));
        };
        return p;
    };
    type P = ReturnType<typeof load>;
    const say = (p: P, text: string) => {
        // Pack exactly as the client does, decode with the real handler.
        const out = new ClientPacket(new Uint8Array(512));
        ClientWordPack.pack(out, text);
        const handled = new ChatHandler().handle(new MessagePublic(out.data.slice(0, out.pos), 0, 0), p);
        p.socialProtect = false; // one chat per tick; the test runs many per "tick"
        return handled;
    };
    const lastMsg = (p: P) => messages.get(p.username)!.at(-1) ?? '';
    const openBank = (p: P, at: NonNullable<typeof west>) => {
        p.x = at.x + 1;
        p.z = at.z;
        p.executeScript(ScriptRunner.init(boothScript!, p, at), true);
        assert.equal(p.modalMain, Component.getId('bank_main'), 'booth opened the bank');
    };
    const click = (p: P, id: number) => new IfButtonHandler().handle(new IfButton(id), p);
    const grid = (p: P, op: number, item: number) => {
        const s = agentState.get(p.username);
        const slotOf = s.items.findIndex((i: any) => i.id === item);
        return new InvButtonHandler().handle(new InvButton(op, item, slotOf, Component.getId('clan_storage:inv')), p);
    };
    const side = (p: P, op: number, item: number) =>
        new InvButtonHandler().handle(
            new InvButton(
                op,
                item,
                p.getInventory(inv)!.items.findIndex(i => i?.id === item),
                Component.getId('clan_storage_side:inv')
            ),
            p
        );
    const count = (p: P, item: number) => p.getInventory(inv)!.getItemCount(item);
    const store = clanStore();

    // ---- chat commands through the real word packer and handler
    const tester = load('bot_tester'),
        geometry = load('bot_geometry'),
        outsider = load('outsider');
    ok(say(tester, '/clan create Stud Unit'), '/clan text is intercepted after client word packing');
    ok(/Stud Unit/.test(lastMsg(tester)), `create reply names the clan: ${lastMsg(tester)}`);
    ok(store.clanByName('stud unit')?.owner === 'bot_tester', 'clan "Stud Unit" stored');
    say(tester, 'clan create x');
    ok(store.clanByName('x') === undefined && tester.chatMessage !== null, 'plain "clan ..." chat is broadcast, not a command');
    say(tester, '/clan invite bot geometry');
    say(geometry, '/clan accept stud unit');
    ok(store.member('bot_geometry')?.rank === 1, 'bot_geometry joined as Recruit');
    say(geometry, '/clan info');
    ok(messages.get('bot_geometry')!.some(m => /Stud Unit/.test(m)), '/clan info answers');

    // ---- bank-screen button: hidden for non-members, opens storage for members
    openBank(outsider, west!);
    clanTick(outsider);
    ok(click(outsider, CLAN_BANK_BUTTON_ID), 'button click is handled');
    ok(outsider.modalMain === Component.getId('bank_main'), 'non-members stay on the bank screen');
    openBank(tester, west!);
    clanTick(tester);
    click(tester, CLAN_BANK_BUTTON_ID);
    ok(tester.modalMain === Component.getId('clan_storage') && tester.modalSide === Component.getId('clan_storage_side'), 'bank-screen button opens the clan storage screen');
    ok(agentState.get('bot_tester')?.clan.name === 'Stud Unit', 'hidden state published');

    // ---- deposit via native grid clicks (items, notes, coins), conservation
    tester.invAdd(inv, coins, 5000);
    tester.invAdd(inv, logsNote, 30);
    tester.invAdd(inv, lobster, 3);
    tester.invAdd(inv, rune, 1);
    const total = (id: number, also = -1) => count(tester, id) + (also >= 0 ? count(tester, also) : 0) + count(geometry, id) + (also >= 0 ? count(geometry, also) : 0) + store.count(store.member('bot_tester')!.clan_id, id);
    const before = { coins: total(coins), logs: total(logs, logsNote), lobster: total(lobster), rune: total(rune) };
    side(tester, 4, coins); // Deposit All
    side(tester, 5, logsNote); // Deposit X
    ok(agentState.get('bot_tester').input === 'deposit', 'Deposit-X waits for a count');
    new CountHandler().handle(new Count(20), tester);
    side(tester, 1, lobster);
    side(tester, 1, rune);
    const clanId = store.member('bot_tester')!.clan_id;
    ok(store.count(clanId, coins) === 5000 && store.count(clanId, logs) === 20 && store.count(clanId, lobster) === 1, 'deposits landed (notes as real logs)');
    ok(count(tester, logsNote) === 10, 'Deposit-X moved exactly 20 notes');

    // ---- a second viewer (bot_geometry) at ANOTHER bank sees the same store and its updates
    openBank(geometry, east!);
    clanTick(geometry);
    click(geometry, CLAN_BANK_BUTTON_ID);
    ok(geometry.modalMain === Component.getId('clan_storage'), 'second member opens storage at another bank');
    const gState = () => agentState.get('bot_geometry');
    ok(gState().items.find((i: any) => i.id === logs)?.count === 20, 'second viewer sees the deposits');
    ok(gState().cooldowns.newMember > Date.now(), 'new member cooldown shown');
    ok(gState().items.every((i: any) => !i.canWithdraw), 'new member cannot withdraw');
    grid(geometry, 1, lobster);
    ok(gState().errorReason === 'rank' || gState().errorReason === 'cooldown', `new member refused (${gState().errorReason}: ${gState().error})`);
    ok(store.count(clanId, lobster) === 1 && count(geometry, lobster) === 0, 'refusal moved nothing');

    // waiver + rank, then the rank refusal on coins and the coin cooldown
    say(tester, '/clan trust bot geometry');
    say(tester, '/clan rank bot geometry sergeant');
    ok(store.member('bot_geometry')!.rank === 3, `/clan rank applied: ${lastMsg(tester)}`);
    clanTick(geometry);
    grid(geometry, 1, lobster);
    ok(count(geometry, lobster) === 1, 'trusted Sergeant withdraws a lobster at the other bank');
    grid(geometry, 1, coins);
    ok(gState().errorReason === 'rank' && /Captain/.test(gState().error), `coins need Captain: ${gState().error}`);
    say(tester, '/clan rank bot geometry captain');
    clanTick(geometry);
    grid(geometry, 3, coins);
    ok(count(geometry, coins) === 10, 'Captain withdrew 10 coins');
    grid(geometry, 3, coins);
    ok(gState().errorReason === 'cooldown' && count(geometry, coins) === 10, `coin cooldown: ${gState().error}`);

    // withdraw as notes
    click(geometry, Component.getId('clan_storage:mode'));
    ok(gState().noteMode === true, 'note mode on');
    grid(geometry, 5, logs);
    new CountHandler().handle(new Count(7), geometry);
    ok(count(geometry, logsNote) === 7, 'withdrew 7 logs as notes');

    // stale click: tester's view still lists rune platelegs at a slot; geometry empties lobster first
    clanTick(tester);
    const testerRows = agentState.get('bot_tester').items.map((i: any) => i.id);
    store.setAccess('bot_tester', lobster, 1, 0);
    // tester (owner) withdraws the last lobster? none left: geometry took it. Clicking the old slot is stale.
    const lobsterSlot = testerRows.indexOf(lobster);
    new InvButtonHandler().handle(new InvButton(1, lobster, lobsterSlot, Component.getId('clan_storage:inv')), tester);
    ok(['stale', 'empty'].includes(agentState.get('bot_tester').errorReason), `stale click refused (${agentState.get('bot_tester').errorReason})`);
    ok(count(tester, lobster) === 2, 'stale click gave nothing');

    // full backpack
    const filler = ObjType.getId('bronze_dagger');
    const free = geometry.getInventory(inv)!.freeSlotCount;
    geometry.invAdd(inv, filler, free);
    grid(geometry, 1, rune);
    ok(gState().errorReason === 'full' && store.count(clanId, rune) === 1, 'full backpack: nothing moves');
    geometry.invDel(inv, filler, free);

    const after = { coins: total(coins), logs: total(logs, logsNote), lobster: total(lobster), rune: total(rune) };
    ok(JSON.stringify(after) === JSON.stringify(before), `conservation across every op ${JSON.stringify(after)}`);

    // ---- SDK porcelain over the same handlers
    let sdkIndex = 0;
    const agent = (p: P) => {
        const sdk = new BotSDK({ botUsername: p.username + '_sdk' + sdkIndex++, autoLaunchBrowser: false });
        sdk.isConnected = () => true;
        sdk.getStateAge = () => 0;
        const sync = () => {
            const items = p.getInventory(inv)!.items.map((it, slot) => (it ? { slot, id: it.id, name: ObjType.get(it.id).name, count: it.count, optionsWithIndex: [] } : null)).filter(Boolean);
            const open = p.modalMain === Component.getId('clan_storage');
            sdk.state = { modalOpen: p.modalMain !== -1, bank: { isOpen: p.modalMain === Component.getId('bank_main'), items: [] }, clanStorage: open ? agentState.get(p.username) : null, inventory: items, gameMessages: messages.get(p.username)!.map(text => ({ text, type: 0, sender: '' })) };
            for (const l of (sdk as any).listeners ?? []) l(sdk.state);
        };
        sdk.waitForCondition = async (pred: (s: any) => boolean, timeout: number) => {
            const end = Date.now() + timeout;
            for (;;) {
                clanTick(p);
                sync();
                if (pred(sdk.state)) return sdk.state;
                if (Date.now() > end) throw new Error('timeout');
                await Bun.sleep(5);
            }
        };
        sdk.sendAction = async (action: any) => {
            let handled = false;
            if (action.type === 'clickComponent') handled = click(p, action.componentId);
            if (action.type === 'clickComponentWithOption') {
                const it = action.componentId === Component.getId('clan_storage:inv') ? agentState.get(p.username).items[action.slot]?.id : p.getInventory(inv)!.get(action.slot)?.id;
                handled = new InvButtonHandler().handle(new InvButton(action.optionIndex, it ?? -1, action.slot, action.componentId), p);
            }
            if (action.type === 'submitCountDialog') handled = new CountHandler().handle(new Count(action.value), p);
            sync();
            return { success: handled, message: handled ? 'Dispatched' : 'Rejected by handler' };
        };
        const bot = new BotActions(sdk);
        sync();
        return { sdk, bot, sync };
    };
    click(geometry, Component.getId('clan_storage:close'));
    openBank(geometry, east!);
    const g = agent(geometry);
    const opened = await g.bot.openClanStorage(3000);
    ok(opened.success, `bot.openClanStorage: ${opened.message}`);
    const lob = await g.bot.clanDeposit(lobster, 1, 3000);
    ok(lob.success && lob.count === 1, `bot.clanDeposit: ${lob.message}`);
    const dx = await g.bot.clanDeposit(logsNote, 4, 3000);
    ok(dx.success && dx.count === 4 && count(geometry, logsNote) === 3, `bot.clanDeposit X: ${dx.message}`);
    const wd = await g.bot.clanWithdraw('Logs', 2, { noted: false }, 3000);
    ok(wd.success && wd.count === 2 && count(geometry, logs) === 2, `bot.clanWithdraw items: ${wd.message}`);
    const refused = await g.bot.clanWithdraw('Coins', 1, {}, 3000);
    ok(!refused.success && refused.reason === 'cooldown', `bot.clanWithdraw refuses locally on cooldown: ${refused.reason}`);
    const forced = await g.bot.clanWithdraw('Coins', 1, { force: true }, 3000);
    ok(!forced.success && forced.reason === 'cooldown', `forced withdraw: server refusal surfaces as reason ${forced.reason}`);
    const all = await g.bot.clanDepositInventory(3000);
    ok(all.success && geometry.getInventory(inv)!.freeSlotCount === 28, `bot.clanDepositInventory: ${all.message}`);
    const bank = await g.bot.openBank(3000);
    ok(bank.success && geometry.modalMain === Component.getId('bank_main'), `openBank from clan storage returns to the bank (not "already open"): ${bank.message}`);
    const reopened = await g.bot.openClanStorage(3000);
    ok(reopened.success, 'reopen');
    const closed = await g.bot.closeClanStorage(3000);
    ok(closed.success && geometry.modalMain === -1, 'bot.closeClanStorage');

    // ---- persistence across a "restart": drop the store handle and reopen the ledger file
    const snapshot = JSON.stringify(store.contents(clanId));
    resetClanStore();
    ok(JSON.stringify(clanStore().contents(clanId)) === snapshot, 'ledger reopened with identical contents');
    ok(clanStore().log(clanId, 200).filter(r => r.action === 'deposit' || r.action === 'withdraw').every(r => r.world !== null && r.coord !== null), 'audit rows carry world and coord');

    // ---- clan side tab (slot 7) and clan chat ("/" lines)
    const tab = (p: P, name: string) => tabText.get(p.username)!.get(Component.getId(`clan_tab:${name}`)) ?? '';
    const tabState = (p: P) => collectClanTabState([{ clientCode: LITE_TAB_CLIENTCODE, text: tab(p, 'agent_state'), children: null }], 0);
    ok(CLAN_TAB_CLIENTCODE === LITE_TAB_CLIENTCODE, 'engine and lite client agree on the tab clientcode');
    ok(Component.getId('clan_tab') > 40773, 'clan tab uses a reserved interface id');
    outsider.tabs[3] = -1; // before login.rs2 has set the ordinary tabs
    for (const p of [tester, geometry, outsider]) clanTick(p);
    ok(tester.tabs[CLAN_TAB] === Component.getId('clan_tab') && geometry.tabs[CLAN_TAB] === Component.getId('clan_tab'), 'members get the clan tab in slot 7');
    ok(outsider.tabs[CLAN_TAB] === -1, 'non-member: no clan tab before the ordinary tabs are up');
    outsider.tabs[3] = Component.getId('inventory'); // login.rs2 has set the ordinary tabs
    clanTick(outsider);
    ok(outsider.tabs[CLAN_TAB] === Component.getId('clan_tab'), 'non-members get the clan tab too (its icon is in the sidebar background)');
    ok(tab(outsider, 'title') === 'Not in a clan' && /\/clan create NAME/.test(tab(outsider, 'names')) && /\/clan accept NAME/.test(tab(outsider, 'names')), `non-member help view: ${tab(outsider, 'title')} / ${tab(outsider, 'names')}`);
    ok(tab(outsider, 'members') !== '' && tab(outsider, 'ranks') === '' && tabState(outsider) === null, 'help view: no roster, no bot state (state.clan = null)');
    const helpWrites = tabText.get(outsider.username)!.size;
    tabText.get(outsider.username)!.clear();
    clanTick(outsider);
    ok(tabText.get(outsider.username)!.size === 0 && helpWrites > 0, 'help view is sent once, not every tick');
    ok(tab(tester, 'title') === 'Stud Unit' && tab(tester, 'online') === 'Online: 2' && tab(tester, 'members') === 'Members: 2', `tab header: ${tab(tester, 'title')} / ${tab(tester, 'members')} / ${tab(tester, 'online')}`);
    ok(tab(tester, 'names').split('\\n').join(',') === 'Bot Tester,Bot Geometry', `tab names (online, rank order): ${tab(tester, 'names')}`);
    ok(tabState(tester)?.onlineCount === 2 && tabState(tester)?.members[1].rankName === 'Captain', 'tab JSON for bots');

    // move the outsider far away: a public broadcast would reach it as MESSAGE_PUBLIC
    const recruit = load('clan_member');
    recruit.x += 2;
    outsider.x += 40;
    say(tester, '/clan invite clan member');
    say(recruit, '/clan accept stud unit');
    clanTick(recruit);
    clanTick(tester);
    ok(tab(tester, 'online') === 'Online: 3' && recruit.tabs[CLAN_TAB] === Component.getId('clan_tab'), 'a join updates the tab live');
    const quiet = (p: P) => {
        p.chatMessage = null;
        p.masks = 0;
    };
    for (const p of [tester, geometry, recruit, outsider]) quiet(p);
    const heardBefore = publicHeard.get('outsider')!;
    ok(say(geometry, clanChatCommand('hello stud unit')), 'a "/" line is handled');
    await clanChatDrained();
    const line = '[Stud Unit] Bot Geometry: Hello stud unit';
    ok(lastMsg(tester) === line && lastMsg(recruit) === line && lastMsg(geometry) === line, `members (and the speaker) get the clan line: ${lastMsg(tester)}`);
    ok(!messages.get('outsider')!.includes(line), 'non-members do not');
    ok(geometry.chatMessage === null && (geometry.masks & PlayerInfoProt.CHAT) === 0, 'no overhead/public chat for the speaker');
    ok(publicHeard.get('outsider') === heardBefore, 'no out-of-range public broadcast');
    ok(JSON.stringify(parseClanChatLine(line)) === JSON.stringify({ clan: 'Stud Unit', sender: 'Bot Geometry', text: 'Hello stud unit' }), 'SDK parses the clan line');
    say(tester, '/clan create nothing');
    ok(tester.chatMessage === null && (tester.masks & PlayerInfoProt.CHAT) === 0, '/clan commands are never public either');
    // word filter like public chat
    const rude = 'what the fuck';
    say(recruit, '/' + rude);
    await clanChatDrained();
    ok(lastMsg(tester).startsWith('[Stud Unit] Clan Member: ') && lastMsg(tester).endsWith(WordEnc.filter('What the fuck')) && WordEnc.filter('What the fuck') !== 'What the fuck', `filtered: ${lastMsg(tester)}`);
    // ignore: bot_tester ignores clan_member
    ignores.set('clan_member', new Set(['bot_tester']));
    const testerCount = messages.get('bot_tester')!.length;
    say(recruit, '/anyone there');
    await clanChatDrained();
    ok(messages.get('bot_tester')!.length === testerCount && lastMsg(geometry) === '[Stud Unit] Clan Member: Anyone there', 'a member ignoring the speaker does not get the line');
    ignores = new Map();
    // mute: the upstream mute check drops it before the clan hook
    recruit.muted_until = new Date(Date.now() + 60_000);
    const geoCount = messages.get('bot_geometry')!.length;
    ok(!say(recruit, '/muted words') && recruit.chatMessage === null, 'muted players cannot clan chat (nor chat publicly)');
    await clanChatDrained();
    ok(messages.get('bot_geometry')!.length === geoCount, 'muted line delivered to nobody');
    recruit.muted_until = null;
    // non-member
    say(outsider, '/hello');
    ok(/not in a clan/.test(lastMsg(outsider)) && outsider.chatMessage === null, `non-member "/" line is not public: ${lastMsg(outsider)}`);
    // rank change, logout/login (with notices), kick
    say(tester, '/clan rank clan member corporal');
    clanTick(tester);
    ok(/Corporal/.test(tab(tester, 'ranks')), 'rank change updates the tab');
    say(tester, '/clan set notices on');
    recruit.unlink(); // logged out: gone from the player loop
    World.currentTick++;
    clanTick(tester);
    ok(tab(tester, 'online') === 'Online: 2' && /@red@Corporal/.test(tab(tester, 'ranks')), `logout: offline member listed in red (${tab(tester, 'ranks')})`);
    ok(lastMsg(geometry) === '[Stud Unit] Clan Member has logged out.', `logout notice: ${lastMsg(geometry)}`);
    World.playerLoop.add(BigInt(recruit.slot), recruit);
    World.currentTick++;
    clanTick(recruit);
    clanTick(tester);
    ok(tab(tester, 'online') === 'Online: 3' && lastMsg(tester) === '[Stud Unit] Clan Member has logged in.', 'login: tab and notice');
    recruit.tabs[3] = Component.getId('inventory'); // login.rs2 has set the ordinary tabs
    recruit.tabs[CLAN_TAB] = -1; // a script reset the side tabs
    clanTick(recruit);
    ok(recruit.tabs[CLAN_TAB] === Component.getId('clan_tab'), 'tab restored after a tab reset');
    say(tester, '/clan kick clan member');
    clanTick(tester);
    ok(recruit.tabs[CLAN_TAB] === Component.getId('clan_tab') && tab(recruit, 'title') === 'Not in a clan' && tabState(recruit) === null && tab(tester, 'members') === 'Members: 2', 'kick turns the kicked player\'s tab into the help view and updates the roster');
    say(tester, '/clan set notices off');
    // flag off: "/" lines are ordinary chat again, the tab goes away
    process.env.CLAN_CHAT_ENABLED = 'false';
    quiet(geometry);
    say(geometry, '/plain chat');
    ok(geometry.chatMessage !== null, 'CLAN_CHAT_ENABLED=false: "/" lines are upstream public chat');
    clanTick(geometry);
    ok(geometry.tabs[CLAN_TAB] === -1, 'CLAN_CHAT_ENABLED=false: no clan tab');
    process.env.CLAN_CHAT_ENABLED = 'true';
    outsider.x -= 40;

    // ---- leave / rejoin cooldown via chat
    say(geometry, '/clan leave');
    ok(!clanStore().member('bot_geometry'), 'left');
    say(tester, '/clan invite bot geometry');
    say(geometry, '/clan accept');
    ok(!clanStore().member('bot_geometry') && /24|hour|again/i.test(lastMsg(geometry)), `rejoin cooldown: ${lastMsg(geometry)}`);

    // ---- clan hiscores: a 1-member clan is listed nowhere but has a page
    clearClanHiscoresCache();
    const board = await handleClanHiscores(new URL('http://localhost/api/hiscores/clans'));
    ok(board && (await board.json()).rows.length === 0, 'clans below 3 members are not ranked');
    const pageRes = await handleClanHiscores(new URL('http://localhost/hiscores/clan/stud%20unit'));
    ok(pageRes && (await pageRes.text()).includes('Not ranked yet'), 'clan page explains the minimum');

    // ---- flag off: upstream behaviour
    process.env.CLAN_STORAGE_ENABLED = 'false';
    say(outsider, '/clan create Nope');
    ok(clanStore().clanByName('nope') === undefined && outsider.chatMessage !== null, 'flag off: /clan is ordinary chat');
    openBank(tester, west!);
    ok(click(tester, CLAN_BANK_BUTTON_ID) && tester.modalMain === Component.getId('bank_main'), 'flag off: the (hidden) button does nothing');
    console.log(`PASS clan integration: ${passed} checks`);
} catch (error) {
    console.error(error);
    console.error(`FAIL after ${passed} passing checks`);
    process.exitCode = 1;
} finally {
    rmSync(dir, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
}
