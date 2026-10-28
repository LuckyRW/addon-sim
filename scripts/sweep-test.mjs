/** A map the sim API refuses costs the sweep that map, not the sweep; a play the
 *  sim cache keeps saves one call; a guest's sweep fails instead of skipping every map. */
import { build } from 'esbuild';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This repository's root, so nothing depends on where it is checked out. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const dir = join(REPO_ROOT, '.sweeptest');
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'e.ts'), `export { runSweep } from '../src/engine/client.js';`);
await build({
	entryPoints: [join(dir, 'e.ts')], outfile: join(dir, 'b.mjs'), bundle: true,
	format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
	conditions: ['import', 'default'],
	absWorkingDir: REPO_ROOT,
	// The kit and the game are stubbed; the sim API is a fake each check passes in.
	plugins: [{
		name: 'stub-deps',
		setup(b) {
			b.onResolve({ filter: /^(@oss-idle\/addon-sdk|@oss-idle\/shared\/.*)$/ },
				a => ({ path: a.path, namespace: 'stub' }));
			b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
				contents: 'export const beatmapStore = { difficulties: async () => [] };'
					+ ' export const gameDb = {};'
					+ ' export const gameCharacter = { live: async () => ({ id: 1, generation: 1 }) };'
					+ ' export const playCountsSince = async () => globalThis.playCounts ?? {};'
					+ ' export const hasUnlock = () => false;'
					+ ' export const medalXPMultiplier = () => 1; export const MEDALS = [];'
					+ ' export const rateSteps = () => [1];'
					+ ' export const fatigueLevel = () => 0; export const fatigueXp = () => 1;'
					+ ' export const keptShare = () => 1; export const warmup = () => 1;'
					+ ' export const modsKey = mods => mods.join(); export const modXpMultipliers = () => ({});'
					+ ' export const PHYSICAL_SKILLS = []; export const Skills = ["speed", "stamina"];'
					+ ' export const skillXPMultiplier = () => 1; export const playLevelOf = level => level;'
					+ ' export const xpGivesLevel = () => ({ level: 0, xp: 0 }); export const xpToLevel = () => 0;'
					+ ' export const LEAD_IN_MS = 2000; export default () => 0;',
				loader: 'js',
			}));
		},
	}],
});
const { runSweep } = await import(pathToFileURL(join(dir, 'b.mjs')).href);

/** A sim cache keeping `rows` (lookup's columns), as fetch answers it. */
const cache = (rows = []) => globalThis.fetch = async url => ({
	ok: true,
	json: async () => String(url).endsWith('/healthz') ? { sim_version: '' } : {
		columns: ['beatmap_id', 'rate', 'mods', 'learned', 'score', 'accuracy', 'max_combo', 'rank', 'pp',
			'perfect', 'passed', 'statistics', 'unstable_rate', 'fail_progress', 'fail_seconds', 'strained_minutes', 'xp'],
		rows,
	},
});

const failure = status => Object.assign(new Error(`status ${status}`), { status });

/** The sim API: `answer(body)` for each call, counted in `calls`. */
const api = answer => {
	const calls = [];
	const simulate = async body => {
		calls.push(body);
		return answer(body);
	};
	return { calls, simulate };
};

const play = (body, { passed = true, speed = 100 } = {}) => ({
	beatmap_id: body.beatmap_id, rate: body.rate, mods: body.mods, score: 1, accuracy: 0.9, max_combo: 1,
	rank: passed ? 'A' : 'D', pp: 1, perfect: false, passed, statistics: {}, unstable_rate: 80,
	strained_minutes: 1, ...!passed && { fail_progress: 0.5, fail_seconds: 30 }, xp: { speed: passed ? speed : 0 },
});

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? pass++ : (fail++, console.log('  FAIL:', n, x)); };

const requests = [
	{ setId: 1, beatmapId: 10, rates: [1], mods: [[]], minutes: [0] },
	{ setId: 2, beatmapId: 20, rates: [1, 1.1], mods: [[]], minutes: [0] },
	{ setId: 2, beatmapId: 21, rates: [1], mods: [[]], minutes: [0] },
];

