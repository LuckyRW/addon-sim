/**
 * esbuild plugins the add-on build adds to the SDK's own.
 *
 * - `hpMemo` points the game's `maniaGame.ts` at `src/engine/hpMultiplier.ts`
 *   for its `./scoring.js` import, so the HP multiplier is computed once per map
 *   and rate rather than once per run.
 * - `zodStub` and `lzmaStub` drop two libraries the add-on carries but never
 *   runs - over a megabyte between them, and the game's server refuses a
 *   request body over 2 MB, so the in-game editor could not save the add-on.
 */
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const shim = resolve(dirname(fileURLToPath(import.meta.url)), '../src/engine/hpMultiplier.ts');

/**
 * `applied()` reports whether the redirect ever fired: a build that silently
 * skipped it (a game that moved the import) would still work, just slower, so
 * the build checks.
 */
export const hpMemo = () => {
	let hit = false;
	return {
		applied: () => hit,
		plugin: {
			name: 'hp-multiplier-memo',
			setup(build) {
				build.onResolve({ filter: /^\.\/scoring\.js$/ }, args => {
					if (!args.importer.endsWith(`${sep}mania${sep}maniaGame.ts`)) return undefined;
					hit = true;
					return { path: shim };
				});
			},
		},
	};
};

/** Replace a bare import with `contents`, wherever it is imported from. */
const replace = (name, filter, contents) => ({
	name,
	setup(build) {
		build.onResolve({ filter }, args => ({ path: args.path, namespace: name }));
		build.onLoad({ filter: /.*/, namespace: name }, () => ({ contents, loader: 'js' }));
	},
});

/**
 * zod, as a schema that builds but never validates. The game's `rate.ts`
 * builds a schema when it is imported, which the add-on reaches for its rate
 * helpers; nothing in the add-on parses with one, and parsing throws.
 */
export const zodStub = () => replace('zod-stub', /^zod$/, `
const used = () => { throw new Error('zod was stubbed out of this add-on bundle but is being used to validate'); };
const PARSE = new Set(['parse', 'safeParse', 'parseAsync', 'safeParseAsync']);
const schema = new Proxy(function () {}, {
	get: (_, key) => typeof key === 'symbol' || key === 'then' ? undefined : PARSE.has(key) ? used : schema,
	apply: () => schema,
});
export const z = schema;
export default schema;
`);

/** lzma, which osu-parsers needs only to decode replays - the add-on decodes charts. */
export const lzmaStub = () => replace('lzma-stub', /^lzma-js-simple-v2$/, `
const used = () => { throw new Error('lzma was stubbed out of this add-on bundle but is being used'); };
export const compress = used;
export const decompress = used;
`);
