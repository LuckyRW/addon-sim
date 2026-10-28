/**
 * esbuild plugins the add-on build adds to the SDK's own.
 *
 * - `zodStub` drops a library the add-on carries but never runs: the game's
 *   server refuses a request body over 2 MB, so the in-game editor could not
 *   save an add-on that big.
 */

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
