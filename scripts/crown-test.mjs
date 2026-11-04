/** Which maps take #1: each play held against the board's top, as the game ranks plays. */
import { build } from 'esbuild';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolveGameRoot } from './resolve-game.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This repository's root, so nothing depends on where it is checked out. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const game = resolveGameRoot();
const { sharedSourcePlugin, tsExtensionPlugin } = await import('@oss-idle/addon-sdk/build');

const dir = join(REPO_ROOT, '.crowntest');
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'e.ts'), `export * from '../src/engine/crown.js';\n`);
await build({
	entryPoints: [join(dir, 'e.ts')], outfile: join(dir, 'b.mjs'), bundle: true,
	format: 'esm', platform: 'node', target: 'es2022', logLevel: 'error',
	plugins: [sharedSourcePlugin(join(game.root, 'packages/shared/src')), tsExtensionPlugin()],
	absWorkingDir: REPO_ROOT,
});
const m = await import(pathToFileURL(join(dir, 'b.mjs')).href);

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? pass++ : (fail++, console.log('  FAIL:', n, x)); };

const top = { characterId: 9, score: 990_000, accuracy: 0.98, rate: 1.2 };
check('a higher score takes #1', m.beats({ score: 990_001, accuracy: 0.9 }, top));
check('the same score with better accuracy takes #1', m.beats({ score: 990_000, accuracy: 0.981 }, top));
check('a tie stays with the earlier play', !m.beats({ score: 990_000, accuracy: 0.98 }, top));
check('a lower score does not', !m.beats({ score: 989_999, accuracy: 1 }, top));
check('an empty board is anyone\'s', m.beats({ score: 1, accuracy: 0.1 }, undefined));

const plays = [
	{ score: 995_000, accuracy: 0.985, passed: true },
	{ score: 985_000, accuracy: 0.97, passed: true },
	{ score: 999_000, accuracy: 0.99, passed: false },
];
const row = m.rowOf(1, top, 7, plays);
check('a failed play never counts', row.wins === 1 && row.passes === 2 && row.runs === 3, JSON.stringify(row));
check('the best play is the best passed one', row.bestScore === 995_000 && row.bestAccuracy === 0.985);
check('a board this character tops is its own', m.rowOf(1, { ...top, characterId: 7 }, 7, plays).yours);

// three maps: one beaten, one empty, one gone from the server
const boards = { 1: top, 2: undefined, 4: { ...top, characterId: 7 } };
const asked = [];
const crown = await m.findCrowns({
	state: { generation: 1, skills: {} },
	characterId: 7,
	beatmapIds: [1, 2, 3, 4],
	runs: 2,
	minutes: 30,
	mapPlays: () => 0,
}, async body => {
	asked.push(body);
	if (body.beatmap_id === 3) throw Object.assign(new Error('not live'), { status: 404 });
	return { score: 991_000, accuracy: 0.95, passed: true };
}, async id => boards[id], { pace: call => call() });
check('every play is at x1 with no mods', asked.every(body => body.rate === 1 && body.mods.length === 0));
check('a map gone from the server is skipped, not fatal', !crown.error && crown.rows.length === 3, JSON.stringify(crown));
check('both maps are taken in every play', crown.rows.filter(row => !row.yours).every(row => row.wins === 2));
check('a map already yours is not played', !asked.some(body => body.beatmap_id === 4) && crown.rows.find(row => row.beatmapId === 4)?.yours);

rmSync(dir, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
