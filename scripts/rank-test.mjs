/** A pp target must rank by the pp a play scores, not by pp per second. */
import { build } from 'esbuild';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolveGameRoot } from './resolve-game.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This repository's root, so nothing depends on where it is checked out. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const game = resolveGameRoot();
const { sharedSourcePlugin, tsExtensionPlugin } =
	await import('@osu-idle/addon-sdk/build');

const dir = join(REPO_ROOT, '.ranktest');
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'e.ts'), `export { rankMaps, buildRotation } from '../src/farm/metrics.js';`);
await build({
	entryPoints: [join(dir, 'e.ts')], outfile: join(dir, 'b.mjs'), bundle: true,
	format: 'esm', platform: 'node', target: 'es2022',
	plugins: [sharedSourcePlugin(join(game.root, 'packages/shared/src')), tsExtensionPlugin()],
	absWorkingDir: REPO_ROOT,
});
const { rankMaps, buildRotation } = await import(pathToFileURL(join(dir, 'b.mjs')).href);




const map = (beatmapId, pp, durationSec, xp) => ({
	setId: beatmapId * 10, beatmapId, pp, durationSec,
	// accuracy is subject to mindblock; speed is one of the exempt skills, so
	// both are here to check the split.
	xp: { accuracy: xp, speed: xp }, totalXp: xp * 2,
	accuracy: 0.99, grade: 'S', runs: 3, failRate: 0, variation: 0,
});

// "short" scores less pp but is far quicker: a rate would rank it first.
const short = map(1, 100, 30, 300);
const long = map(2, 300, 300, 900);

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? pass++ : (fail++, console.log('  FAIL:', n, x)); };

const byRate = rankMaps([short, long], { target: { kind: 'skill', skill: 'accuracy' }, overheadSec: 0 });
check('XP target still ranks by rate', byRate[0].beatmapId === 1,
	`got ${byRate[0].beatmapId} (rates ${byRate.map(m => m.rate.toFixed(2))})`);

const byPP = rankMaps([short, long], { target: { kind: 'pp' }, overheadSec: 0 });
check('pp target ranks the higher-pp map first', byPP[0].beatmapId === 2,
	`got ${byPP[0].beatmapId}`);
check('pp target value is the pp itself', byPP[0].value === 300, `${byPP[0].value}`);

// overhead must not reorder a pp ranking
const byPPOverhead = rankMaps([short, long], { target: { kind: 'pp' }, overheadSec: 120 });
check('overhead does not change pp order', byPPOverhead[0].beatmapId === 2);

// mindblock scales XP, never score
const recent = new Map([[2, 25]]);
const blocked = rankMaps([short, long], { target: { kind: 'pp' }, recentPlays: recent });
check('mindblock does not reduce pp', blocked[0].value === 300, `${blocked[0].value}`);
const blockedXp = rankMaps([long], {
	target: { kind: 'skill', skill: 'accuracy' }, recentPlays: recent,
});
check('mindblock reduces a mindblocked skill', blockedXp[0].value < 900, `${blockedXp[0].value}`);
const exemptXp = rankMaps([long], {
	target: { kind: 'skill', skill: 'speed' }, recentPlays: recent,
});
check('mindblock leaves an exempt skill alone', exemptXp[0].value === 900, `${exemptXp[0].value}`);

// the medal bonus lands after mindblock, floored, like the server's getServerXP
const medalled = rankMaps([long], {
	target: { kind: 'skill', skill: 'accuracy' }, recentPlays: recent, medalMultiplier: 1.5,
});
check('medals scale XP after mindblock', medalled[0].value === Math.floor(blockedXp[0].value * 1.5),
	`${medalled[0].value} vs ${blockedXp[0].value}`);
const medalledPP = rankMaps([long], { target: { kind: 'pp' }, medalMultiplier: 1.5 });
check('medals do not change pp', medalledPP[0].value === 300, `${medalledPP[0].value}`);
const medalRot = buildRotation(rankMaps([long], { target: { kind: 'skill', skill: 'speed' } }),
	{ size: 1, target: { kind: 'skill', skill: 'speed' }, overheadSec: 0, medalMultiplier: 1.5 });
check('rotation applies medals', medalRot[0].rate === 1350 / 300, `${medalRot[0].rate}`);

// a pp rotation is simply the best-scoring maps
const rot = buildRotation(rankMaps([short, long], { target: { kind: 'pp' } }),
	{ size: 2, target: { kind: 'pp' } });
check('pp rotation picks best pp first', rot[0].beatmapId === 2, `${rot.map(m => m.beatmapId)}`);
check('pp rotation keeps the real pp value', rot[0].value === 300, `${rot[0].value}`);

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
