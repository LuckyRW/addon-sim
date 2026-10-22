/** A worker that dies costs the sweep one map, not the sweep - and a bundle
 *  whose workers never start fails the sweep instead of skipping every map. */
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
	// The kit and the game are stubbed, and the worker is a fake the test
	// scripts through `globalThis.fakeWorker`.
	plugins: [{
		name: 'stub-deps',
		setup(b) {
			b.onResolve({ filter: /^(@oss-idle\/addon-sdk|@oss-idle\/shared\/.*|worker:.*)$/ },
				a => ({ path: a.path, namespace: 'stub' }));
			b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
				contents: 'export default () => globalThis.fakeWorker();'
					+ ' export const beatmapStore = {}; export const gameDb = {};'
					+ ' export const gameCharacter = { live: async () => ({ id: 1 }) };'
					+ ' export const playCountsSince = async () => ({});'
					+ ' export const hasUnlock = () => false;'
					+ ' export const medalXPMultiplier = () => 1;'
					+ ' export const rateSteps = () => [1];',
				loader: 'js',
			}));
		},
	}],
});
const { runSweep } = await import(pathToFileURL(join(dir, 'b.mjs')).href);

/** A worker that simulates every map but `crashOn`, and dies on that one. */
const fake = (crashOn, { silent = false } = {}) => () => {
	const worker = {
		terminated: false,
		terminate() { this.terminated = true; },
		postMessage(job) {
			setTimeout(() => {
				if (silent) return worker.onerror({ message: 'bad bundle', preventDefault() {} });
				for (const { beatmapId, rates } of job.maps) {
					if (worker.terminated) return;
					if (beatmapId === crashOn) {
						return worker.onerror({ message: 'out of memory', preventDefault() {} });
					}
					for (const rate of rates) {
						worker.onmessage({ data: { type: 'result', result: { setId: job.setId, beatmapId, rate } } });
					}
					worker.onmessage({ data: { type: 'map', beatmapId } });
				}
				worker.onmessage({ data: { type: 'idle' } });
			});
		},
	};
	return worker;
};

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? pass++ : (fail++, console.log('  FAIL:', n, x)); };

// three sets; the crash lands mid-set, so the rest of that set must be requeued
const requests = [
	{ setId: 1, beatmapId: 10, rates: [1] }, { setId: 1, beatmapId: 11, rates: [1] },
	{ setId: 2, beatmapId: 20, rates: [1, 1.1] }, { setId: 2, beatmapId: 21, rates: [1] },
	{ setId: 2, beatmapId: 22, rates: [1] }, { setId: 3, beatmapId: 30, rates: [1] },
];
globalThis.fakeWorker = fake(21);
let last;
const sweep = await runSweep(requests, { runs: 1 }, progress => { last = progress; });
const { results, errors, cancelled } = await sweep.finished;
check('every map is accounted for', last.done === requests.length, `${last.done}`);
check('the crashing map is the one skipped', errors.length === 1 && errors[0].beatmapId === 21,
	JSON.stringify(errors));
check('the rest of its set still ran', results.some(r => r.beatmapId === 22));
check('every other rate has a result', results.length === 6, `${results.length}`);
check('not reported as cancelled', !cancelled);

// a worker that never says anything means the bundle is broken: fail, do not skip
globalThis.fakeWorker = fake(undefined, { silent: true });
const broken = await runSweep(requests, { runs: 1 });
const outcome = await broken.finished.then(() => 'resolved', e => e.message);
check('a broken worker fails the sweep', outcome.endsWith('bad bundle'), outcome);

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
