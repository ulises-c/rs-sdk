// Move an OFFLINE player by patching the coord in their save, e.g. to rescue a
// character persisted inside an agility obstacle.
//
// Usage (run on the box):
//   bun relocate-player.ts <username> <x> <z> [level] [--wait] [--inspect] [--players-dir=data/players/main] [--db=data/market.sqlite] [--web=http://localhost:8080]
//
// PlayerLoading.load prefers the GE ledger checkpoint (market.sqlite `accounts`)
// over the .sav, so both are patched. As with grant-bank-item.ts, the world's
// in-memory character wins while the player is online, so --wait polls
// /playerpositions until they leave, waits for the logout save to go quiet,
// patches, then re-verifies for a while in case a late save lands.
//
// x/z/level sit at fixed offsets (4, 6, 8) in every save version; the trailing
// 4 bytes are Packet.getcrc over the rest.
import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

const SAV_MAGIC = 0x2004;
const QUIET_MS = 15_000;
const VERIFY_MS = 90_000;

const flags = new Map<string, string>();
const positional: string[] = [];
for (const a of process.argv.slice(2)) {
    if (a.startsWith('--')) {
        const [k, v] = a.slice(2).split('=');
        flags.set(k, v ?? 'true');
    } else {
        positional.push(a);
    }
}
const [usernameArg, xArg, zArg, levelArg] = positional;
if (!usernameArg || !xArg || !zArg) {
    console.error('usage: relocate-player.ts <username> <x> <z> [level] [--wait] [--inspect] [--players-dir=...] [--db=...] [--web=...]');
    process.exit(1);
}
const username = usernameArg.toLowerCase().replace(/[^a-z0-9]/g, '_');
const target = { x: parseInt(xArg, 10), z: parseInt(zArg, 10), level: parseInt(levelArg ?? '0', 10) };
const wait = flags.get('wait') === 'true';
const savPath = join(flags.get('players-dir') ?? 'data/players/main', `${username}.sav`);
const dbPath = flags.get('db') ?? process.env.GE_DATABASE ?? 'data/market.sqlite';
const web = flags.get('web') ?? 'http://localhost:8080';

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
        let r = i;
        for (let b = 0; b < 8; b++) r = (r & 1) === 1 ? (r >>> 1) ^ 0xedb88320 : r >>> 1;
        t[i] = r;
    }
    return t;
})();
function crc32(src: Uint8Array, len: number): number {
    let crc = 0xffffffff;
    for (let i = 0; i < len; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ src[i]) & 0xff];
    return ~crc;
}

function coordOf(buf: Uint8Array) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (view.getUint16(0) !== SAV_MAGIC) throw new Error('not a save file');
    if (view.getInt32(buf.length - 4) !== crc32(buf, buf.length - 4)) throw new Error('CRC mismatch on existing save');
    return { version: view.getUint16(2), x: view.getUint16(4), z: view.getUint16(6), level: buf[8] };
}
const atTarget = (buf: Uint8Array) => {
    const c = coordOf(buf);
    return c.x === target.x && c.z === target.z && c.level === target.level;
};
function patch(buf: Uint8Array): Uint8Array {
    coordOf(buf);
    const out = new Uint8Array(buf);
    const view = new DataView(out.buffer);
    view.setUint16(4, target.x);
    view.setUint16(6, target.z);
    out[8] = target.level;
    view.setInt32(out.length - 4, crc32(out, out.length - 4));
    coordOf(out);
    return out;
}

const db = existsSync(dbPath) ? new Database(dbPath, { strict: true }) : null;
db?.exec('PRAGMA busy_timeout=5000');
const readLedger = () => db?.query<{ save: Uint8Array }, [string]>('SELECT save FROM accounts WHERE owner=?').get(username)?.save;
const readSav = () => new Uint8Array(readFileSync(savPath));
function writeSav(bytes: Uint8Array) {
    writeFileSync(`${savPath}.tmp`, bytes);
    renameSync(`${savPath}.tmp`, savPath);
}

async function isOnline(): Promise<boolean | null> {
    try {
        const players = (await (await fetch(`${web}/playerpositions`)).json()) as { name: string }[];
        return players.some(p => p.name.toLowerCase().replace(/[^a-z0-9]/g, '_') === username);
    } catch (e) {
        log('playerpositions fetch failed:', (e as Error).message);
        return null;
    }
}

/** Patch whichever copies aren't at the target yet. */
function apply() {
    const sav = readSav();
    if (!atTarget(sav)) {
        writeSav(patch(sav));
        log(`patched ${savPath}`);
    }
    const ledger = readLedger();
    if (ledger && !atTarget(ledger)) {
        db!.query('UPDATE accounts SET save=? WHERE owner=?').run(patch(ledger), username);
        log(`patched ${dbPath} accounts row`);
    }
}
const done = () => atTarget(readSav()) && (() => { const l = readLedger(); return !l || atTarget(l); })();

async function main(): Promise<void> {
    if (!existsSync(savPath)) throw new Error(`${savPath} does not exist`);
    const ledger = readLedger();
    log(`sav ${JSON.stringify(coordOf(readSav()))}, ledger ${ledger ? JSON.stringify(coordOf(ledger)) : 'absent'}, target ${JSON.stringify(target)}, online=${await isOnline()}`);
    if (flags.get('inspect') === 'true') return;

    for (;;) {
        const online = await isOnline();
        if (online === false) break;
        if (!wait) throw new Error(online ? `${username} is online; rerun with --wait` : 'cannot reach web server');
        await sleep(10_000);
    }
    log(`${username} is offline`);

    let mtime = statSync(savPath).mtimeMs;
    let quietSince = Date.now();
    while (Date.now() - quietSince < QUIET_MS) {
        await sleep(1000);
        const now = statSync(savPath).mtimeMs;
        if (now !== mtime) { mtime = now; quietSince = Date.now(); log('save file changed, waiting for quiet'); }
    }

    if (await isOnline()) { log('came back online before patch; restarting wait'); return main(); }
    apply();

    const until = Date.now() + VERIFY_MS;
    while (Date.now() < until) {
        await sleep(3000);
        if (done()) continue;
        if (await isOnline()) { log('player logged in before the patch stuck; restarting wait'); return main(); }
        log('save was overwritten; re-patching');
        apply();
    }
    log(`done: ${username} saved at ${JSON.stringify(coordOf(readSav()))}`);
}

main().catch(e => { log('FAILED:', e.message); process.exit(1); });
