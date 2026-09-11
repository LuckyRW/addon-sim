/**
 * Where the add-on's sweep time actually goes.
 *
 * Runs the worker's exact simulation path over cached charts and splits the
 * cost into decode / ruleset+construct / play / xp. Takes `--patch` to import
 * the game's control-point decode patch, which every decode site in the game
 * imports and the add-on (currently) does not - the driver runs both in
 * separate processes, since the patch is a one-way prototype change.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { resolveGameRoot } from './resolve-game.mjs';

/** This repository's root, so nothing depends on where it is checked out. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const withPatch = process.argv.includes('--patch');
const game = resolveGameRoot();
const { sharedSourcePlugin, tsExtensionPlugin, dedupePlugin } =
	await import('@osu-idle/addon-sdk/build');

const dir = join(REPO_ROOT, `.bench-${withPatch ? 'patched' : 'plain'}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

writeFileSync(join(dir, 'e.mjs'), `
${withPatch ? "import '@osu-idle/shared/osu/controlPointPatch';" : ''}
import { BeatmapDecoder } from 'osu-parsers';
import { ManiaGame } from '@osu-idle/shared/sim/maniaGame';
import CharacterBot from '@osu-idle/shared/sim/bots/character';
import { makeOrderedSkills } from '@osu-idle/shared/sim/skills/factory';


const decoder = new BeatmapDecoder();
const now = () => Number(process.hrtime.bigint()) / 1e6;

const skillsAt = (lvl) => {
	const s = makeOrderedSkills();
	for (const k of s) k.level.set(lvl);
	return s;
};

export function bench(text, lvl, runs) {
	let t = now();
	const chart = decoder.decodeFromString(text);
	const decodeMs = now() - t;

	let buildMs = 0, playMs = 0, xpMs = 0, notes = 0;
	for (let i = 0; i < runs; i++) {
		t = now();
		const bot = new CharacterBot(skillsAt(lvl), chart.difficulty.overallDifficulty);
		const g = new ManiaGame(chart, bot, {});
		buildMs += now() - t;
		notes = g.totalNotes;

		t = now();
		g.update(g.songEndMs + 2000);
		playMs += now() - t;

		t = now();
		bot.getSkillsXP(chart.totalLength, g.score);
		xpMs += now() - t;
	}
	return { decodeMs, buildMs, playMs, xpMs, notes };
}
`);

await build({
	entryPoints: [join(dir, 'e.mjs')], outfile: join(dir, 'b.mjs'), bundle: true,
	format: 'esm', platform: 'node', target: 'es2022',
	plugins: [
		// Same dedupe the real add-on build uses - without it the patch would
		// bind to a second copy of osu-classes and appear to do nothing.
		dedupePlugin(['osu-classes', 'osu-parsers', 'osu-mania-stable'],
			REPO_ROOT),
		sharedSourcePlugin(join(game.root, 'packages/shared/src')),
		tsExtensionPlugin(),
	],
	absWorkingDir: REPO_ROOT,
});
const { bench } = await import(pathToFileURL(join(dir, 'b.mjs')).href);




const cache = join(game.root, 'packages/tests/.charts-cache');
const files = readdirSync(cache).filter(f => f.endsWith('.osu'));
const RUNS = 3;

console.log(`\n${withPatch ? 'WITH' : 'WITHOUT'} controlPointPatch   (runs/map = ${RUNS})`);
console.log('chart            notes    decode     build      play       xp     total   notes/s');

let totals = { decodeMs: 0, buildMs: 0, playMs: 0, xpMs: 0, notes: 0 };
for (const f of files) {
	const text = readFileSync(join(cache, f), 'utf8');
	let r;
	try { r = bench(text, 50, RUNS); } catch (e) { console.log(f.padEnd(15), 'ERROR', e.message); continue; }
	const total = r.decodeMs + r.buildMs + r.playMs + r.xpMs;
	for (const k of ['decodeMs', 'buildMs', 'playMs', 'xpMs']) totals[k] += r[k];
	totals.notes += r.notes;
	console.log(
		f.replace('.osu', '').padEnd(15),
		String(r.notes).padStart(6),
		(r.decodeMs.toFixed(0) + 'ms').padStart(9),
		(r.buildMs.toFixed(0) + 'ms').padStart(9),
		(r.playMs.toFixed(0) + 'ms').padStart(9),
		(r.xpMs.toFixed(0) + 'ms').padStart(8),
		(total.toFixed(0) + 'ms').padStart(9),
		Math.round((r.notes * RUNS) / (r.playMs / 1000)).toLocaleString().padStart(10),
	);
}
const grand = totals.decodeMs + totals.buildMs + totals.playMs + totals.xpMs;
console.log('-'.repeat(84));
console.log(
	'TOTAL'.padEnd(15), String(totals.notes).padStart(6),
	(totals.decodeMs.toFixed(0) + 'ms').padStart(9),
	(totals.buildMs.toFixed(0) + 'ms').padStart(9),
	(totals.playMs.toFixed(0) + 'ms').padStart(9),
	(totals.xpMs.toFixed(0) + 'ms').padStart(8),
	(grand.toFixed(0) + 'ms').padStart(9),
);
console.log(
	'share'.padEnd(22),
	(100 * totals.decodeMs / grand).toFixed(0).padStart(8) + '%',
	(100 * totals.buildMs / grand).toFixed(0).padStart(8) + '%',
	(100 * totals.playMs / grand).toFixed(0).padStart(8) + '%',
	(100 * totals.xpMs / grand).toFixed(0).padStart(7) + '%',
);
rmSync(dir, { recursive: true, force: true });
