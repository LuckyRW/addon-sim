/** The farm model: XP in the server's order, the ranking, and a session's forecast. */
import { build } from 'esbuild';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolveGameRoot } from './resolve-game.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This repository's root, so nothing depends on where it is checked out. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const game = resolveGameRoot();
const { sharedSourcePlugin, tsExtensionPlugin } = await import('@oss-idle/addon-sdk/build');

const dir = join(REPO_ROOT, '.ranktest');
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'e.ts'), `
export * from '../src/farm/metrics.js';
export * from '../src/farm/session.js';
export { warmupBar } from '@oss-idle/shared/fatigue';
`);
await build({
	entryPoints: [join(dir, 'e.ts')], outfile: join(dir, 'b.mjs'), bundle: true,
	format: 'esm', platform: 'node', target: 'es2022',
	plugins: [sharedSourcePlugin(join(game.root, 'packages/shared/src')), tsExtensionPlugin()],
	absWorkingDir: REPO_ROOT,
});
const m = await import(pathToFileURL(join(dir, 'b.mjs')).href);

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? pass++ : (fail++, console.log('  FAIL:', n, x)); };

const play = (beatmapId, { pp = 100, durationSec = 180, xp = 1000, rate = 1, mods = [], strained = 0 } = {}) => ({
	setId: beatmapId * 10, beatmapId, rate, mods, minutes: 0, stars: 0, pp, durationSec,
	lengthMin: (durationSec - 2) / 60, strained,
	// accuracy is mindblocked, speed is physical: both are here to check the split
	xp: { accuracy: xp, speed: xp }, totalXp: xp * 2,
	accuracy: 0.99, grade: 'S', runs: 3, failRate: 0, variation: 0,
});

// --- serverXp: mindblock, fatigue, medals, mods, in that order
{
	const plain = m.serverXp({ accuracy: 1000, speed: 1000 }, {});
	check('no rules leave xp as is', plain.accuracy === 1000 && plain.speed === 1000);
	const blocked = m.serverXp({ accuracy: 1000, speed: 1000 }, { recentPlays: 25 });
	check('mindblock cuts accuracy to a quarter, not speed', blocked.accuracy === 250 && blocked.speed === 1000, JSON.stringify(blocked));
	const tired = m.serverXp({ accuracy: 1000, speed: 1000 }, { fatigue: 1 });
	check('exhaustion cuts speed to 5%, not accuracy', tired.speed === 50 && tired.accuracy === 1000, JSON.stringify(tired));
	const hr = m.serverXp({ accuracy: 1000, speed: 1000 }, { mods: ['HR'] });
	check('HR adds 10% to accuracy only', hr.accuracy === 1100 && hr.speed === 1000, JSON.stringify(hr));
	const ez = m.serverXp({ accuracy: 1000, speed: 1000 }, { mods: ['EZ'], medals: 1.1 });
	check('medals then EZ, floored each step', ez.accuracy === 550 && ez.speed === 550, JSON.stringify(ez));
}

