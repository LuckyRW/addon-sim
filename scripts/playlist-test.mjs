/**
 * A saved playlist must store each entry at the rate the lock asks for, against
 * the tables as oss!idle 1.2.3.0 migrates them, in the rotation's order.
 */
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This repository's root, so nothing depends on where it is checked out. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const require = createRequire(import.meta.url);
const SQL = await require('sql.js')();
const db = new SQL.Database();

db.run(`
CREATE TABLE playlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, createdAt INTEGER
);
CREATE TABLE playlist_entry (
  id INTEGER PRIMARY KEY AUTOINCREMENT, playlistId INTEGER NOT NULL, beatmapId INTEGER NOT NULL,
  rate REAL NOT NULL DEFAULT 0, position INTEGER NOT NULL, repeat INTEGER NOT NULL DEFAULT 1
);
`);

globalThis.window = { db: { read: async fn => fn(db), write: async fn => fn(db) } };

const dir = join(REPO_ROOT, '.playlisttest');
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'e.ts'), `export { replacePlaylist } from '../src/engine/playlist.js';`);
await build({
	entryPoints: [join(dir, 'e.ts')], outfile: join(dir, 'b.mjs'), bundle: true,
	format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
	conditions: ['import', 'default'],
	absWorkingDir: REPO_ROOT,
});
const { replacePlaylist } = await import(pathToFileURL(join(dir, 'b.mjs')).href);

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? pass++ : (fail++, console.log('  FAIL:', n, x)); };

const entries = () => db.exec('SELECT beatmapId, rate FROM playlist_entry ORDER BY position')[0]
	?.values.map(([id, rate]) => `${id}@${rate}`).join(' ') ?? '';

// one difficulty at two rates, and one at x1
const rotation = [{ beatmapId: 1, rate: 1.3 }, { beatmapId: 1, rate: 0.8 }, { beatmapId: 2, rate: 1 }];

const first = await replacePlaylist('Farm', rotation, 'all');
check('creates the playlist', first.created === true);
check('all: every entry locked, x1 included, in order', entries() === '1@1.3 1@0.8 2@1', entries());

const again = await replacePlaylist('Farm', rotation, 'rated');
check('replaces it in place', again.created === false
	&& db.exec('SELECT COUNT(*) FROM playlist')[0].values[0][0] === 1);
check('all but x1: x1 follows the mod', entries() === '1@1.3 1@0.8 2@0', entries());

await replacePlaylist('Farm', [{ beatmapId: 1, rate: 0.75 }, { beatmapId: 2, rate: 0.75 }], 'none');
check('none: every entry follows the mod', entries() === '1@0 2@0', entries());

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
