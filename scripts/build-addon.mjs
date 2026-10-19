#!/usr/bin/env node
/**
 * Build the add-on into the single ES module the workshop stores.
 *
 * Resolves the oss!idle checkout first (the sim is bundled from source), and
 * stamps the game version it was built against into the banner so a reviewer -
 * and the add-on's `gameVersion` field - can see what it targets.
 */
import { bundleAddon } from '@oss-idle/addon-sdk/build';
import { readFile } from 'node:fs/promises';
import { resolveGameRoot, gameVersion } from './resolve-game.mjs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const config = JSON.parse(await readFile(resolve(pkgRoot, 'addon.config.json'), 'utf8'));
const { version } = JSON.parse(await readFile(resolve(pkgRoot, 'package.json'), 'utf8'));

const game = resolveGameRoot();
const builtAgainst = await gameVersion(game.root);

const build = async () => {
	const started = Date.now();
	const { outfile, bytes } = await bundleAddon({
		entry: resolve(pkgRoot, config.entry),
		outfile: resolve(pkgRoot, config.outfile),
		gameRoot: game.root,
		minify: process.argv.includes('--minify'),
		// `shared/rebirth` gives us `hasUnlock`, but its module also imports the
		// onboarding zod schemas - half a megabyte the add-on never calls.
		stubModules: { 'shared/src/onboarding.ts': ['characterNameBody'] },
		// The game's sim and our decoder both use these. Without deduping they
		// are bundled twice, from two checkouts, and the game's control-point
		// decode patch then patches a copy the decoder never uses.
		dedupe: ['osu-classes', 'osu-parsers', 'osu-mania-stable'],
		dedupeFrom: pkgRoot,
		meta: {
			name: config.name,
			version,
			gameVersion: builtAgainst,
			license: config.license,
		},
	});
	console.log(
		`built ${outfile}\n  ${(bytes / 1024).toFixed(1)} kB` +
		`  |  oss!idle ${builtAgainst} (${game.label})  |  ${Date.now() - started}ms`,
	);
};

await build();

if (process.argv.includes('--watch')) {
	const { watch } = await import('node:fs');
	console.log('watching src/ ...');
	let queued;
	watch(resolve(pkgRoot, 'src'), { recursive: true }, () => {
		clearTimeout(queued);
		queued = setTimeout(() => build().catch(e => console.error(e.message)), 120);
	});
}
