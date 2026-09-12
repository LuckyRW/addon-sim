/**
 * A re-scan must see the character as it is now.
 *
 * The client writes skill levels back to the `character` row after every play,
 * so the bridge must read through to the database each time rather than caching
 * a snapshot - otherwise a sweep run after levelling would simulate the old
 * character.
 */
import { createRequire } from 'node:module';
import { resolveGameRoot } from './resolve-game.mjs';
import { build } from 'esbuild';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This repository's root, so nothing depends on where it is checked out. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');


const game = resolveGameRoot();
const require = createRequire(join(game.root, 'package.json'));
const SQL = await require('sql.js')();
const db = new SQL.Database();

db.run(`
CREATE TABLE character (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, speed INTEGER NOT NULL DEFAULT 0, speedXP INTEGER NOT NULL DEFAULT 0,
  speedUpgrades INTEGER NOT NULL DEFAULT 0, speedOverdrive REAL NOT NULL DEFAULT 0,
  speedPrestige INTEGER NOT NULL DEFAULT 0,
  overallLevel INTEGER NOT NULL DEFAULT 0, overallTotalXp INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 1, memoryResetAt INTEGER NOT NULL DEFAULT 0,
  local INTEGER NOT NULL DEFAULT 0, current INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE score (
  id INTEGER PRIMARY KEY AUTOINCREMENT, characterId INTEGER, beatmapId INTEGER, playedAt INTEGER
);
-- a guest lineage character (current=1) and the signed-in account character
INSERT INTO character (id, name, speed, overallLevel, local, current) VALUES (-1, 'Guest', 5, 5, 1, 1);
INSERT INTO character (id, name, speed, overallLevel, local, current) VALUES (42, 'Adri', 90, 90, 0, 0);
`);

globalThis.window = { db: { read: async fn => fn(db), write: async fn => fn(db) } };

const dir = join(REPO_ROOT, '.chartest');
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'e.ts'), `
export { gameCharacter } from '@osu-idle/addon-sdk';
export { playCountsSince, recentPlayCounts } from '@osu-idle/addon-sdk';
`);
await build({
	entryPoints: [join(dir, 'e.ts')], outfile: join(dir, 'b.mjs'), bundle: true,
	format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
	conditions: ['import', 'default'],
	absWorkingDir: REPO_ROOT,
});
const { gameCharacter, playCountsSince } = await import(pathToFileURL(join(dir, 'b.mjs')).href);




let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? pass++ : (fail++, console.log('  FAIL:', n, x)); };

// With no plays recorded, detection falls back to the account character.
let live = await gameCharacter.live();
check('prefers the account character over the guest', live.id === 42, `got ${live.id}`);
check('reads its level', live.speed === 90, `${live.speed}`);

// The most recent play names who is playing - here, the guest.
db.run('INSERT INTO score (characterId, beatmapId, playedAt) VALUES (-1, 1, 1000)');
live = await gameCharacter.live();
check('latest play overrides the fallback', live.id === -1, `got ${live.id}`);

// ...and switching back is picked up.
db.run('INSERT INTO score (characterId, beatmapId, playedAt) VALUES (42, 1, 2000)');
live = await gameCharacter.live();
check('follows an account switch', live.id === 42, `got ${live.id}`);

// The point of the test: levels gained between scans must be visible.
db.run('UPDATE character SET speed = 97, speedXP = 1234, overallLevel = 97 WHERE id = 42');
live = await gameCharacter.live();
check('sees levels gained since the last read', live.speed === 97, `${live.speed}`);
check('sees xp gained since the last read', live.speedXP === 1234, `${live.speedXP}`);

const byId = await gameCharacter.byId(42);
check('byId is fresh too', byId.speed === 97, `${byId.speed}`);

const list = await gameCharacter.list();
check('list reflects the new level', list.find(c => c.id === 42).overallLevel === 97);
check('list holds both characters', list.length === 2);

// guest() is specifically the local lineage, not whoever is playing
const guest = await gameCharacter.guest();
check('guest() returns the local character', guest.id === -1, `got ${guest.id}`);

// Memory trains on how often a map has been played since it was last
// prestiged - the counts a sweep has to seed it with.
db.run(`INSERT INTO score (characterId, beatmapId, playedAt) VALUES
	(42, 100, 500), (42, 100, 1500), (42, 100, 2500),
	(42, 200, 2500), (-1, 300, 2500)`);

let counts = await playCountsSince(42, 0);
check('counts plays per map', counts[100] === 3, JSON.stringify(counts));
check('counts a second map separately', counts[200] === 1);
check('ignores another character', counts[300] === undefined);
check('a never-played map is absent', counts[999] === undefined);

// memoryResetAt: plays before a prestige no longer train memory
counts = await playCountsSince(42, 2000);
check('respects memoryResetAt', counts[100] === 1, JSON.stringify(counts));

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
