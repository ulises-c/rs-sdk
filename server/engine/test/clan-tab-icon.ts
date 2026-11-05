// The clan tab icon. This client revision loads 13 side icons and draws none at sidebar slot 7, so
// the icon is painted into the sidebar background instead (content/sprites/back.png, from which the
// pack tool cuts `backbase2`): no client code. The source icon lives in a clan-owned file; this
// script stamps it into back.png and checks that it is there.
//   bun test/clan-tab-icon.ts           # (from server/engine) stamp the icon into back.png
//   bun test/clan-tab-icon.ts --check   # exit 1 when back.png lacks the icon
// Placement: inside the slot-7 tab stone, backbase2 (496,466) + (46,4). Every icon pixel lies under
// the opaque part of `redstone1v`, which the client draws over the background when the tab is open,
// so the open tab shows the plain red stone (like an icon-less tab) and nothing peeks out of it.
import { fileURLToPath } from 'node:url';
import { Jimp } from 'jimp';
import JagFile from '../../webclient/src/io/JagFile.js';
import Pix8 from '../../webclient/src/graphics/Pix8.js';

export const ICON_PATH = fileURLToPath(new URL('../../content/scripts/clan/sprites/clan_tab_icon.png', import.meta.url));
export const BACK_PATH = fileURLToPath(new URL('../../content/sprites/back.png', import.meta.url));
/** backbase2's origin in back.png (tools/pack/sprite/media.ts BACK_PIECES). */
export const BACKBASE2 = { x: 496, y: 466 } as const;
/** Top-left of the 30x30 icon frame, relative to backbase2. */
export const ICON_AT = { x: 46, y: 4 } as const;

export type IconPixel = { x: number; y: number; rgb: number };

/** Opaque icon pixels, in backbase2 coordinates. */
export async function iconPixels(): Promise<IconPixel[]> {
    const icon = await Jimp.read(ICON_PATH);
    const out: IconPixel[] = [];
    const { width, height, data } = icon.bitmap;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            if (data[i + 3] === 0) continue;
            out.push({ x: ICON_AT.x + x, y: ICON_AT.y + y, rgb: (data[i] << 16) | (data[i + 1] << 8) | data[i + 2] });
        }
    }
    return out;
}

/** Icon pixels that back.png does not carry (0 = stamped). */
export async function backMismatches(): Promise<IconPixel[]> {
    const back = await Jimp.read(BACK_PATH);
    const { width, data } = back.bitmap;
    return (await iconPixels()).filter(p => {
        const i = ((BACKBASE2.y + p.y) * width + BACKBASE2.x + p.x) * 4;
        return ((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]) !== p.rgb || data[i + 3] !== 255;
    });
}

/** Icon pixels that packed backbase2 does not carry (decoded with the client's own sprite reader). */
export async function packedMismatches(media: Uint8Array) {
    const sprite = Pix8.depack(new JagFile(media), 'backbase2', 0);
    return (await iconPixels()).filter(p => {
        const x = p.x - sprite.xof;
        const y = p.y - sprite.yof;
        const index = sprite.data[y * sprite.wi + x] & 0xff;
        return index === 0 || sprite.bpal[index] !== p.rgb;
    });
}

export async function stampIcon(): Promise<number> {
    const back = await Jimp.read(BACK_PATH);
    const { width, data } = back.bitmap;
    const pixels = await iconPixels();
    for (const p of pixels) {
        const i = ((BACKBASE2.y + p.y) * width + BACKBASE2.x + p.x) * 4;
        data[i] = (p.rgb >> 16) & 255;
        data[i + 1] = (p.rgb >> 8) & 255;
        data[i + 2] = p.rgb & 255;
        data[i + 3] = 255;
    }
    await back.write(BACK_PATH as `${string}.png`);
    return pixels.length;
}

if (import.meta.main) {
    if (process.argv.includes('--check')) {
        const bad = await backMismatches();
        console.log(bad.length ? `back.png lacks ${bad.length} clan tab icon pixels` : 'back.png carries the clan tab icon');
        process.exit(bad.length ? 1 : 0);
    }
    console.log(`stamped ${await stampIcon()} icon pixels into ${BACK_PATH}`);
}
