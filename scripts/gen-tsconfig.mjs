/**
 * Generate the tsconfig that typechecking uses.
 *
 * `@osu-idle/shared` lives wherever the developer's checkout is - the submodule
 * or `$OSU_IDLE_PATH` - so the path mapping cannot be committed. This writes a
 * generated (gitignored) config that extends the real one and fills in the
 * resolved location.
 */
import { writeFileSync } from 'node:fs';
import { resolveGameRoot } from './resolve-game.mjs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] ?? '.';
const pkgDir = resolve(root, target);
const game = resolveGameRoot();

const relToShared = relative(pkgDir, game.shared).split('\\').join('/');
// tsc rejects a bare relative path in `paths` when `baseUrl` is unset, and
// `relative` only prefixes `../` - the submodule sits *inside* the package.
const sharedFromPkg = relToShared.startsWith('.') ? relToShared : `./${relToShared}`;

const config = {
	extends: './tsconfig.json',
	compilerOptions: {
		paths: { '@osu-idle/shared/*': [`${sharedFromPkg}/*`] },
	},
};

const out = resolve(pkgDir, 'tsconfig.generated.json');
writeFileSync(out, JSON.stringify(config, null, '\t') + '\n');
console.log(`wrote ${relative(root, out)} -> ${sharedFromPkg} (${game.label})`);
