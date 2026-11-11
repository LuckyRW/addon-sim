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
	return { score: 991_000, accuracy: 0.95, passed: true, strained_minutes: 1 };
}, async id => boards[id], { pace: call => call() });
check('every play is at x1 with no mods', asked.every(body => body.rate === 1 && body.mods.length === 0));
check('a map gone from the server is skipped, not fatal', !crown.error && crown.rows.length === 3, JSON.stringify(crown));
check('both maps are taken in every play', crown.rows.filter(row => !row.yours).every(row => row.wins === 2));
check('a map already yours is not played', !asked.some(body => body.beatmap_id === 4) && crown.rows.find(row => row.beatmapId === 4)?.yours);

// a peak playlist: heavy maps strain the character up from the peak's start until the next would leave it
const peakOf = m.peakPlaylist([], { startMinutes: 0, gear: 0, delaySec: 0, lengthSec: () => 120 }).peak;
const heavy = Array.from({ length: 200 }, (_, i) => ({ beatmapId: i + 1, strained: 2 }));
const built = m.peakPlaylist(heavy, { startMinutes: peakOf.from, gear: 0, delaySec: 30, lengthSec: () => 120 });
check('the peak is a window', peakOf.from < peakOf.to, JSON.stringify(peakOf));
check('heavy maps stop at the end of the peak', built.stopped === 'peak' && built.beatmapIds.length > 0 && built.minutes.every(x => x <= peakOf.to), JSON.stringify(built.minutes.slice(-3)));
const light = Array.from({ length: 50 }, (_, i) => ({ beatmapId: i + 1, strained: 0 }));
check('light maps cool off the peak and stop', m.peakPlaylist(light, { startMinutes: peakOf.from, gear: 0, delaySec: 30, lengthSec: () => 120 }).beatmapIds.length === 0);
const cold = m.peakPlaylist(heavy, { startMinutes: 0, gear: 0, delaySec: 30, lengthSec: () => 120 });
check('from cold, heavy maps warm up into the peak', cold.beatmapIds.length > built.beatmapIds.length && cold.minutes.at(-1) >= peakOf.from);
check('few maps: every one fits', m.peakPlaylist(heavy.slice(0, 2), { startMinutes: peakOf.from, gear: 0, delaySec: 30, lengthSec: () => 120 }).stopped === 'maps');
const toLimit = m.peakPlaylist(heavy, { startMinutes: peakOf.from, gear: 0, delaySec: 30, lengthSec: () => 120, stopAt: 250 });
check('a strain picked by hand goes past the peak and stops at it', toLimit.stopped === 'limit' && toLimit.beatmapIds.length > built.beatmapIds.length
	&& toLimit.minutes.every(x => x <= 250) && toLimit.minutes.at(-1) > peakOf.to, JSON.stringify(toLimit.minutes.slice(-2)));
check('light maps do not stop a strain limit: they rest under it', m.peakPlaylist(light, { startMinutes: 200, gear: 0, delaySec: 30, lengthSec: () => 120, stopAt: 250 }).stopped === 'maps');

{
	// x1 fails; x0.9 scores most and beats the top; x0.85 passes every play but scores less, so x0.8 is never asked
	const score = { 1: 0, 0.95: 600_000, 0.9: 800_000, 0.85: 700_000, 0.8: 650_000 };
	const rates = [];
	const slow = await m.findCrowns({ state: { generation: 1, skills: {} }, characterId: 7, beatmapIds: [1], runs: 2, minutes: 30, mapPlays: () => 0,
		slowRates: [0.95, 0.9, 0.85, 0.8] },
	async body => { rates.push(body.rate); return { score: score[body.rate], accuracy: 0.95, passed: body.rate < 1, strained_minutes: 1 }; },
	async () => ({ characterId: 9, score: 750_000, accuracy: 0.9, rate: 1 }), { pace: call => call() });
	const s = slow.rows[0]?.slow;
	check('the slower rate scoring most is kept', s?.rate === 0.9 && s.wins === 2 && s.bestScore === 800_000, JSON.stringify(slow.rows[0]));
	check('slowing stops once every play passes and scores less', !rates.includes(0.8), JSON.stringify(rates));
}

{
	let drops = 2;
	const flaky = await m.findCrowns({ state: { generation: 1, skills: {} }, characterId: 7, beatmapIds: [1], runs: 1, minutes: 30, mapPlays: () => 0 },
		async () => { if (drops-- > 0) throw new TypeError('Failed to fetch'); return { score: 991_000, accuracy: 0.95, passed: true, strained_minutes: 1 }; },
		async () => undefined, { pace: call => call(), retryDelayMs: 1 });
	check('a dropped connection is tried again', flaky.rows.length === 1 && !flaky.error, JSON.stringify(flaky));
	const dead = await m.findCrowns({ state: { generation: 1, skills: {} }, characterId: 7, beatmapIds: [1], runs: 1, minutes: 30, mapPlays: () => 0 },
		async () => { throw new TypeError('Failed to fetch'); }, async () => undefined, { pace: call => call(), retryDelayMs: 1 });
	check('a connection that stays down stops it', dead.error === 'Failed to fetch' && dead.partial);
}

rmSync(dir, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
