/**
 * Performance points for a simulated play.
 *
 * pp comes from rosu-pp, which is WebAssembly. A Blob-loaded add-on cannot fetch
 * a sibling asset, so the binary is imported as base64 and inlined into the
 * bundle (the build's `.wasm` loader), then decoded once and handed to the
 * module's init as a `BufferSource` - the same `InitInput` the client's
 * `osu/rosu.ts` satisfies with a URL.
 *
 * The arguments are the game's own `performanceArgs`, the same for its server
 * and client builds.
 *
 * rosu-pp objects are wasm-backed and are **not** garbage collected with the JS
 * wrapper, so everything created here is freed explicitly. A sweep builds one
 * per map across a thousand maps; leaking them exhausts the wasm heap.
 */

import init, * as ppjs from 'rosu-pp-js-web';
import { modsKey, modsLabel, type Mod } from '@oss-idle/shared/mods';
import { performanceArgs } from '@oss-idle/shared/rulesets/mania/performanceArgs';
import wasmBase64 from 'rosu-pp-js-web/rosu_pp_js_bg.wasm?base64';

type PPScore = Parameters<typeof performanceArgs>[0];

let ready: Promise<boolean> | undefined;

/**
 * Load the wasm module once.
 *
 * Resolves `false` rather than throwing if it cannot: pp is one column, and
 * losing it must not take down a sweep that is otherwise fine.
 */
export const ppReady = (): Promise<boolean> => ready ??= (async () => {
	try {
		const bytes = Uint8Array.from(atob(wasmBase64), c => c.charCodeAt(0));
		// The object form; passing the buffer positionally still works but logs a
		// deprecation warning into the player's console on every sweep.
		await init({ module_or_path: bytes });
		return true;
	} catch (e) {
		console.error('[farm] rosu-pp failed to load; pp will read 0', e);
		return false;
	}
})();

/**
 * A chart parsed by rosu-pp, reusable across the runs of one map.
 *
 * Parsing and the difficulty calculation are the expensive half, and neither
 * depends on the play - so the chart is parsed once per map, its difficulty
 * once per rate, and only the (cheap) performance calculation repeated per run.
 */
export type PPChart = {
	calculate(score: PPScore, rate: number, mods: readonly Mod[]): number;
	stars(rate: number, mods: readonly Mod[]): number;
	free(): void;
};

const NOOP_CHART: PPChart = { calculate: () => 0, stars: () => 0, free: () => {} };

/** Parse a chart for pp. Returns a no-op chart if rosu is unavailable or refuses it. */
export const ppChart = (chartText: string, available: boolean): PPChart => {
	if (!available) return NOOP_CHART;

	let map: ppjs.Beatmap;
	try {
		map = new ppjs.Beatmap(chartText);
	} catch {
		// rosu rejects charts it considers unsuitable for calculation.
		return NOOP_CHART;
	}

	const byPlay = new Map<string, ppjs.DifficultyAttributes>();
	const difficulty = (rate: number, mods: readonly Mod[]): ppjs.DifficultyAttributes => {
		const key = `${rate}|${modsKey(mods)}`;
		let attributes = byPlay.get(key);
		if (!attributes) {
			const calculator = new ppjs.Difficulty({ lazer: false, clockRate: rate, mods: modsLabel(mods) });
			try {
				attributes = calculator.calculate(map);
			} finally {
				calculator.free();
			}
			byPlay.set(key, attributes);
		}
		return attributes;
	};

	return {
		calculate(score, rate, mods) {
			let performance: ppjs.Performance | undefined;
			let attributes: ppjs.PerformanceAttributes | undefined;
			try {
				performance = new ppjs.Performance(performanceArgs(score, rate, mods));
				attributes = performance.calculate(difficulty(rate, mods));
				return attributes.pp;
			} catch {
				return 0;
			} finally {
				attributes?.free();
				performance?.free();
			}
		},
		stars(rate, mods) {
			try {
				return difficulty(rate, mods).stars;
			} catch {
				return 0;
			}
		},
		free() {
			for (const attributes of byPlay.values()) attributes.free();
			map.free();
		},
	};
};
