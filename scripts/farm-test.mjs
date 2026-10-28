/** The farm worker: the playlist it sends is the one the search makes, plays streaming in
 *  update it at most every few seconds while a setting changes it at once, and what it
 *  sends the game's thread stays small. */
import { build } from 'esbuild';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolveGameRoot } from './resolve-game.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const game = resolveGameRoot();
const { sharedSourcePlugin, tsExtensionPlugin } = await import('@oss-idle/addon-sdk/build');

const dir = join(REPO_ROOT, '.farmtest');
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'm.ts'), `export * from '../src/farm/metrics.js';\nexport * from '../src/farm/session.js';\n`);
const plugins = [sharedSourcePlugin(join(game.root, 'packages/shared/src')), tsExtensionPlugin()];
for (const [entry, out] of [[join(dir, 'm.ts'), 'm.mjs'], [join(REPO_ROOT, 'src/farm/farm.worker.ts'), 'w.mjs']]) {
	await build({ entryPoints: [entry], outfile: join(dir, out), bundle: true, format: 'esm', platform: 'node',
		target: 'es2022', plugins, absWorkingDir: REPO_ROOT });
}
const m = await import(pathToFileURL(join(dir, 'm.mjs')).href);

// the worker's global: what it posts lands in `out`, each a structured clone as postMessage makes it
const out = [];
globalThis.self = { postMessage: message => out.push(structuredClone(message)) };
await import(pathToFileURL(join(dir, 'w.mjs')).href);
let seq = 0;
const send = message => self.onmessage({ data: { ...message, seq: ++seq } });
const idle = () => new Promise(resolve => setTimeout(resolve, 50));

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? pass++ : (fail++, console.log('  FAIL:', n, x)); };

let seed = 1; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const gear = 0, peak = m.peakMinutes(gear);
const results = [];
for (let id = 1; id <= 1500; id++) {
	const len = 90 + rnd() * 240, share = rnd() * 0.8;
	for (const rate of [1, 1.1]) for (const mods of [[], ['HR']]) {
		const lengthMin = len / rate / 60, xp = 50 + rnd() * 400 * rate;
		results.push({ setId: id, beatmapId: id, rate, mods, minutes: peak, xp: { speed: xp, stamina: xp / 3 },
			totalXp: xp * 1.33, durationSec: len / rate + 2, lengthMin, strained: lengthMin * share, accuracy: 0.97,
			grade: 'A', pp: 100, runs: 1, failRate: 0, variation: 0 });
	}
}
const target = { kind: 'skills', skills: ['speed'] };
const settings = {
	target, recentPlays: new Map(), delaySec: 3, maxFailRate: 0.5, medals: 1, noPp: new Set(),
	gear, warmingUp: false, size: 10, band: m.STEADY_BAND, pinned: [], excluded: new Set(), oneMapPerSet: false, withBest: false,
};

// a setting is answered at once, plays streaming in wait for the next update
send({ type: 'settings', settings });
send({ type: 'reset' });
send({ type: 'plays', peaks: results.slice(0, 3000) });
await idle();
const first = out.filter(o => o.type === 'view');
check('a setting gets a view at once', first.length === 1, `${first.length}`);
send({ type: 'plays', peaks: results.slice(3000) });
await idle();
check('plays streaming in wait for the next update', out.filter(o => o.type === 'view').length === 1);

// the view is what the search makes of every play, and says so
const ranked = m.rankMaps(results, settings);
const lookup = m.stateLookup([], gear, m.coldCurve([], new Map(), gear));
const session = { target, lookup, sessionSec: m.HOLD_HOURS * 3600, startMinutes: m.midPeakMinutes(gear), delaySec: 3,
	gear, medals: 1, recentPlays: new Map() };
const direct = m.buildRotation(ranked, { ...session, size: 10, band: m.STEADY_BAND }).map(m.playKey);
send({ type: 'settings', settings: { ...settings } });
await idle();
const view = out.filter(o => o.type === 'view').at(-1);
check('the playlist is the search\'s', JSON.stringify(view.rotation.map(m.playKey)) === JSON.stringify(direct),
	`${view.rotation.map(m.playKey)} vs ${direct}`);
check('it counts every play and map', view.plays === results.length && view.maps === 1500, `${view.plays} ${view.maps}`);
check('it is up to date', view.upTo === seq, `${view.upTo} ${seq}`);
check('no maps list unless asked', view.best === undefined);

// the Maps tab's list comes with the same objects as the playlist's, so its rows see them picked
send({ type: 'settings', settings: { ...settings, withBest: true } });
await idle();
const withBest = out.filter(o => o.type === 'view').at(-1);
check('the maps list when asked', withBest.best?.length === 1500, `${withBest.best?.length}`);
check('as table rows: no more of a play than a row shows', withBest.best[0].xp === undefined && withBest.best[0].perSecond > 0,
	JSON.stringify(withBest.best[0]));

// a scan's questions
self.onmessage({ data: { type: 'best', id: 1, rank: settings, count: 8 } });
const best = out.find(o => o.type === 'answer' && o.id === 1)?.value;
check('the best difficulties, once each', best?.length === 8 && new Set(best.map(b => b.beatmapId)).size === 8);
self.onmessage({ data: { type: 'refine', id: 2, rank: settings, rates: [1, 1.1, 1.2], screened: [1, 1.1], maps: 5, mods: [[]], minutes: peak } });
const plan = out.find(o => o.type === 'answer' && o.id === 2)?.value;
check('a refine plan', Array.isArray(plan) && plan.length === 5, JSON.stringify(plan?.length));

// what the game's thread pays per update: the clone of what it receives
const time = message => { const t = performance.now(); for (let i = 0; i < 20; i++) structuredClone(message); return (performance.now() - t) / 20; };
console.log(`  per update: view ${time(view).toFixed(2)} ms, with the maps list ${time(withBest).toFixed(2)} ms,`
	+ ` a batch of 200 plays sent ${time({ type: 'plays', peaks: results.slice(0, 200) }).toFixed(2)} ms`);

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
