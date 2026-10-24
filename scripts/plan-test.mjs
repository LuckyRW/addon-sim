/** planSweep must list each difficulty once - duplicate ids break the table's
 *  React keys, which is what makes stale rows survive a re-sort. */
import { build } from 'esbuild';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This repository's root, so nothing depends on where it is checked out. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');


const dir = join(REPO_ROOT, '.plantest');
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'e.ts'), `export { planSweep } from '../src/engine/client.js';`);
await build({
	entryPoints: [join(dir, 'e.ts')], outfile: join(dir, 'b.mjs'), bundle: true,
	format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
	conditions: ['import', 'default'],
	absWorkingDir: REPO_ROOT,
	// planSweep is pure, but its module also pulls in the kit, the game's
	// rebirth and rate helpers and the worker factory. Stub them: the test is about the
	// planning logic, not what the sweep would then do with it.
	plugins: [{
		name: 'stub-deps',
		setup(b) {
			b.onResolve({ filter: /^(@oss-idle\/addon-sdk|@oss-idle\/shared\/.*|worker:.*)$/ },
				a => ({ path: a.path, namespace: 'stub' }));
			b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
				contents: 'export default () => {}; export const beatmapStore = {};'
					+ ' export const gameCharacter = {}; export const gameDb = {};'
					+ ' export const playCountsSince = async () => ({});'
					+ ' export const hasUnlock = () => false;'
					+ ' export const medalXPMultiplier = () => 1;'
					+ ' export const allowedRate = () => 1; export const rateSteps = () => [1];',
				loader: 'js',
			}));
		},
	}],
});
const { planSweep } = await import(pathToFileURL(join(dir, 'b.mjs')).href);




const v = (id, mode = 3, keys = 4) => ({ id, mode, keys });
let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? pass++ : (fail++, console.log('  FAIL:', n, x)); };

let r = planSweep([{ id: 1, versions: [v(10), v(11)] }]);
check('lists playable difficulties', r.requests.length === 2);
check('no duplicates reported', r.duplicates === 0);

// same beatmapId under two stored sets (stale set record after a re-download)
r = planSweep([{ id: 1, versions: [v(10)] }, { id: 2, versions: [v(10), v(12)] }]);
check('cross-set duplicate dropped', r.requests.length === 2, JSON.stringify(r.requests));
check('duplicate counted', r.duplicates === 1);
check('keeps the first set for it', r.requests[0].setId === 1);

// same id twice inside one set
r = planSweep([{ id: 1, versions: [v(10), v(10)] }]);
check('within-set duplicate dropped', r.requests.length === 1);

// non-4K is skipped, not counted as duplicate
r = planSweep([{ id: 1, versions: [v(10, 0), v(11, 3, 7), v(12)] }]);
check('non-mania and non-4K skipped', r.requests.length === 1, JSON.stringify(r.requests));
check('skips counted', r.skippedMode === 2);

// every emitted id is unique - the property the table depends on
const many = Array.from({ length: 50 }, (_, i) => ({
	id: i, versions: [v(i % 10), v(100 + i)],
}));
r = planSweep(many);
const ids = r.requests.map(x => x.beatmapId);
check('all emitted ids unique', new Set(ids).size === ids.length);

r = planSweep([{ id: 1 }]);
check('a set with no versions is fine', r.requests.length === 0);

// with a ranked list, only ranked difficulties are simulated
r = planSweep([{ id: 1, versions: [v(10), v(11), v(12, 0)] }, { id: 2, versions: [v(10)] }], new Set([10]));
check('unranked difficulty dropped', r.requests.length === 1 && r.requests[0].beatmapId === 10, JSON.stringify(r.requests));
check('unranked counted once, apart from mode skips and duplicates',
	r.skippedUnranked === 1 && r.skippedMode === 1 && r.duplicates === 1, JSON.stringify(r));
r = planSweep([{ id: 1, versions: [v(10), v(11)] }]);
check('no ranked list keeps everything', r.requests.length === 2 && r.skippedUnranked === 0);

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
