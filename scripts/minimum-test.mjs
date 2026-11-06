/** The least levels a goal takes, against a sim whose answer is known. */
import { build } from 'esbuild';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolveGameRoot } from './resolve-game.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This repository's root, so nothing depends on where it is checked out. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const game = resolveGameRoot();
const { sharedSourcePlugin, tsExtensionPlugin } = await import('@oss-idle/addon-sdk/build');

const dir = join(REPO_ROOT, '.minimumtest');
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'e.ts'), `export * from '../src/engine/minimum.js';\nexport * from '../src/engine/hunt.js';
export * from '../src/engine/bottleneck.js';\n`);
await build({
	entryPoints: [join(dir, 'e.ts')], outfile: join(dir, 'b.mjs'), bundle: true,
	format: 'esm', platform: 'node', target: 'es2022', logLevel: 'error',
	plugins: [sharedSourcePlugin(join(game.root, 'packages/shared/src')), tsExtensionPlugin()],
	absWorkingDir: REPO_ROOT,
});
const m = await import(pathToFileURL(join(dir, 'b.mjs')).href);

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? pass++ : (fail++, console.log('  FAIL:', n, x)); };

const skill = (level, prestige = 0) => ({ level, xp: 0, lifetime_xp: 0, prestige, upgrades: 0, overdrive: 0 });
const state = {
	generation: 1,
	skills: { speed: skill(30), stamina: skill(20), accuracy: skill(50), reading: skill(40), memory: skill(10) },
};
const playedAt = s => s.level + s.prestige;
/** A map passed from speed 60 and stamina 45; accuracy rises with the accuracy skill. */
const sim = async ({ skills }) => {
	const speed = playedAt(skills.speed), stamina = playedAt(skills.stamina);
	const passed = speed >= 60 && stamina >= 45;
	return { passed, accuracy: Math.min(1, 0.5 + playedAt(skills.accuracy) / 200), fail_progress: Math.min(0.99, (speed + stamina) / 200) };
};
const job = { state, beatmapId: 1, rate: 1, mods: [], minutes: 75, mapPlays: 0, goal: { kind: 'pass' }, runs: 2 };
const pace = call => call();

const raised = await m.findMinimum(job, sim, { pace });
check('a goal out of your reach is not already met', raised.reachable && !raised.alreadyMet);
check('it finds the least speed and stamina', raised.levels.speed === 60 && raised.levels.stamina === 45, JSON.stringify(raised.levels));
check('skills that do not help stay where they are', raised.levels.accuracy === 50 && raised.levels.reading === 40 && raised.levels.memory === 10, JSON.stringify(raised.levels));
check('and the levels it gives meet the goal', raised.trial?.met === true && raised.trial.passShare === 1);

const accurate = await m.findMinimum({ ...job, goal: { kind: 'accuracy', accuracy: 0.9 } }, sim, { pace });
check('an accuracy goal raises what accuracy takes', accurate.levels.accuracy === 80, JSON.stringify(accurate.levels));

const strong = { ...state, skills: { ...state.skills, speed: skill(90), stamina: skill(70) } };
const spare = await m.findMinimum({ ...job, state: strong }, sim, { pace });
check('a goal already met says so', spare.alreadyMet);
check('and lowers to the least it takes', spare.levels.speed === 60 && spare.levels.stamina === 45 && spare.levels.reading === 0, JSON.stringify(spare.levels));

const never = await m.findMinimum(job, async () => ({ passed: false, accuracy: 0.5, fail_progress: 0.1 }), { pace });
check('a goal no level meets is out of reach', !never.reachable);
check('and costs few calls to find out', never.calls <= 2 * job.runs, never.calls);

// a skill is sent at only the level asked, its prestige and upgrades kept; the rest are sent as they are
const lifetime = { ...state, skills: { ...state.skills, speed: { ...skill(20, 3), upgrades: 2, lifetime_xp: 1e9 }, reading: { ...skill(40), xp: 5 } } };
const bodies = [];
await m.findMinimum({ ...job, state: lifetime }, async body => { bodies.push(body); return sim(body); }, { pace });
check('your own levels go first, exactly as you have them', bodies[0].skills.speed.lifetime_xp === 1e9 && bodies[0].skills.reading.xp === 5);
const changed = bodies.map(body => body.skills.speed).find(s => s.lifetime_xp === 0);
check('another level goes alone, prestige and upgrades kept', changed && changed.xp === 0 && changed.prestige === 3 && changed.upgrades === 2, JSON.stringify(changed));

// a full combo: no miss on a passed play, whatever else it hit
const fcSim = async body => ({ ...await sim(body), statistics: { miss: Math.max(0, 70 - playedAt(body.skills.speed)), good: 3 }, perfect: false });
const fc = await m.findMinimum({ ...job, goal: { kind: 'fc' } }, fcSim, { pace });
check('a full combo takes what removes every miss', fc.levels.speed === 70 && fc.levels.stamina === 45, JSON.stringify(fc.levels));
check('a GOOD does not break it', fc.trial?.fcShare === 1);