// a map that is not live is the one skipped; the rest run, each variant averaged over its runs
cache();
const refusing = api(body => {
	if (body.beatmap_id === 21) throw failure(404);
	return play(body, { speed: 90 + body.rate * 10 });
});
let last;
const sweep = await runSweep(requests, { runs: 3, simulate: refusing.simulate }, progress => { last = progress; });
const { results, errors, cancelled } = await sweep.finished;
check('every map is accounted for', last.done === requests.length, `${last.done}`);
check('the map not live is the one skipped', errors.length === 1 && errors[0].beatmapId === 21
	&& errors[0].message === 'not live on the server', JSON.stringify(errors));
check('every other rate has a result', results.length === 3, `${results.length}`);
check('each is averaged over its runs', results.every(r => r.runs === 3), JSON.stringify(results.map(r => r.runs)));
check('the sim API is asked once a run', refusing.calls.filter(c => c.beatmap_id !== 21).length === 9,
	`${refusing.calls.length}`);
check('not reported as cancelled', !cancelled);

// the cache's play of a map never played stands in for one run
cache([[10, 1, [], false, 1, 0.9, 1, 'A', 1, false, true, {}, 80, null, null, 1, { speed: 500 }]]);
const cached = api(body => play(body));
const withCache = await (await runSweep([requests[0]], { runs: 2, simulate: cached.simulate })).finished;
check('a cached play saves a call', cached.calls.length === 1, `${cached.calls.length}`);
check('and counts as a run', withCache.results[0]?.runs === 2 && withCache.results[0].xp.speed === 300,
	JSON.stringify(withCache.results[0]));
// memory's plays of it in between: the cache keeps nothing for those
globalThis.playCounts = { 10: 5 };
const partly = api(body => play(body));
await (await runSweep([requests[0]], { runs: 2, simulate: partly.simulate })).finished;
check('a map memory half knows is not taken from the cache', partly.calls.length === 2, `${partly.calls.length}`);
globalThis.playCounts = {};

// rates that fail outright twice running end a map's sweep
cache();
const failing = api(body => play(body, { passed: false }));
const stopped = await (await runSweep([{ ...requests[1], rates: [1, 1.1, 1.2, 1.3] }], { runs: 1, simulate: failing.simulate })).finished;
check('a map stops after two failed rates', stopped.results.map(r => r.rate).join() === '1,1.1',
	JSON.stringify(stopped.results.map(r => r.rate)));
check('a failed play costs the time to its fail', stopped.results[0]?.durationSec === 32, `${stopped.results[0]?.durationSec}`);

// a busy server (429) is asked again
let busy = 1;
const retried = api(body => {
	if (busy-- > 0) throw failure(429);
	return play(body);
});
const afterBusy = await (await runSweep([requests[0]], { runs: 1, simulate: retried.simulate })).finished;
check('a busy server is asked again', afterBusy.results.length === 1 && afterBusy.errors.length === 0,
	JSON.stringify(afterBusy));

// a request the sim API calls bad is bad on every map: stop at the first, do not try them all
const bad = api(() => { throw failure(400); });
const stoppedAt = await (await runSweep(requests, { runs: 1, simulate: bad.simulate })).finished
	.then(() => undefined, e => e);
check('a bad request fails the sweep', stoppedAt?.status === 400 && stoppedAt.message.includes('status 400'),
	String(stoppedAt?.message));
check('without asking for every map', bad.calls.length < requests.length, `${bad.calls.length}`);

// a guest has no sim API: fail the sweep, do not skip every map
const guest = api(() => { throw failure(401); });
const outcome = await (await runSweep(requests, { runs: 1, simulate: guest.simulate })).finished
	.then(() => 'resolved', e => e.message);
check('a guest fails the sweep', outcome.startsWith('Sign in'), outcome);

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
