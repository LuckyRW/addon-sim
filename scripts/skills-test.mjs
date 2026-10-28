/** Skills play at what all their XP ever bought plus prestige (`playLevelOf`), as the profile shows them. */
import { build } from 'esbuild';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolveGameRoot } from './resolve-game.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This repository's root, so nothing depends on where it is checked out. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const game = resolveGameRoot();
const { sharedSourcePlugin, tsExtensionPlugin } = await import('@oss-idle/addon-sdk/build');

/** The game hands add-ons React; the skills only import its hook helpers, never called here. */
const reactStub = {
	name: 'react-stub',
	setup(b) {
		b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'react-stub' }));
		b.onLoad({ filter: /.*/, namespace: 'react-stub' }, () => ({
			contents: 'export const useSyncExternalStore = () => {}; export const useState = () => []; export const useEffect = () => {}; export const useCallback = f => f; export const useRef = v => ({ current: v }); export const useMemo = f => f(); export default {};',
		}));
	},
};

const dir = join(REPO_ROOT, '.skillstest');
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'e.ts'), `
export { skillsFrom } from '../src/engine/skills.js';
export { playLevelOf, xpToLevel, xpForLevel } from '@oss-idle/shared/xp';
`);
await build({
	entryPoints: [join(dir, 'e.ts')], outfile: join(dir, 'b.mjs'), bundle: true,
	format: 'esm', platform: 'node', target: 'es2022', logLevel: 'error',
	plugins: [reactStub, sharedSourcePlugin(join(game.root, 'packages/shared/src')), tsExtensionPlugin()],
	absWorkingDir: REPO_ROOT,
});
const m = await import(pathToFileURL(join(dir, 'b.mjs')).href);

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? pass++ : (fail++, console.log('  FAIL:', n, x)); };

/** Lifetime XP that buys `level` and `share` of the next one. */
const lifetime = (level, share = 0) => m.xpToLevel(level) + share * m.xpForLevel(level);
// at the peak of warm-up and untired, so tiring leaves the level alone
const speedOf = row => m.skillsFrom(row, 0, 75).find(skill => skill.name === 'speed');
const playsAt = (name, row) => {
	const want = m.playLevelOf(row.speed ?? 0, row.speedXP ?? 0, row.speedLifetimeXp ?? 0, row.speedPrestige ?? 0);
	const got = speedOf(row).effectiveLevel();
	check(name, Math.abs(got - want) < 1e-9, `plays at ${got}, playLevelOf ${want}`);
	return got;
};

const upgraded = playsAt('an upgraded skill plays at its lifetime level',
	{ speed: 20, speedXP: 0.5 * m.xpForLevel(20), speedLifetimeXp: lifetime(50, 0.25) });
check('which is the level its XP bought, not the one it holds', Math.abs(upgraded - 50.25) < 1e-6, upgraded);
const prestiged = playsAt('a prestiged skill plays at its lifetime level plus prestige',
	{ speed: 10, speedLifetimeXp: lifetime(102, 0.5), speedPrestige: 2 });
check('prestige still adds on top', Math.abs(prestiged - 104.5) < 1e-6, prestiged);
playsAt('a skill held above its lifetime level keeps the held one', { speed: 60, speedLifetimeXp: lifetime(30) });
playsAt('a character with no lifetime column plays at its held level', { speed: 42 });

rmSync(dir, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
