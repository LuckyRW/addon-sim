/**
 * Does the add-on actually overwrite an existing playlist?
 *
 * Runs the real `playlists` module against a real sql.js database carrying the
 * client's playlist schema, with `window.db` stubbed by the same read/write
 * contract the client publishes.
 */
import { createRequire } from 'node:module';
import { resolveGameRoot } from './resolve-game.mjs';
import { build } from 'esbuild';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This repository's root, so nothing depends on where it is checked out. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');


const game = resolveGameRoot();
const require = createRequire(join(game.root, 'package.json'));
const initSqlJs = require('sql.js');
const SQL = await initSqlJs();
const db = new SQL.Database();

// The client's schema, as its DDL generator emits it.
db.run(`
CREATE TABLE IF NOT EXISTS playlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_entry (
  playlistId INTEGER NOT NULL,
  beatmapId INTEGER NOT NULL,
  PRIMARY KEY (playlistId, beatmapId)
);
CREATE INDEX IF NOT EXISTS idx_playlist_entry_beatmap ON playlist_entry(beatmapId);
`);

let writes = 0;
globalThis.window = {
	db: {
		read: async fn => fn(db),
		write: async fn => { writes++; return fn(db); },
	},
};

// Bundle the add-on's playlist module (it imports the kit by package name).
const dir = join(REPO_ROOT, '.pltest');
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'e.ts'), `export { playlists } from '../src/farm/playlists.js';`);
await build({
	entryPoints: [join(dir, 'e.ts')], outfile: join(dir, 'b.mjs'),
	bundle: true, format: 'esm', platform: 'neutral',
	mainFields: ['module', 'main'], conditions: ['import', 'default'],
	absWorkingDir: REPO_ROOT,
});
const { playlists } = await import(pathToFileURL(join(dir, 'b.mjs')).href);




const rows = sql => { const r = db.exec(sql); return r[0] ? r[0].values : []; };
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
	cond ? pass++ : (fail++, console.log('  FAIL:', name, extra));
};

// 1. create
const first = await playlists.replace('Farm: total', [101, 102, 103]);
const id1 = first.id;
check('reports it created', first.created === true);
check('creates the playlist', rows('SELECT COUNT(*) FROM playlist')[0][0] === 1);
check('inserts every entry', rows('SELECT COUNT(*) FROM playlist_entry')[0][0] === 3);

// 2. overwrite with a different set of maps
const second = await playlists.replace('Farm: total', [201, 202]);
const id2 = second.id;
check('reports it replaced', second.created === false);
check('does NOT create a second playlist',
	rows('SELECT COUNT(*) FROM playlist')[0][0] === 1,
	`got ${rows('SELECT COUNT(*) FROM playlist')[0][0]}`);
check('keeps the same playlist id', id1 === id2, `${id1} vs ${id2}`);
check('old entries are gone',
	rows('SELECT beatmapId FROM playlist_entry ORDER BY beatmapId').flat().join() === '201,202',
	rows('SELECT beatmapId FROM playlist_entry').flat().join());

// 3. shrinking
await playlists.replace('Farm: total', [201]);
check('shrinks correctly', rows('SELECT COUNT(*) FROM playlist_entry')[0][0] === 1);

// 4. a second, differently named playlist is untouched
await playlists.replace('Farm: speed', [301, 302]);
check('other playlist created', rows('SELECT COUNT(*) FROM playlist')[0][0] === 2);
await playlists.replace('Farm: total', [401]);
check('overwriting one leaves the other alone',
	rows("SELECT COUNT(*) FROM playlist_entry e JOIN playlist p ON p.id=e.playlistId WHERE p.name='Farm: speed'")[0][0] === 2);

// 5. duplicate map ids in the input must not violate the composite key
await playlists.replace('Farm: dupes', [501, 501, 502]);
check('duplicate ids collapse',
	rows("SELECT COUNT(*) FROM playlist_entry e JOIN playlist p ON p.id=e.playlistId WHERE p.name='Farm: dupes'")[0][0] === 2);

// 6. names are parameterised, not interpolated
await playlists.replace("Rob'); DROP TABLE playlist;--", [601]);
check('quotes in names are safe', rows('SELECT COUNT(*) FROM playlist')[0][0] === 4);

// 7. empty rotation
await playlists.replace('Farm: empty', []);
check('empty playlist is created with no entries',
	rows("SELECT COUNT(*) FROM playlist_entry e JOIN playlist p ON p.id=e.playlistId WHERE p.name='Farm: empty'")[0][0] === 0);

// 8. duplicate names (the game allows them) resolve deterministically
db.run("INSERT INTO playlist (name, createdAt) VALUES ('Dupe', 1), ('Dupe', 2)");
const dupeIds = rows("SELECT id FROM playlist WHERE name='Dupe' ORDER BY id").flat();
const r1 = await playlists.replace('Dupe', [701]);
const r2 = await playlists.replace('Dupe', [702]);
check('picks the same duplicate every time', r1.id === r2.id, `${r1.id} vs ${r2.id}`);
check('picks the oldest duplicate', r1.id === dupeIds[0], `${r1.id} vs ${dupeIds[0]}`);
check('leaves the other duplicate alone',
	rows(`SELECT COUNT(*) FROM playlist_entry WHERE playlistId=${dupeIds[1]}`)[0][0] === 0);

// 9. writes go through the persisting path
check('all mutations used the write path', writes > 0, `writes=${writes}`);

console.log(`\n${pass} passed, ${fail} failed  (write-path calls: ${writes})`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
