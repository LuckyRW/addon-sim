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
import { hpMemo as makeHpMemo, lzmaStub, zodStub } from './bundle-plugins.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const config = JSON.parse(await readFile(resolve(pkgRoot, 'addon.config.json'), 'utf8'));
const { version } = JSON.parse(await readFile(resolve(pkgRoot, 'package.json'), 'utf8'));

const MB = 1024 * 1024;
const UPLOAD_CAP = 2 * MB;

const game = resolveGameRoot();
const builtAgainst = await gameVersion(game.root);
// oss!idle reads the release an add-on targets from addon.config.json when it
// builds it from this repository, so that has to name the release bundled here.
if (config.gameVersion !== builtAgainst) {
	throw new Error(`addon.config.json says gameVersion ${config.gameVersion}, but the bundled`
		+ ` oss!idle is ${builtAgainst} - set it to ${builtAgainst}`);
}

const build = async () => {
	const started = Date.now();
	const hpMemo = makeHpMemo();
	const { outfile, bytes } = await bundleAddon({
		entry: resolve(pkgRoot, config.entry),
		outfile: resolve(pkgRoot, config.outfile),
		gameRoot: game.root,
		// Minified, to keep well under the server's upload cap (checked below).
		minify: true,
		// `shared/rebirth` gives us `hasUnlock`, but its module also imports the
		// onboarding zod schemas - half a megabyte the add-on never calls.
		stubModules: { 'shared/src/onboarding.ts': ['characterNameBody'] },
		// The game's sim and our decoder both use these. Without deduping they
		// are bundled twice, from two checkouts, and the game's control-point
		// decode patch then patches a copy the decoder never uses.
		dedupe: ['osu-classes', 'osu-parsers', 'osu-mania-stable'],
		dedupeFrom: pkgRoot,
		plugins: [hpMemo.plugin, zodStub(), lzmaStub()],
		// React from the game (1.2 and later hands it to add-ons) instead of a bundled copy.
		sharedReact: config.sharedReact,
		meta: {
			name: config.name,
			version,
			gameVersion: builtAgainst,
			license: config.license,
		},
	});
	if (!hpMemo.applied()) {
		throw new Error('the HP multiplier cache was not applied - the SDK needs the `plugins` option'
			+ ' (@oss-idle/addon-sdk 0.6.0), and maniaGame.ts must still import ./scoring.js');
	}
	// The in-game editor saves the add-on as JSON, and the game's server refuses
	// a request body over 2 MB (`bodyCap` in its app.ts).
	const upload = Buffer.byteLength(JSON.stringify({ source: await readFile(outfile, 'utf8') }));
	if (upload > UPLOAD_CAP) {
		throw new Error(`${outfile} is ${(upload / MB).toFixed(2)} MB to upload - over the server's`
			+ ` ${UPLOAD_CAP / MB} MB cap, so the in-game editor could not save it`);
	}
	console.log(
		`built ${outfile}\n  ${(bytes / 1024).toFixed(1)} kB  (${(upload / MB).toFixed(2)} MB to upload)` +
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