// --- ranking
{
	const short = play(1, { pp: 100, durationSec: 30, xp: 300 });
	const long = play(2, { pp: 300, durationSec: 300, xp: 900 });
	const byPp = m.rankMaps([short, long], { target: { kind: 'pp' } });
	check('pp ranks by pp, not pp per second', byPp[0].beatmapId === 2);
	const byXp = m.rankMaps([short, long], { target: { kind: 'total' }, delaySec: 30 });
	check('xp ranks per second of play and delay', byXp[0].beatmapId === 1);

	const hr = play(1, { mods: ['HR'] });
	const nomod = play(1);
	const rows = m.rankMaps([nomod, hr, nomod], { target: { kind: 'total' } });
	check('a play with and without HR are two rows, each once', rows.length === 2);
	check('HR ranks above the same play without it', rows[0].mods[0] === 'HR');
	check('each difficulty once at its best', m.bestPerDifficulty(rows).length === 1);

	const loved = m.rankMaps([short, long], { target: { kind: 'pp' }, noPp: new Set([2]) });
	check('loved maps give no pp', loved.length === 1 && loved[0].beatmapId === 1);
	check('but still XP', m.rankMaps([short, long], { target: { kind: 'total' }, noPp: new Set([2]) }).length === 2);

	const failing = { ...play(3), failRate: 0.8 };
	const xp = { accuracy: 100, speed: 40, stamina: 10 };
	check('main skills are summed', m.targetValue(xp, { kind: 'skills', skills: ['speed', 'stamina'] }, 0) === 50);
	check('a secondary skill counts at its weight', m.targetValue(xp, { kind: 'skills', skills: ['speed'], secondary: 'accuracy' }, 0) === 40 + 100 * m.SECONDARY_WEIGHT);
	check('a secondary that is also main counts once', m.targetValue(xp, { kind: 'skills', skills: ['accuracy'], secondary: 'accuracy' }, 0) === 100);
	// a speed map and an accuracy map that rest as much: the secondary picks the accuracy one
	const fills = m.rankMaps([
		{ ...play(1), xp: { speed: 100, accuracy: 0 } },
		{ ...play(2), xp: { speed: 90, accuracy: 300 } },
	], { target: { kind: 'skills', skills: ['speed'], secondary: 'accuracy' } });
	check('the secondary decides between plays the main skills value alike', fills[0].beatmapId === 2);
	check('plays failing too often are dropped', m.rankMaps([failing], { target: { kind: 'total' } }).length === 0);
}

// --- screening and refining
{
	const rates = [0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2];
	const screened = m.screenRates(rates);
	check('screening keeps x1 and the fastest', screened.includes(1) && screened.includes(1.2), screened.join());
	const best = m.rankMaps([play(1, { rate: 1 })], { target: { kind: 'total' } });
	const [plan] = m.refinePlan(best, rates, screened, 5, [[], ['HR']], 60);
	check('refining fills the rates around the best one', plan.rates.join() === '1,1.05', plan.rates.join());
	check('refining carries the mods and the peak', plan.mods.length === 2 && plan.minutes.join() === '60');
}

