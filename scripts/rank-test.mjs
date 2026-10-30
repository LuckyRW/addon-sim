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
	setId: beatmapId * 10, beatmapId, rate, mods, minutes: m.peakMinutes(0), stars: 0, pp, durationSec,
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
	check('a secondary skill counts at its weight', m.targetValue(xp, { kind: 'skills', skills: ['speed'], secondary: ['accuracy'] }, 0) === 40 + 100 * m.SECONDARY_WEIGHT);
	check('secondary skills are summed at their weight', m.targetValue(xp, { kind: 'skills', skills: ['speed'], secondary: ['accuracy', 'stamina'] }, 0) === 40 + 110 * m.SECONDARY_WEIGHT);
	check('a secondary that is also main counts once', m.targetValue(xp, { kind: 'skills', skills: ['accuracy'], secondary: ['accuracy'] }, 0) === 100);
	// a speed map and an accuracy map that rest as much: the secondary picks the accuracy one
	const fills = m.rankMaps([
		{ ...play(1), xp: { speed: 100, accuracy: 0 } },
		{ ...play(2), xp: { speed: 90, accuracy: 300 } },
	], { target: { kind: 'skills', skills: ['speed'], secondary: ['accuracy'] } });
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

	// whether a forecast stays at the peak for the whole session: the departure is
	// worked out even past it, so a loop that holds may still leave one day
	const holds = f => f.drift <= m.HOLD_BAND && !(f.leavesAt <= options.sessionSec);

	// a heavy map and two balancers that rest exactly what it warms, whatever the
	// fatigue rule; light ones alone cool off
	const warm = [1, 2, 3].map(id => play(id, { xp: 2000, strained: 2 }));
	const driftAt = strained => m.driftOf(m.rankMaps([play(7, { strained })], { target: { kind: 'total' } })[0], options);
	const target = -driftAt(2) / 2;
	let lo = 0, hi = play(7).lengthMin;
	for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (driftAt(mid) < target) lo = mid; else hi = mid; }
	const balancers = [7, 8].map(id => play(id, { xp: 1000, strained: lo }));
	const coolers = [9, 10].map(id => play(id, { xp: 1200, strained: 0 }));
	const mixed = m.rankMaps([...warm, ...balancers, ...coolers], { target: { kind: 'total' } });
	const held = m.forecast(m.buildRotation(mixed, { ...options, size: 3 }), options);
	check('the search finds a loop that holds the middle of the peak', holds(held), `${held.drift} / ${held.leavesAt}`);
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
	check('a library-sized loop holds too', holds(m.forecast(bigRot, { ...options, delaySec: 3 })));
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
	// as the search ranks loops: holding first, then straying less, then earning more
	const ours = m.forecast(built, options), best = m.forecast(top, options);
	check('the search never does worse than the best maps alone',
		holds(ours) ? !holds(best) || ours.total >= best.total : !holds(best) && ours.stray <= best.stray + 1e-9,
		`${ours.total} / ${ours.stray} vs ${best.total} / ${best.stray}`);
	check('each difficulty at most once', new Set(built.map(map => map.beatmapId)).size === built.length);

	// repeats: replaying the best maps until mindblock or fatigue makes another map worth more
	const loose4 = { ...options, size: 4, band: Infinity };
	const once = m.forecast(m.buildRotation(ranked, loose4), loose4).total;
	const looped = m.buildRepeating(ranked, loose4);
	const loopedTotal = m.forecast(m.expand(looped.rotation, looped.repeats), loose4).total;
	check('repeats never earn less than each map once', loopedTotal >= once, `${loopedTotal} vs ${once}`);
	check('each map plays 1 to MAX_REPEAT times', looped.repeats.length === looped.rotation.length
		&& looped.repeats.every(n => Number.isInteger(n) && n >= 1 && n <= m.MAX_REPEAT), looped.repeats.join());
	check('expand plays each map its repeats in a row',
		m.expand(looped.rotation, looped.repeats).length === looped.repeats.reduce((a, b) => a + b, 0));
	// mindblock dulls accuracy (half of every test play's XP) on a map replayed: a lone map earns less looped than spread
	const blocked = { ...loose4, size: 3 };
	const spread = m.buildRepeating(ranked, blocked);
	check('mindblock keeps more than one map in a repeat playlist', spread.rotation.length > 1, spread.rotation.length);
	const pin = m.playKey(ranked.at(-1));
	const kept = m.buildRepeating(ranked, { ...blocked, pinned: [pin] });
	check('a pinned map stays in a repeat playlist', kept.rotation.some(map => m.playKey(map) === pin));
	check('a manual playlist keeps its maps once each', m.buildRepeating(ranked, { ...blocked, pinned: [pin], manualOnly: true }).repeats.every(n => n === 1));
	// an automatic size: the size whose playlist does best, never one the library cannot fill
	const sized = m.bestSize(big, { ...options, delaySec: 3, size: 0 });
	check('an automatic size is one it tries', m.AUTO_SIZES.includes(sized), sized);
	const day = { ...options, delaySec: 3, sessionSec: 24 * 3600 };
	const dayOf = size => m.forecast(m.buildRotation(big, { ...day, size }), day);
	const pickedDay = dayOf(sized);
	check('and does no worse than the others, holding first', m.AUTO_SIZES.every(size => {
		const other = dayOf(size);
		const holdsBand = f => f.drift <= m.HOLD_BAND;
		return holdsBand(pickedDay) ? !holdsBand(other) || other.total <= pickedDay.total * 1.001 : !holdsBand(other) && other.stray >= pickedDay.stray - 1e-6;
	}), sized);
	const tiny = m.rankMaps(library.slice(0, 7), { target: { kind: 'total' } });
	check('a small library is not sized past its maps', m.bestSize(tiny, { ...options, delaySec: 3, size: 0 }) <= 8);

	// a loop of different difficulties long enough never mindblocks
	const freshTarget = { kind: 'skills', skills: ['accuracy'] };
	const multi = m.rankMaps(library.slice(0, 80).flatMap(map => [map, { ...map, rate: 1.1 }]), { target: freshTarget });
	const freshOptions = { ...options, target: freshTarget, delaySec: 3, size: m.FRESH_SIZE };
	const freshLoop = m.buildFresh(multi, freshOptions);
	check('a mindblock-free playlist has each difficulty once', freshLoop.length === 51 && new Set(freshLoop.map(map => map.beatmapId)).size === 51, freshLoop.length);
	const lastPlays = [];
	let worstCount = 0;
	for (let i = 0; i < 300; i++) {
		const id = freshLoop[i % freshLoop.length].beatmapId;
		worstCount = Math.max(worstCount, lastPlays.filter(other => other === id).length);
		lastPlays.push(id);
		if (lastPlays.length > m.RECENT_LIMIT) lastPlays.shift();
	}
	check('so no map is among your last 50 plays when it comes back', worstCount === 0, worstCount);
	check('and the loop rests about what it tires', Math.abs(freshLoop.reduce((sum, map) => sum + m.driftOf(map, freshOptions), 0)) < 1,
		freshLoop.reduce((sum, map) => sum + m.driftOf(map, freshOptions), 0));
	// a play that fails looks cheap: no time, no XP, the whole map's fatigue
	const failing = Array.from({ length: 30 }, (_, i) => ({ ...play(600 + i, { durationSec: 16, strained: 2 }), xp: { accuracy: 1, speed: 0 }, failRate: 1 }));
	const withFails = m.rankMaps([...library.slice(0, 80), ...failing], { target: freshTarget, maxFailRate: 1 });
	const clean = m.buildFresh(withFails, freshOptions);
	check('a play that fails is never picked', clean.every(map => map.failRate < 0.5), clean.filter(map => map.failRate >= 0.5).length);
	const worstFresh = Math.min(...clean.map(map => map.perSecond));
	check('nor one that earns nothing', worstFresh > 0, worstFresh);

	// a standout map that earns only speed (no mindblock) and never tires: replaying it beats the rest
	const standout = { ...play(50, { strained: 0 }), xp: { speed: 6000, accuracy: 0 } };
	const fillers = [51, 52, 53].map(id => ({ ...play(id, { strained: 0 }), xp: { speed: 1500, accuracy: 0 } }));
	const star = m.buildRepeating(m.rankMaps([standout, ...fillers], { target: { kind: 'total' } }), loose4);
	const starAt = star.rotation.findIndex(map => map.beatmapId === 50);
	check('a standout map with nothing against replaying it is repeated', starAt >= 0 && star.repeats[starAt] > 1,
		star.rotation.map((map, k) => `${map.beatmapId}x${star.repeats[k]}`).join(' '));
	// repeats set by hand: kept as set, and the search works around them
	const fixedKey = m.playKey(star.rotation[starAt]);
	const held3 = m.buildRepeating(m.rankMaps([standout, ...fillers], { target: { kind: 'total' } }), { ...loose4, repeats: { [fixedKey]: 3 } });
	const at3 = held3.rotation.findIndex(map => m.playKey(map) === fixedKey);
	check('a repeat count set by hand is kept by the search', at3 >= 0 && held3.repeats[at3] === 3, held3.repeats.join());
	const filler = m.playKey(fillers[0]);
	const keptFiller = m.buildRepeating(m.rankMaps([standout, ...fillers], { target: { kind: 'total' } }), { ...loose4, pinned: [filler], repeats: { [filler]: 2 } });
	check('and its map is not dropped', keptFiller.rotation.some(map => m.playKey(map) === filler));
	check('repeatsOf: once unless set, within 1 to MAX_REPEAT', m.repeatsOf(star.rotation, { [fixedKey]: 99 }).join()
		=== star.rotation.map(map => (m.playKey(map) === fixedKey ? m.MAX_REPEAT : 1)).join());


	const pinned = m.buildRotation(ranked, { ...options, size: 3, pinned: [m.playKey(light[2])] });
	check('a pinned play stays in', pinned.some(map => map.beatmapId === 6));
	const without = m.buildRotation(ranked, { ...options, size: 3, excluded: new Set([1]) });
	check('an excluded difficulty stays out', !without.some(map => map.beatmapId === 1));

	// several main skills: each to its share of what it can earn, not the one with the most XP taking every play
	const skilled = (id, xp, strained = 0) => ({ ...play(id, { durationSec: 120, strained }), xp });
	const both = [
		...[20, 21, 22].map(id => skilled(id, { speed: 6000, accuracy: 200 }, 1)),
		...[23, 24, 25].map(id => skilled(id, { speed: 0, accuracy: 600 })),
	];
	const pair = { kind: 'skills', skills: ['speed', 'accuracy'] };
	const summed = m.rankMaps(both, { target: pair, delaySec: 3 });
	const fair = m.withPotential(pair, summed, 3);
	check('a balanced target reads each skill off its best play', fair.potential.speed === 6000 / 123 && fair.potential.accuracy === 600 / 123, JSON.stringify(fair.potential));
	check('a balanced play is worth its shares, in seconds of each best play', Math.abs(summed[0].perSecond - (1 + 200 / 600)) < 1e-9, summed[0].perSecond);
	const pairOptions = { ...options, target: fair, delaySec: 3, band: Infinity };
	const mix = m.forecast(m.buildRotation(summed, { ...pairOptions, size: 4 }), pairOptions, true);
	const shareOf = skill => mix.bySkill[skill] / (fair.potential[skill] * pairOptions.sessionSec);
	check('a balanced playlist farms both skills', shareOf('speed') > 0.25 && shareOf('accuracy') > 0.25, `${shareOf('speed')} / ${shareOf('accuracy')}`);
	const speedOnly = m.forecast(both.slice(0, 3).map(map => summed.find(r => r.beatmapId === map.beatmapId)), pairOptions, true);
	check('and is worth more to it than the skill with the most XP alone', mix.total > speedOnly.total, `${mix.total} vs ${speedOnly.total}`);
	check('one main skill is summed as before', m.sessionValue({ speed: 10, accuracy: 5 }, { kind: 'skills', skills: ['speed'], secondary: ['accuracy'], potential: { speed: 1 } }) === 10 + 5 * m.SECONDARY_WEIGHT);

	// a play simulated tired is read at that tiredness, interpolated between states
	const tired = { ...heavy[0], minutes: 0, xp: { accuracy: 0, speed: 0 } };
	const lookup = m.stateLookup([tired], gear, curve);
	check('a play at its simulated state reads that state', lookup(heavy[0], 0).xp.accuracy === 0);
	const half = lookup(heavy[0], peak / 2).xp.accuracy;
	check('halfway to its peak reads halfway', Math.abs(half - 1000) < 1, half);

	// a scan set to another fatigue: its plays stand where they were played, a state on the peak for the peak
	const offMinutes = 200;
	const off = { ...heavy[0], minutes: offMinutes, xp: { accuracy: 600, speed: 600 } };
	const onPeakState = { ...heavy[0], minutes: peak, xp: { accuracy: 1200, speed: 1200 } };
	const offCurve = m.coldCurve([onPeakState], new Map([[m.playKey(off), off]]), gear);
	check('off the peak, the curve is 1 where the plays were simulated', Math.abs(offCurve(offMinutes).accuracy ?? 1) - 1 < 1e-9);
	check('and the peak reads what a state on it says', Math.abs(offCurve(peak).accuracy - 2) < 1e-9, offCurve(peak).accuracy);
	const offLookup = m.stateLookup([onPeakState], gear, offCurve);
	check('a play simulated off the peak reads itself there', offLookup(off, offMinutes).xp.accuracy === 600);
	check('and its peak state on the peak', offLookup(off, peak).xp.accuracy === 1200);
	check('at its peak reads the peak play', lookup(heavy[0], peak).xp.accuracy === 2000);
}

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
