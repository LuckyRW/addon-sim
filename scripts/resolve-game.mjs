import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A checkout is usable only if it actually carries the sim we bundle. */
const isGameCheckout = (dir) =>
	existsSync(join(dir, 'packages/shared/src/sim/maniaGame.ts'));

/**
 * The oss!idle checkout to bundle `@oss-idle/shared` from: the pinned
 * submodule, and only that.
 *
 * A working clone of the game is the wrong source - it carries unreleased work,
 * so the add-on would ship a simulation no server runs. The submodule pins a
 * public release, which is what the bundle's `gameVersion` claims.
 */
export const resolveGameRoot = () => {
	const dir = join(root, 'vendor/oss-idle');
	if (isGameCheckout(dir)) {
		return { root: dir, shared: join(dir, 'packages/shared/src'), label: 'vendor/oss-idle' };
	}

	throw new Error(
		`No oss!idle checkout at ${dir} - the add-on bundles the sim from source.\n\n`
		+ '  git submodule update --init --depth 1 vendor/oss-idle\n'
		+ '  npm install --prefix vendor/oss-idle',
	);
};

/** The game version the bundle is pinned to, for the add-on's `gameVersion`. */
export const gameVersion = async (gameRoot) => {
	const pkg = join(gameRoot, 'package.json');
	if (!existsSync(pkg)) return '0.0.0';
	const { readFile } = await import('node:fs/promises');
	return JSON.parse(await readFile(pkg, 'utf8')).version ?? '0.0.0';
};
