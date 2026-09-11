import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal `.env` reader: only fills vars the environment has not already set,
 *  so an explicit `OSU_IDLE_PATH=... npm run build` still wins. */
const loadEnv = () => {
	const file = join(root, '.env');
	if (!existsSync(file)) return;
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!m) continue;
		const value = m[2].trim().replace(/^["']|["']$/g, '');
		process.env[m[1]] ??= value;
	}
};
loadEnv();

/** A checkout is usable only if it actually carries the sim we bundle. */
const isGameCheckout = (dir) =>
	existsSync(join(dir, 'packages/shared/src/sim/maniaGame.ts'));

/**
 * Locate an osu!idle checkout to bundle `@osu-idle/shared` from.
 * `$OSU_IDLE_PATH` wins (local dev), then the pinned submodule.
 */
export const resolveGameRoot = () => {
	const candidates = [];
	if (process.env.OSU_IDLE_PATH) {
		const p = process.env.OSU_IDLE_PATH;
		candidates.push(['$OSU_IDLE_PATH', isAbsolute(p) ? p : resolve(root, p)]);
	}
	candidates.push(['vendor/osu-idle', join(root, 'vendor/osu-idle')]);

	for (const [label, dir] of candidates) {
		if (isGameCheckout(dir)) return { root: dir, shared: join(dir, 'packages/shared/src'), label };
	}

	throw new Error(
		'No osu!idle checkout found - the add-on bundles the sim from source.\n' +
		candidates.map(([label, dir]) => `  tried ${label}: ${dir}`).join('\n') +
		'\n\nEither:\n' +
		'  git submodule update --init --depth 1 vendor/osu-idle\n' +
		'  export OSU_IDLE_PATH=/path/to/osu-idle',
	);
};

/** The game version the bundle is pinned to, for the add-on's `gameVersion`. */
export const gameVersion = async (gameRoot) => {
	const pkg = join(gameRoot, 'package.json');
	if (!existsSync(pkg)) return '0.0.0';
	const { readFile } = await import('node:fs/promises');
	return JSON.parse(await readFile(pkg, 'utf8')).version ?? '0.0.0';
};