// --- session
{
	const gear = 0;
	const peak = m.peakMinutes(gear);
	const states = m.stateMinutes(gear);
	check('no state is at the peak', states.length > 0 && !states.includes(peak), states.join());

	const heavy = [1, 2, 3].map(id => play(id, { xp: 2000, strained: 3 - 2 / 60 }));
	const light = [4, 5, 6].map(id => play(id, { xp: 1000, strained: 0 }));
	const ranked = m.rankMaps([...heavy, ...light], { target: { kind: 'total' } });
	const curve = m.coldCurve([], new Map(), gear);
	const options = {
		target: { kind: 'total' }, lookup: m.stateLookup([], gear, curve), sessionSec: m.HOLD_HOURS * 3600,
		startMinutes: m.midPeakMinutes(gear), delaySec: 30, gear, medals: 1, recentPlays: new Map(),
	};
	const hot = m.forecast(heavy, options);
	check('heavy maps alone warm the character off its peak', hot.leavesAt !== undefined && hot.samples.at(-1).bar > m.PEAK_MIDDLE, hot.leavesAt);
	const cool = m.forecast(light, options);
	check('light maps alone cool it off its peak', cool.leavesAt !== undefined && cool.samples.at(-1).bar < m.PEAK_MIDDLE);
	check('a forecast counts every play it makes', hot.plays > 100 && hot.perHour > 0, hot.plays);
	check('the middle of the peak is in the peak zone', Math.abs(m.warmupBar(m.midPeakMinutes(gear), gear) - m.PEAK_MIDDLE) < 1e-6);

	// a heavy map and two light ones nearly balance; light ones alone cool off
	const warm = [1, 2, 3].map(id => play(id, { xp: 2000, strained: 2 }));
	const balancers = [7, 8, 9, 10].map((id, i) => play(id, { xp: 1000, strained: 0.3 * i }));
	const mixed = m.rankMaps([...warm, ...balancers], { target: { kind: 'total' } });
	const held = m.forecast(m.buildRotation(mixed, { ...options, size: 3 }), options);
	check('the search finds a loop that holds the middle of the peak', held.leavesAt === undefined && held.drift <= m.HOLD_BAND, held.drift);
	check('and keeps a heavy map in it', m.buildRotation(mixed, { ...options, size: 3 }).some(map => map.beatmapId <= 3));

	// warm-up: from rested, the heaviest plays for their length
	const rested = { ...options, startMinutes: 0, sessionSec: m.WARMUP_HOURS * 3600 };
	const warmup = m.buildWarmup(ranked, { ...rested, size: 2 });
	check('a warm-up takes the plays that warm most', warmup.length === 2 && warmup.every(map => map.beatmapId <= 3), warmup.map(map => map.beatmapId).join());
	check('and reaches the middle of the peak', m.forecast(warmup, rested).warmAt !== undefined);
	check('a warm-up leaves out plays that rest', m.buildWarmup(m.rankMaps(light, { target: { kind: 'total' } }), { ...rested, size: 3 }).length === 0);

	// a library's worth of plays, at the overlay's sizes
	const library = Array.from({ length: 300 }, (_, i) => play(100 + i, {
		xp: 500 + (i * 37) % 1500, durationSec: 90 + (i * 53) % 240, strained: ((i * 29) % 100) / 100 * ((90 + (i * 53) % 240 - 2) / 60),
	}));
	const big = m.rankMaps(library, { target: { kind: 'total' } });
	const started = performance.now();
	const bigRot = m.buildRotation(big, { ...options, delaySec: 3, size: 20 });
	check('a library-sized loop holds too', m.forecast(bigRot, { ...options, delaySec: 3 }).leavesAt === undefined);
	const steadyOptions = { ...options, delaySec: 3, size: 20, band: m.STEADY_BAND };
	const steady = m.forecast(m.buildRotation(big, steadyOptions), steadyOptions);
	const loose = m.forecast(bigRot, { ...options, delaySec: 3 });
	check('a steady loop strays less than one for more XP', steady.stray <= loose.stray, `${steady.stray} vs ${loose.stray}`);
	check('which earns at least as much', loose.total >= steady.total * 0.999, `${loose.total} vs ${steady.total}`);
	const freeOptions = { ...options, delaySec: 3, size: 20, band: Infinity };
	const free = m.forecast(m.buildRotation(big, freeOptions), freeOptions);
	check('a loop that holds nothing earns at least as much again', free.total >= loose.total * 0.999, `${free.total} vs ${loose.total}`);
	const took = performance.now() - started;
	console.log(`  20-map search over 300 maps: ${took.toFixed(0)} ms`);

	const top = ranked.filter((map, i, all) => all.findIndex(o => o.beatmapId === map.beatmapId) === i).slice(0, 3);
	const built = m.buildRotation(ranked, { ...options, size: 3 });
	check('the search never does worse than the best maps alone',
		m.forecast(built, options).total >= m.forecast(top, options).total);
	check('each difficulty at most once', new Set(built.map(map => map.beatmapId)).size === built.length);

	const pinned = m.buildRotation(ranked, { ...options, size: 3, pinned: [m.playKey(light[2])] });
	check('a pinned play stays in', pinned.some(map => map.beatmapId === 6));
	const without = m.buildRotation(ranked, { ...options, size: 3, excluded: new Set([1]) });
	check('an excluded difficulty stays out', !without.some(map => map.beatmapId === 1));

	// a play simulated tired is read at that tiredness, interpolated between states
	const tired = { ...heavy[0], minutes: 0, xp: { accuracy: 0, speed: 0 } };
	const lookup = m.stateLookup([tired], gear, curve);
	check('a play at its simulated state reads that state', lookup(heavy[0], 0).xp.accuracy === 0);
	const half = lookup(heavy[0], peak / 2).xp.accuracy;
	check('halfway to its peak reads halfway', Math.abs(half - 1000) < 1, half);
	check('at its peak reads the peak play', lookup(heavy[0], peak).xp.accuracy === 2000);
}

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
