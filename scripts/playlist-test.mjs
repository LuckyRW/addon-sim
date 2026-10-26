/**
 * A saved playlist must store each entry locked at its rate, in the rotation's
 * order, against the tables as oss!idle migrates them - and at its mods once
 * the game's entries carry them.
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

const entries = (mods = false) => db.exec(`SELECT beatmapId, rate${mods ? ', mods' : ''} FROM playlist_entry ORDER BY position`)[0]
	?.values.map(([id, rate, m]) => `${id}@${rate}${m ? `+${m}` : ''}`).join(' ') ?? '';

const rotation = [{ beatmapId: 1, rate: 1.3, mods: ['HR'] }, { beatmapId: 2, rate: 1, mods: [] }];

const first = await replacePlaylist('Farm', rotation);
check('creates the playlist', first.created === true);
check('every entry locked at its rate, x1 included, in order', entries() === '1@1.3 2@1', entries());

const again = await replacePlaylist('Farm', [{ beatmapId: 3, rate: 0.9, mods: [] }]);
check('replaces it in place', again.created === false
	&& db.exec('SELECT COUNT(*) FROM playlist')[0].values[0][0] === 1);
check('with exactly the new entries', entries() === '3@0.9', entries());

db.run("INSERT INTO playlist (name, createdAt) VALUES ('Farm', 2)");
await replacePlaylist('Farm', [{ beatmapId: 4, rate: 1, mods: [] }]);
check('a second "Farm" leaves the oldest one refilled', entries() === '4@1'
	&& db.exec('SELECT playlistId FROM playlist_entry')[0].values[0][0] === 1, entries());

db.run("ALTER TABLE playlist_entry ADD COLUMN mods TEXT NOT NULL DEFAULT ''");
await replacePlaylist('Farm', rotation);
check('entries keep their mods once the game stores them', entries(true) === '1@1.3+HR 2@1', entries(true));

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
