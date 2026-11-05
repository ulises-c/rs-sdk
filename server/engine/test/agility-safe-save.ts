// A save taken while a player is mid-obstacle (autosave, another player's checkpoint,
// shutdown) must not persist the transient tile inside the obstacle.
import { strict as assert } from 'node:assert';
const { default: World } = await import('../src/engine/World.js');
const { default: LocType } = await import('../src/cache/config/LocType.js');
const { default: Packet } = await import('../src/io/Packet.js');
const { PlayerLoading } = await import('../src/engine/entity/PlayerLoading.js');
const { default: ScriptProvider } = await import('../src/engine/script/ScriptProvider.js');
const { default: ScriptRunner } = await import('../src/engine/script/ScriptRunner.js');
const { default: ServerTriggerType } = await import('../src/engine/script/ServerTriggerType.js');
const { PlayerStat } = await import('../src/engine/entity/PlayerStat.js');

World.reload();
(World as any).gameMap.init();
const pipe = LocType.getId('obstical_pipe2');
let loc = null;
for (let z = 3930; z < 3945 && !loc; z++) loc = World.getLoc(3004, z, 0, pipe);
assert(loc, 'Wilderness pipe exists');

const p = PlayerLoading.load('pipetester', new Packet(new Uint8Array()), null);
p.x = 3004; p.z = loc.z - 1; p.level = 0;
p.baseLevels[PlayerStat.AGILITY] = p.levels[PlayerStat.AGILITY] = 99;
World.playerLoop.add(1n, p);
const tick = () => {
    World.currentTick++;
    (World as any).processPlayers();
};
tick(); // settle on the entrance tile

const script = ScriptProvider.getByTrigger(ServerTriggerType.OPLOC1, pipe, -1)!;
p.executeScript(ScriptRunner.init(script, p, loc), true);
let sawInside = false;
for (let i = 0; i < 20 && p.activeScript; i++) {
    tick();
    if (p.delayed && p.z > loc.z) {
        sawInside = true;
        const restored = PlayerLoading.load('pipetester', new Packet(p.save(false)), null);
        assert.deepEqual([restored.x, restored.z, restored.level], [3004, loc.z - 1, 0], `mid-pipe save at ${p.x},${p.z} restores to the entrance`);
    }
}
assert(sawInside, 'Script moved the player into the pipe');
assert.equal(p.delayed, false);
const done = PlayerLoading.load('pipetester', new Packet(p.save(false)), null);
assert.deepEqual([done.x, done.z], [p.x, p.z], 'Completed obstacle saves the exit tile');
assert(p.z > loc.z + 9, 'Player exited the far side');
console.log('agility-safe-save ok', loc.z, p.x, p.z);
process.exit(0);