// starting from levels set by hand
const fromSet = await m.findMinimum({ ...job, startLevels: { speed: 80 } }, sim, { pace });
check('a set level is where it starts', fromSet.current.speed === 80 && fromSet.current.stamina === 20, JSON.stringify(fromSet.current));
check('and may stand where it is set', fromSet.levels.speed === 80 && fromSet.levels.stamina === 45, JSON.stringify(fromSet.levels));
const below = await m.findMinimum({ ...job, startLevels: { speed: 5 } }, sim, { pace });
check('a set level below your own is sent', below.current.speed === 5 && below.levels.speed === 60, JSON.stringify(below.levels));
const plays = [];
await m.findMinimum({ ...job, mapPlays: 60 }, async body => { plays.push(body.map_plays); return sim(body); }, { pace });
check('plays of the map set by hand are sent', plays.every(n => n === 60));

// the share of plays that have to succeed: speed 60 passes half the time here, 70 always
let flip = 0;
const coin = async body => {
	const speed = playedAt(body.skills.speed);
	return { passed: speed >= 70 || (speed >= 60 && flip++ % 2 === 0), accuracy: 0.9, fail_progress: speed / 100 };
};
const lenient = await m.findMinimum({ ...job, runs: 4, share: 0.5 }, coin, { pace });
const strict = await m.findMinimum({ ...job, runs: 4, share: 1 }, coin, { pace });
check('a lower share of plays takes fewer levels', lenient.levels.speed === 60 && strict.levels.speed === 70, `${lenient.levels.speed} ${strict.levels.speed}`);

// the chance of one attempt, and what it takes
let nth = 0;
const fcEvery4 = async () => { const i = nth++; return { passed: i % 2 === 0, accuracy: 0.9, fail_seconds: 10, statistics: { miss: i % 4 === 0 ? 0 : 3 } }; };
const odds = await m.findChance({ ...job, goal: { kind: 'fc' }, runs: 100 }, 60, fcEvery4, { pace });
check('the chance counts each attempt', odds.plays === 100 && odds.goalShare === 0.25 && odds.passShare === 0.5, JSON.stringify(odds));
check('a failed attempt ends where it failed', Math.abs(odds.seconds - 35) < 1e-9, odds.seconds);
const stoppedOdds = await m.findChance({ ...job, runs: 50 }, 60, sim, { pace, cancelled: () => true });
check('a stopped chance has no plays', stoppedOdds.plays === 0 && stoppedOdds.goalShare === 0);

let tick = 0;
const rare = await m.findMinimum({ ...job, goal: { kind: 'accuracy', accuracy: 1 }, runs: 4, share: 0.25 }, async () => ({ passed: true, accuracy: tick++ % 4 === 0 ? 1 : 0.99 }), { pace });
check('an accuracy goal counts the plays that reach it, not the average', rare.reachable && rare.alreadyMet, JSON.stringify(rare));

let asked = 0;
const stopped = await m.findMinimum(job, async body => { asked++; return sim(body); }, { pace, cancelled: () => asked >= 4 });
check('stopping says the answer is partial', stopped.partial);

// --- the easiest map for a goal
{
	const at = new Map([[1.2, new Map([[1, 9.4], [2, 8.7]])], [1.5, new Map([[2, 9.1]])]]);
	const found = m.candidatesOf([{ beatmapId: 1, stars: 8.5 }, { beatmapId: 2, stars: 7 }, { beatmapId: 3, stars: 9.8 }], [1.5, 1, 1.2], at, 9);
	check('each map comes once, at the slowest rate reaching the stars', JSON.stringify(found.map(c => [c.beatmapId, c.rate])) === '[[2,1.5],[1,1.2],[3,1]]', JSON.stringify(found));

	const spent = m.xpNeeded(state, { current: { speed: 30, stamina: 20 }, levels: { speed: 31, stamina: 20 } });
	check('the XP a level up costs', spent > 0 && spent === m.xpNeeded(state, { current: { speed: 30 }, levels: { speed: 31 } }), spent);
	check('two levels cost more than one', m.xpNeeded(state, { current: { speed: 30 }, levels: { speed: 32 } }) > spent);

	// map 2 needs speed 60 and stamina 45; map 1 only speed 40
	const easy = async body => body.beatmap_id === 1
		? { passed: playedAt(body.skills.speed) >= 40, accuracy: 0.9, fail_progress: playedAt(body.skills.speed) / 100 }
		: sim(body);
	const hunt = await m.huntEasiest({
		...job, candidates: [{ beatmapId: 2, rate: 1, stars: 9.1 }, { beatmapId: 1, rate: 1, stars: 9.5 }],
		mapPlays: () => 0, screenRuns: 2, finalists: 2,
	}, easy, { pace });
	check('every candidate is screened', hunt.screened === 2);
	check('the easiest is the one whose levels cost least', hunt.rows[0]?.beatmapId === 1 && hunt.rows[0].result.levels.speed === 40, JSON.stringify(hunt.rows.map(r => [r.beatmapId, r.xp])));
	check('the harder one comes after it', hunt.rows[1]?.beatmapId === 2 && hunt.rows[1].xp > hunt.rows[0].xp);
	const one = await m.huntEasiest({
		...job, candidates: [{ beatmapId: 2, rate: 1, stars: 9.1 }, { beatmapId: 1, rate: 1, stars: 9.5 }],
		mapPlays: () => 0, screenRuns: 2, finalists: 1,
	}, easy, { pace });
	let left = 30;
	const outage = async body => { if (left-- <= 0) throw Object.assign(new Error('Simulations are unavailable right now'), { status: 503 }); return easy(body); };
	const cut = await m.huntEasiest({
		...job, candidates: [{ beatmapId: 2, rate: 1, stars: 9.1 }, { beatmapId: 1, rate: 1, stars: 9.5 }],
		mapPlays: () => 0, screenRuns: 2, finalists: 2,
	}, outage, { pace });
	check('a sim API outage keeps what was finished, and says why it stopped', cut.partial && /unavailable/.test(cut.error ?? '') && cut.rows.every(r => r.result), JSON.stringify({ rows: cut.rows.length, error: cut.error }));
	check('only the closest is searched in full', one.rows.length === 1 && one.rows[0].beatmapId === 1, JSON.stringify(one.rows.map(r => r.beatmapId)));
}

