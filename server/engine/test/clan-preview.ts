// Render the bank and the clan screens with the real client drawing code (packed interfaces,
// real sprites and fonts), so their layouts can be compared side by side. Temp ledger only.
// Run from server/engine after a pack build: bun test/clan-preview.ts [output-directory]
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { Jimp } from 'jimp';
import { strict as assert } from 'node:assert';
const temp = mkdtempSync(join(tmpdir(), 'clan-preview-'));
process.env.GE_DATABASE = join(temp, 'market.sqlite');
process.env.CLAN_STORAGE_ENABLED = 'true';
process.env.CLAN_CHAT_ENABLED = 'true';
const out = resolve(process.argv[2] ?? '../../screenshots/clan');
mkdirSync(out, { recursive: true });
const { default: World } = await import('../src/engine/World.js');
const { default: Component } = await import('../src/cache/config/Component.js');
const { default: InvType } = await import('../src/cache/config/InvType.js');
const { default: ObjType } = await import('../src/cache/config/ObjType.js');
const { default: Packet } = await import('../src/io/Packet.js');
const { PlayerLoading } = await import('../src/engine/entity/PlayerLoading.js');
const { openClanStorage, clanButton } = await import('../src/engine/clan/ClanStorage.js');
const { clanTick } = await import('../src/engine/clan/ClanHooks.js');
const { clanStore } = await import('../src/engine/clan/ClanLedger.js');
const { playerAccount } = await import('../src/engine/clan/ClanAccount.js');
const { default: UpdateInvFull } = await import('../src/network/game/server/model/UpdateInvFull.js');
try {
    World.reload();
    const clientRoot = new URL('../../webclient/src/', import.meta.url);
    await import(new URL('lite/dom-shim.ts', clientRoot).href);
    const { ItemViewer } = await import(new URL('viewer/ItemViewer.ts', clientRoot).href);
    const viewer = new ItemViewer();
    viewer.initFromData(
        {
            config: readFileSync('data/pack/client/config'),
            textures: readFileSync('data/pack/client/textures'),
            versionlist: readFileSync('data/pack/client/versionlist'),
            ondemand: readFileSync('data/pack/ondemand.zip')
        },
        { lazyModels: true }
    );
    const { default: IfType } = await import(new URL('config/IfType.ts', clientRoot).href);
    const { default: JagFile } = await import(new URL('io/JagFile.ts', clientRoot).href);
    const { default: PixFont } = await import(new URL('graphics/PixFont.ts', clientRoot).href);
    const { default: Pix2D } = await import(new URL('graphics/Pix2D.ts', clientRoot).href);
    const { default: Pix3D } = await import(new URL('dash3d/Pix3D.ts', clientRoot).href);
    const { default: Pix8 } = await import(new URL('graphics/Pix8.ts', clientRoot).href);
    const { Client } = await import(new URL('client/Client.ts', clientRoot).href);
    const jag = (name: string) => new JagFile(readFileSync(`data/pack/client/${name}`));
    const title = jag('title');
    const fonts = ['p11_full', 'p12_full', 'b12_full', 'q8_full'].map((name, i) => PixFont.depack(title, name, i === 3));
    IfType.init(jag('interface'), jag('media'), fonts);
    const client = Object.create(Client.prototype);
    Object.assign(client, { p11: fonts[0], overMainComId: -1, overSideComId: -1, overChatComId: -1, objDragArea: 0, selectedArea: 0, var: new Array(2000).fill(0), varCache: new Array(2000).fill(0) });
    const players: any[] = [];
    const load = (name: string) => {
        const p = PlayerLoading.load(name, new Packet(new Uint8Array()), null);
        p.x = 3185;
        p.z = 3436;
        p.slot = players.length + 1;
        World.players[p.slot] = p;
        World.playerLoop.add(BigInt(p.slot), p);
        players.push(p);
        p.write = (message: any) => {
            const c = IfType.list[message.component];
            if (message.component === undefined || !c) return;
            switch (message.constructor.name) {
                case 'IfSetText':
                    c.text = message.text;
                    break;
                case 'IfSetHide':
                    c.hide = message.hidden;
                    break;
                case 'UpdateInvFull':
                    c.linkObjType.fill(0);
                    c.linkObjNumber.fill(0);
                    message.inv.items.forEach((item: any, i: number) => {
                        if (item && i < c.linkObjType.length) {
                            c.linkObjType[i] = item.id + 1;
                            c.linkObjNumber[i] = item.count;
                        }
                    });
                    break;
            }
        };
        return p;
    };
    const png = async (pixels: Int32Array, width: number, height: number, name: string) => {
        const rgba = Buffer.alloc(pixels.length * 4);
        pixels.forEach((rgb: number, i: number) => {
            rgba[i * 4] = (rgb >> 16) & 255;
            rgba[i * 4 + 1] = (rgb >> 8) & 255;
            rgba[i * 4 + 2] = rgb & 255;
            rgba[i * 4 + 3] = 255;
        });
        await new Jimp({ width, height, data: rgba }).write(join(out, name + '.png') as `${string}.png`);
    };
    // Main screen + backpack side panel, the layout a player sees (no 3D scene behind).
    const screen = async (main: string, side: string, name: string) => {
        const width = 512 + 18 + 190;
        const pixels = new Int32Array(width * 334);
        pixels.fill(0x3e3529);
        Pix2D.setPixels(pixels, width, 334);
        Pix3D.setRenderClipping();
        client.drawInterface(IfType.list[Component.getId(main)], 0, 0, 0);
        client.drawInterface(IfType.list[Component.getId(side)], 530, 36, 0);
        await png(pixels, width, 334, name);
    };
    const sidebar = async (iface: number, name: string) => {
        const pixels = new Int32Array(190 * 261);
        pixels.fill(0x3e3529);
        Pix2D.setPixels(pixels, 190, 261);
        Pix3D.setRenderClipping();
        client.drawInterface(IfType.list[iface], 0, 0, 0);
        await png(pixels, 190, 261, name);
    };

    const owner = load('clan_founder');
    const a = load('bot_tester');
    const b = load('bot_geometry');
    const store = clanStore();
    store.create('clan_founder', 'Stud Unit');
    for (const [who, rank] of [
        ['bot_tester', 5],
        ['bot_geometry', 3]
    ] as const) {
        store.invite('clan_founder', who);
        store.accept(who);
        store.trust('clan_founder', who);
        store.setRank('clan_founder', who, rank);
    }
    for (const name of ['member_one', 'member_two', 'clan_member', 'member_three', 'member_four']) {
        store.invite('clan_founder', name);
        store.accept(name);
    }
    const inv = InvType.getId('inv');
    const items = ['coins', 'lobster', 'logs', 'iron_ore', 'coal', 'rune_platelegs', 'swordfish', 'oak_logs', 'mithril_bar', 'lawrune', 'naturerune', 'bones', 'cow_hide'];
    const ids = items.map(n => ObjType.getId(n));
    // Storage rows written directly (display fixture only; deposits are covered by clan-integration.ts).
    const clanId = store.member('clan_founder')!.clan_id;
    ids.slice(0, 11).forEach((id, i) => store.db.query('INSERT INTO clan_item(clan_id,item,count,seq) VALUES(?,?,?,?)').run(clanId, id, i === 0 ? 1_250_000 : 40 + i * 17, i + 1));
    store.db.query('UPDATE clan SET revision=revision+1 WHERE id=?').run(clanId);
    for (const [i, id] of ids.entries()) owner.invAdd(inv, id, ObjType.get(id).stackable ? 25 + i : 1);
    // Backpack as the side panel shows it (bank_side and clan_storage_side read the same inv).
    for (const side of ['bank_side:inv', 'clan_storage_side:inv']) owner.write(new UpdateInvFull(Component.getId(side), owner.getInventory(inv)!));

    // The real bank screen: bank inv filled with a few items.
    const bankInv = owner.getInventory(InvType.getId('bank'))!;
    ids.slice(0, 11).forEach((id, i) => bankInv.add(id, i === 0 ? 1_250_000 : 40 + i * 17));
    owner.write(new UpdateInvFull(Component.getId('bank_main:inv'), bankInv));
    // A clan member's bank screen shows the Clan storage button (hidden for everyone else).
    IfType.list[Component.getId('bank_main:clan_storage_layer')].hide = false;
    await screen('bank_main', 'bank_side', 'bank');

    assert(openClanStorage(owner));
    await screen('clan_storage', 'clan_storage_side', 'clan-storage');
    clanButton(owner, Component.getId('clan_storage:mode'));
    await screen('clan_storage', 'clan_storage_side', 'clan-storage-note');
    // A new Recruit sees the status line (new-member wait) under the title.
    const raven = load('clan_member');
    raven.write = owner.write;
    assert(openClanStorage(raven));
    await screen('clan_storage', 'clan_storage_side', 'clan-storage-new-member');

    // Clan tab with two members online.
    for (const p of [owner, a, b]) clanTick(p);
    assert.equal(owner.tabs[7], Component.getId('clan_tab'));
    await sidebar(Component.getId('clan_tab'), 'clan-tab');
    await sidebar(Component.getId('friends'), 'friends-tab');

    // The bottom-right of the game frame as the client draws it: sidebar background pieces, the open
    // tab's interface, the bottom tab row (Client.ts draw order: backbase2, the open tab's red stone,
    // then side icons 7-12; slot 7 has none, its icon is in backbase2 itself).
    const media = jag('media');
    const piece = (name: string, flip?: 'v') => {
        const s = Pix8.depack(media, name, 0);
        if (flip === 'v') s.vflip();
        return s;
    };
    const icons = Array.from({ length: 13 }, (_, i) => Pix8.depack(media, 'sideicons', i));
    const frame = async (iface: number, active: number, name: string) => {
        const pixels = new Int32Array(765 * 503);
        Pix2D.setPixels(pixels, 765, 503);
        for (const [n, x, y] of [
            ['backvmid2', 516, 205],
            ['backright2', 743, 205],
            ['backvmid3', 496, 357],
            ['backhmid1', 516, 160],
            ['invback', 553, 205]
        ] as const)
            piece(n).plotSprite(x, y);
        Pix3D.setRenderClipping();
        if (iface >= 0) client.drawInterface(IfType.list[iface], 553, 205, 0);
        const bar = new Int32Array(269 * 37);
        Pix2D.setPixels(bar, 269, 37);
        piece('backbase2').plotSprite(0, 0);
        if (active === 7) piece('redstone1', 'v').plotSprite(42, 0);
        if (active === 8) piece('redstone2', 'v').plotSprite(74, 0);
        [
            [74, 2],
            [102, 3],
            [137, 4],
            [174, 2],
            [201, 2],
            [226, 2]
        ].forEach(([x, y], i) => icons[7 + i].plotSprite(x, y));
        for (let y = 0; y < 37; y++) pixels.set(bar.subarray(y * 269, y * 269 + 269), (466 + y) * 765 + 496);
        const crop = new Int32Array(269 * 298);
        for (let y = 0; y < 298; y++) crop.set(pixels.subarray((205 + y) * 765 + 496, (205 + y) * 765 + 765), y * 269);
        await png(crop, 269, 298, name);
    };
    await frame(Component.getId('clan_tab'), 7, 'sidebar-member-clan-open');
    await frame(Component.getId('friends'), 8, 'sidebar-member-friends-open');
    // A player outside any clan: the same tab, how-to view.
    const outsider = load('outsider');
    outsider.tabs[3] = Component.getId('inventory');
    clanTick(outsider);
    assert.equal(outsider.tabs[7], Component.getId('clan_tab'));
    await frame(Component.getId('clan_tab'), 7, 'sidebar-nonmember-clan-open');
    await frame(Component.getId('friends'), 8, 'sidebar-nonmember-friends-open');
    console.log('Native client renders written to ' + out);
} finally {
    clanStore().db?.close?.();
    rmSync(temp, { recursive: true, force: true });
    await Promise.all([World.loginThread.terminate(), World.friendThread.terminate(), World.loggerThread.terminate()]);
}
