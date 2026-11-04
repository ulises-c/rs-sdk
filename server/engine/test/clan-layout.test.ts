// The clan screens are copies of the bank and friends-list layouts (owner: "exactly the same style
// as the bank UI"). Compares the .if sources: every piece of the bank's frame, its grid, fonts and
// colours must be in clan_storage at the same place; only the listed clan differences may differ.
//   bun test server/engine/test/clan-layout.test.ts
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const root = new URL('../../content/', import.meta.url);
type Com = Record<string, string>;
function parse(path: string): Map<string, Com> {
    const out = new Map<string, Com>();
    let cur: Com | null = null;
    for (const line of readFileSync(new URL(path, root), 'utf8').split('\n')) {
        const m = /^\[(.+)\]$/.exec(line);
        if (m) out.set(m[1]!, (cur = {}));
        else if (cur && line.includes('=')) cur[line.slice(0, line.indexOf('='))] = line.slice(line.indexOf('=') + 1);
    }
    return out;
}
const bank = parse('scripts/interface_bank/interfaces/bank_main.if');
const clan = parse('scripts/clan/interfaces/clan_storage.if');
const geometry = (c: Com) => [c.type, c.x, c.y, c.width, c.height, c.graphic ?? '', c.font ?? '', c.colour ?? '', c.shadowed ?? ''].join('|');

describe('clan storage = bank layout', () => {
    test('every bank frame graphic and layer is copied unchanged', () => {
        for (const [name, c] of bank) {
            if (!/^com_\d+$/.test(name) || c.type !== 'graphic' || c.buttontype) continue;
            expect(geometry(clan.get(name) ?? {}), name).toBe(geometry(c));
        }
        expect(geometry(clan.get('com_88')!)).toBe(geometry(bank.get('com_88')!));
    });
    test('title, close, scroll area and item grid keep the bank geometry and fonts', () => {
        const same = (a: string, b: string, keys: string[]) => {
            for (const k of keys) expect(clan.get(b)![k], `${b}.${k}`).toBe(bank.get(a)![k]);
        };
        same('com_90', 'title', ['type', 'y', 'height', 'font', 'colour', 'shadowed']);
        same('com_91', 'close', ['type', 'x', 'y', 'width', 'height', 'buttontype', 'font', 'text', 'colour', 'overcolour']);
        same('com_92', 'items', ['type', 'x', 'y', 'width', 'height']);
        same('inv', 'inv', ['type', 'x', 'y', 'width', 'margin', 'option1', 'option2', 'option3', 'option4', 'option5']);
        expect(clan.get('inv')!.layer).toBe('items');
        // The title stays centred on the bank title's centre line.
        const bt = bank.get('com_90')!, ct = clan.get('title')!;
        expect(+ct.x + +ct.width / 2).toBe(+bt.x + Math.floor(+bt.width / 2));
    });
    test('the four bottom boxes and their labels sit where the bank puts them', () => {
        for (const [a, b] of [['com_93', 'mode'], ['com_94', 'mode_item'], ['com_99', 'deposit_inv'], ['com_100', 'bank']]) {
            for (const k of ['x', 'y', 'width', 'height', 'graphic']) expect(clan.get(b)![k], `${b}.${k}`).toBe(bank.get(a)![k]);
        }
        for (const [a, b] of [['com_93', 'mode_on_box'], ['com_94', 'mode_item_on_box']]) expect(clan.get(b)!.graphic).toBe(bank.get(a)!.activegraphic);
        for (const n of ['com_95', 'com_96', 'com_98']) expect(geometry(clan.get(n)!)).toBe(geometry(bank.get(n)!));
        for (const n of ['capacity', 'deposit_inv_text', 'bank_text']) {
            expect(clan.get(n)!.font, n).toBe('p12_full');
            expect(clan.get(n)!.colour, n).toBe('0xFF981F');
        }
    });
    test('no component added beyond the listed clan differences', () => {
        const extra = [...clan.keys()].filter(n => !bank.has(n));
        expect(extra.sort()).toEqual(
            ['agent_metadata', 'agent_state', 'bank', 'bank_text', 'capacity', 'close', 'deposit_inv', 'deposit_inv_text', 'items', 'mode', 'mode_item', 'mode_item_on', 'mode_item_on_box', 'mode_on', 'mode_on_box', 'rank', 'title'].sort()
        );
    });
});

describe('clan tab = friends-list frame', () => {
    const friends = parse('scripts/player/interfaces/friends.if');
    const tab = parse('scripts/clan/interfaces/clan_tab.if');
    test('frame graphics copied, list where the friends list is', () => {
        for (const [name, c] of friends) if (c.type === 'graphic' && !c.buttontype) expect(geometry(tab.get(name) ?? {}), name).toBe(geometry(c));
        const list = tab.get('list')!, fl = friends.get('com_0')!;
        for (const k of ['type', 'x', 'y', 'width', 'height']) expect(list[k]).toBe(fl[k]);
        expect(tab.get('title')!.font).toBe(friends.get('com_1')!.font);
        expect(tab.get('title')!.colour).toBe(friends.get('com_1')!.colour);
    });
});

describe('reserved interface ids', () => {
    const pack = new Map<string, number>(
        readFileSync(new URL('pack/interface.pack', root), 'utf8')
            .trim()
            .split('\n')
            .map(l => [l.slice(l.indexOf('=') + 1), Number(l.slice(0, l.indexOf('=')))])
    );
    const order = readFileSync(new URL('pack/interface.order', root), 'utf8').trim().split('\n').map(Number);
    test('every clan component has a reserved id listed once in interface.order, roots contiguous', () => {
        for (const [file, rootName] of [['scripts/clan/interfaces/clan_storage.if', 'clan_storage'], ['scripts/clan/interfaces/clan_storage_side.if', 'clan_storage_side'], ['scripts/clan/interfaces/clan_tab.if', 'clan_tab']] as const) {
            const ids = [rootName, ...[...parse(file).keys()].map(n => `${rootName}:${n}`)].map(n => pack.get(n));
            for (const id of ids) {
                expect(id, rootName).toBeGreaterThan(40753);
                expect(order.filter(o => o === id).length).toBe(1);
            }
            const at = order.indexOf(ids[0]!);
            expect(order.slice(at, at + ids.length)).toEqual(ids as number[]);
        }
        expect([...pack.keys()].filter(n => /^clan_storage:/.test(n)).every(n => parse('scripts/clan/interfaces/clan_storage.if').has(n.split(':')[1]!))).toBe(true);
    });
    test('existing clan ids kept (SDK constants)', () => {
        expect(pack.get('bank_main:clan_storage')).toBe(40754);
        expect(pack.get('clan_storage')).toBe(40755);
        expect(pack.get('clan_storage:inv')).toBe(40763);
        expect(pack.get('clan_storage:agent_state')).toBe(40770);
    });
});
