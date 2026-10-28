/** A fast scan: the maps players near your level played lately, and a share of the rest. */
import { build } from 'esbuild';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolveGameRoot } from './resolve-game.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This repository's root, so nothing depends on where it is checked out. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const game = resolveGameRoot();
const { sharedSourcePlugin, tsExtensionPlugin } = await import('@oss-idle/addon-sdk/build');

const dir = join(REPO_ROOT, '.scouttest');
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'e.ts'), `export * from '../src/engine/scout.js';\n`);
await build({
	entryPoints: [join(dir, 'e.ts')], outfile: join(dir, 'b.mjs'), bundle: true,
	format: 'esm', platform: 'node', target: 'es2022', logLevel: 'error',
	plugins: [sharedSourcePlugin(join(game.root, 'packages/shared/src')), tsExtensionPlugin()],
	absWorkingDir: REPO_ROOT,
});
const m = await import(pathToFileURL(join(dir, 'b.mjs')).href);

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? pass++ : (fail++, console.log('  FAIL:', n, x)); };

// a speed ranking of 120 characters, 20 a page, from level 119 down; you are character 60 at level 60
const ranked = Array.from({ length: 120 }, (_, i) => ({ user: { character_id: i, id: 1000 + i }, skill: { level: 119 - i } }));
const pagesRead = [];
const scoresRead = [];
const api = {
	skillRankings: async (skill, { page }) => {
		pagesRead.push(page);
		const ranking = ranked.slice((page - 1) * 20, page * 20);
		return { ranking, cursor: page * 20 < ranked.length ? { page: page + 1 } : undefined };
	},
	characterScores: async (id, type) => {
		scoresRead.push([id, type]);
		if (id === 61) throw Object.assign(new Error('restricted'), { status: 404 });
		// each character recently played map 5000 + its id, at x1.2; and map 1 at x1 and x1.3
		return [{ beatmap_id: 5000 + id, rate: 1.2 }, { beatmap_id: 1, rate: 1 }, { beatmap_id: 1, rate: 1.3 }];
	},
};

const scouted = await m.scoutRecent(api, { speed: 60 }, 60);
check('ranking pages stop once past your level', pagesRead.join() === '1,2,3,4', pagesRead.join());
check('only recent scores are read', scoresRead.every(([, type]) => type === 'recent'));
const readIds = scoresRead.map(([id]) => id);
check('the players read are the nearest to your level', readIds.length === 30 && readIds.every(id => Math.abs((119 - id) - 60) <= 16), readIds.join());
check('you are left out', !readIds.includes(60));
check('a player who cannot be read is skipped, not fatal', scouted.size > 0 && !scouted.has(5061));
check('a map is counted once per player', scouted.get(1)?.players === 29, scouted.get(1)?.players);
check('each rate they played is kept', [...scouted.get(1).rates].sort().join() === '1,1.3');

// what the fast scan simulates
const library = [1, 5059, 9999, 9998].map(beatmapId => ({ setId: beatmapId, beatmapId }));
const rates = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4];
const screened = [0.8, 1, 1.4];
const none = m.scoutedRequests(library, scouted, rates, screened, 0.15, () => 0.99);
check('without the explore roll, only scouted maps', none.map(map => map.beatmapId).join() === '1,5059', none.map(map => map.beatmapId).join());
check('a scouted map adds the rates they played to the screened ones', none[0].rates.join() === '0.8,1,1.3,1.4', none[0].rates.join());
check('a rate you cannot play is not added', none[1].rates.join() === '0.8,1,1.2,1.4', none[1].rates.join());
const all = m.scoutedRequests(library, scouted, rates, screened, 0.15, () => 0);
check('the explore share screens the rest at the screened rates', all.length === 4 && all[2].rates.join() === '0.8,1,1.4');

// your levels: the skills you farm, at their play level
const row = { speed: 20, speedXP: 0, speedLifetimeXp: 0, speedPrestige: 1, stamina: 50, accuracy: 70 };
check('a weighted target scouts the skills it weighs', JSON.stringify(m.farmLevels(row, { kind: 'skills', weights: { speed: 1, stamina: 0 } })) === '{"speed":21}');
check('a total target scouts your two highest physical skills', Object.keys(m.farmLevels(row, { kind: 'total' })).sort().join() === 'speed,stamina');

rmSync(dir, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
