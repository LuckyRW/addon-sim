/**
 * Does the add-on's pp match the server's?
 *
 * The add-on computes pp from the inlined rosu-pp *web* (wasm) build; the server
 * uses the *node* build against the same chart and score. Same play through both
 * must agree, or the pp column is quietly wrong.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolveGameRoot } from './resolve-game.mjs';

/** This repository's root, so nothing depends on where it is checked out. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const game = resolveGameRoot();
const { sharedSourcePlugin, tsExtensionPlugin, dedupePlugin, assetQueryPlugin, hostReactPlugin } =
	await import('@oss-idle/addon-sdk/build');

const dir = join(REPO_ROOT, '.pptest');
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });

// The add-on's own pp path, plus a sim to produce a real ScoreState.
writeFileSync(join(dir, 'e.ts'), `
import { BeatmapDecoder } from 'osu-parsers';
import { ManiaGame } from '@oss-idle/shared/rulesets/mania/maniaGame';
import CharacterBot from '@oss-idle/shared/rulesets/mania/4k/bots/character';
import { makeOrderedSkills } from '@oss-idle/shared/rulesets/mania/4k/skills/factory';
import { ppChart, ppReady } from '../src/engine/pp.js';


const decoder = new BeatmapDecoder();
export { ppReady, ppChart };

export function play(text: string, lvl: number, rate = 1) {
	const chart = decoder.decodeFromString(text);
	const skills = makeOrderedSkills();
	for (const s of skills) s.level.set(lvl);
	const bot = new CharacterBot(skills);
	const g = new ManiaGame(chart, bot, { rate });
	g.update(g.songEndMs + 2000);
	const s = g.score;
	return {
		score: s.score, accuracy: s.accuracy, maxCombo: s.maxCombo,
		counts: { ...s.counts },
	};
}
`);

await build({
	entryPoints: [join(dir, 'e.ts')], outfile: join(dir, 'b.mjs'), bundle: true,
	format: 'esm', platform: 'node', target: 'es2022',
	loader: { '.wasm': 'base64' },
	plugins: [
		assetQueryPlugin(),
		dedupePlugin(['osu-classes', 'osu-parsers', 'osu-mania-stable'],
			REPO_ROOT),
		sharedSourcePlugin(join(game.root, 'packages/shared/src')),
		tsExtensionPlugin(),
		// The game's modules import React hooks the sim never calls, and React is
		// not installed: a stand-in that only loads, as the worker gets.
		hostReactPlugin({ worker: true }),
	],
	absWorkingDir: REPO_ROOT,
});

const m = await import(pathToFileURL(join(dir, 'b.mjs')).href);



const available = await m.ppReady();

// The server's implementation, for comparison.
const require = createRequire(import.meta.url);
const ppjs = require('rosu-pp-js');
const serverPP = (score, chart, rate = 1, mods = '') => {
	const map = new ppjs.Beatmap(chart);
	return new ppjs.Performance({
		lazer: false,
		clockRate: rate,
		mods,
		legacyTotalScore: Math.floor(score.score),
		accuracy: Math.min(1, score.accuracy),
		combo: score.maxCombo,
		nGeki: score.counts.MARVELOUS + score.counts.DIVINE,
		n300: score.counts.PERFECT,
		nKatu: score.counts.GREAT,
		n100: score.counts.GOOD,
		n50: score.counts.BAD,
		misses: score.counts.MISS,
	}).calculate(map).pp;
};
const serverStars = (chart, rate) =>
	new ppjs.Difficulty({ lazer: false, clockRate: rate }).calculate(new ppjs.Beatmap(chart)).stars;

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? pass++ : (fail++, console.log('  FAIL:', n, x)); };

check('wasm initialised', available === true);

const cache = join(game.root, 'packages/tests/.charts-cache');
/** The game's own test suite populates this, so a checkout that has never run
 *  it - an npm install, say - cannot host the comparison. The wasm and edge
 *  cases below still run. */
const haveCharts = existsSync(cache);
const files = haveCharts ? readdirSync(cache).filter(f => f.endsWith('.osu')).slice(0, 8) : [];

if (!haveCharts) console.log(
	`  no packages/tests/.charts-cache in ${game.label} - skipping the server`
	+ " comparison; it is written by the game's own test suite, not by an install");
else console.log('chart            addon pp    server pp    diff');
let anyNonZero = false;
for (const f of files) {
	const text = readFileSync(join(cache, f), 'utf8');
	let score;
	try { score = m.play(text, 60); } catch { continue; }

	const chart = m.ppChart(text, available);
	const ours = chart.calculate(score, 1, []);
	const rated = m.play(text, 60, 1.3);
	const oursRated = chart.calculate(rated, 1.3, []);
	const starsRated = chart.stars(1.3, []);
	const oursHR = chart.calculate(score, 1, ['HR']);
	chart.free();
	check(`${f} matches server with HR`, Math.abs(oursHR - serverPP(score, text, 1, 'HR')) < 0.01);
	const theirs = serverPP(score, text);
	check(`${f} matches server at x1.3`, Math.abs(oursRated - serverPP(rated, text, 1.3)) < 0.01);
	check(`${f} stars match server at x1.3`, Math.abs(starsRated - serverStars(text, 1.3)) < 1e-6);

	if (ours > 0) anyNonZero = true;
	const diff = Math.abs(ours - theirs);
	check(`${f} matches server`, diff < 0.01, `${ours} vs ${theirs}`);
	console.log(
		f.replace('.osu', '').padEnd(15),
		ours.toFixed(2).padStart(9),
		theirs.toFixed(2).padStart(12),
		diff.toExponential(1).padStart(9),
	);
}
if (haveCharts) check('produced real pp values', anyNonZero);

// unavailable rosu must degrade to 0, not throw
const noop = m.ppChart('garbage', false);
check('no-op chart returns 0', noop.calculate({ score: 0, accuracy: 1, maxCombo: 0, counts: {} }, 1, []) === 0);
noop.free();

// a chart rosu refuses must not throw
const bad = m.ppChart('not an osu file at all', available);
check('unparseable chart returns 0 without throwing',
	bad.calculate({ score: 0, accuracy: 1, maxCombo: 0, counts: {} }, 1, []) === 0);
bad.free();

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
