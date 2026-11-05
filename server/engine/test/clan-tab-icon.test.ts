// The clan tab icon painted into the sidebar background (see clan-tab-icon.ts) and the tab's
// not-in-a-clan view. The packed media check runs when a pack build exists (data/pack/client/media);
// `bun run test:clan:integration` always checks it.
//   bun test server/engine/test/clan-tab-icon.test.ts
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import { Jimp } from 'jimp';
import { clanTabHelp } from '../src/engine/clan/ClanTabContent.js';
import { BACK_PATH, backMismatches, iconPixels, packedMismatches } from './clan-tab-icon.js';

const MEDIA = fileURLToPath(new URL('../data/pack/client/media', import.meta.url));
const REDSTONE = fileURLToPath(new URL('../../content/sprites/redstone1.png', import.meta.url));

describe('clan tab icon', () => {
    test('back.png carries the icon (re-stamp: bun test/clan-tab-icon.ts)', async () => {
        expect((await iconPixels()).length).toBeGreaterThan(300);
        expect(await backMismatches()).toEqual([]);
    });

    test('it sits inside the slot-7 tab: click box and the red stone drawn when the tab is open', async () => {
        const stone = await Jimp.read(REDSTONE);
        const { width, height, data } = stone.bitmap;
        // The client draws redstone1 flipped vertically at backbase2 (42,0) for tab 7.
        const opaque = (x: number, y: number) => {
            const sx = x - 42;
            const sy = height - 1 - y;
            if (sx < 0 || sy < 0 || sx >= width || sy >= height) return false;
            const i = (sy * width + sx) * 4;
            return data[i + 3] !== 0 && !(data[i] === 255 && data[i + 1] === 0 && data[i + 2] === 255);
        };
        for (const p of await iconPixels()) {
            expect(p.x >= 44 && p.x <= 78 && p.y >= 0 && p.y < 37).toBe(true); // Client.ts: x 540-574, y 466-502
            expect(opaque(p.x, p.y)).toBe(true);
        }
    });

    test('back.png stays within one 255-colour palette (the pack tool would quantize it otherwise)', async () => {
        const back = await Jimp.read(BACK_PATH);
        const colours = new Set<number>();
        const d = back.bitmap.data;
        for (let i = 0; i < d.length; i += 4) colours.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
        expect(colours.size).toBeLessThan(255);
    });

    test.skipIf(!existsSync(MEDIA))('the packed media archive carries it in backbase2', async () => {
        expect(await packedMismatches(readFileSync(MEDIA))).toEqual([]);
    });
});

describe('clan tab for players outside a clan', () => {
    const help = clanTabHelp();
    test('says how to start and join a clan', () => {
        expect(help.title).toBe('Not in a clan');
        expect(help.names).toContain('/clan create NAME');
        expect(help.names).toContain('/clan accept NAME');
        expect(help.ranks).toBe('');
    });
    test('no bot state: state.clan stays null', () => {
        expect(help.agent_state).toBe('');
    });
    test('lines fit the list column (p12, 161 px: about 26 characters)', () => {
        for (const line of help.names.split('\\n')) expect(line.replace(/@[a-z]{3}@/g, '').length).toBeLessThanOrEqual(26);
    });
});
