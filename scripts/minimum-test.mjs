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
writeFileSync(join(dir, 'e.ts'), `export * from '../src/engine/minimum.js';\n`);
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

rmSync(dir, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