// pp: a faster rate pays more but asks more speed; x1 never pays 300pp
{
	const ppSim = async ({ rate, skills }) => {
		const passed = playedAt(skills.speed) >= 40 * rate;
		return { passed, accuracy: 0.95, pp: passed ? 200 * rate : 0, fail_progress: Math.min(0.99, playedAt(skills.speed) / (40 * rate) * 0.9) };
	};
	const ppGoal = { kind: 'pp', pp: 300 };
	check('a failed play is worth no pp', !m.meets({ passed: false, accuracy: 1, pp: 999 }, ppGoal) && m.meets({ passed: true, accuracy: 0.5, pp: 300 }, ppGoal));
	const atOne = await m.findMinimum({ ...job, goal: ppGoal }, ppSim, { pace });
	check('pp a rate never pays is out of reach', !atOne.reachable);
	const atFaster = await m.findMinimum({ ...job, rate: 1.5, goal: ppGoal }, ppSim, { pace });
	check('pp takes the speed that passes at that rate', atFaster.levels.speed === 60, JSON.stringify(atFaster.levels));
	const all = await m.everyRate({ ...job, goal: ppGoal }, [1, 1.5, 2], ppSim, { pace });
	check('every rate is searched', all.rows.length === 3 && !all.partial);
	check('the fewest level ups come first', all.rows[0].rate === 1.5 && all.rows[0].ups === 30, JSON.stringify(all.rows.map(r => [r.rate, r.ups])));
	check('then the next fewest, and out of reach last', all.rows[1].rate === 2 && all.rows[1].ups === 50 && all.rows[2].rate === 1 && !all.rows[2].result.reachable);
	let calls = 0;
	const broken = await m.everyRate({ ...job, goal: ppGoal }, [1.5, 2], async body => { if (++calls > 40) throw new Error('down'); return ppSim(body); }, { pace });
	check('a sim API failure keeps the rates it finished', broken.partial && broken.error === 'down' && broken.rows.length >= 1, JSON.stringify(broken.rows.map(r => r.rate)));
}

{
	// bottlenecks: map 1 passes as is; map 2 needs speed 60 and stamina 45 (speed +30, stamina +25)
	const bSim = async body => body.beatmap_id === 1 ? { passed: true, accuracy: 1 } : sim(body);
	const sw = await m.sweepBottlenecks({ state, mods: [], minutes: 75, runs: 2, maps: [{ beatmapId: 1, rate: 1 }, { beatmapId: 2, rate: 1 }], mapPlays: () => 0, retries: 3, share: 0.1 }, bSim, { pace });
	check('a map passed first try needs nothing', sw.rows[0].status === 'passed' && !sw.rows[0].skill);
	check('a failed map gets the skill raised most', sw.rows[1].status === 'levels' && sw.rows[1].skill === 'speed' && sw.rows[1].ups === 30, JSON.stringify(sw.rows[1]));
	check('the tally counts it', JSON.stringify(m.tally(sw.rows)) === JSON.stringify([['speed', 1]]));
	check('a map passed often enough on retry is not searched', (await m.sweepBottlenecks({ state, mods: [], minutes: 75, runs: 2, maps: [{ beatmapId: 2, rate: 1 }], mapPlays: () => 0, retries: 4, share: 0.25 },
		(() => { let n = 0; return async () => ({ passed: n++ === 2, accuracy: 1 }); })(), { pace })).rows[0].status === 'retried');
}

rmSync(dir, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
