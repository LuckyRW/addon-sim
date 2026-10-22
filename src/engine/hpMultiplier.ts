/**
 * The game's `sim/scoring`, with `computeHpMultiplier` remembered.
 *
 * `ManiaGame` computes the map's HP multiplier in its constructor, and the
 * search behind it runs a few hundred drain passes over every note - about a
 * seventh of a sweep. Its answer depends on the chart and rate alone, and the
 * worker builds one game per run, so every run of a map after the first asks
 * the same question again.
 *
 * The build points `maniaGame.ts`'s `./scoring.js` import here (see
 * `scripts/bundle-plugins.mjs`). The last call's inputs are kept and compared in
 * full, so a hit returns exactly what the game would have computed.
 */

import { computeHpMultiplier as compute } from '@oss-idle/shared/sim/scoring';

export * from '@oss-idle/shared/sim/scoring';

type HpObject = Parameters<typeof compute>[0][number];

let lastDrain = NaN;
let lastObjects: readonly HpObject[] = [];
let lastResult = 1;

const sameObjects = (a: readonly HpObject[], b: readonly HpObject[]): boolean =>
	a.length === b.length && a.every((o, i) => {
		const p = b[i]!;
		return o.start === p.start && o.end === p.end && o.own === p.own
			&& o.nested.length === p.nested.length
			&& o.nested.every((inc, j) => inc === p.nested[j]);
	});

export const computeHpMultiplier: typeof compute = (objects, drain) => {
	if (drain !== lastDrain || !sameObjects(objects, lastObjects)) {
		lastResult = compute(objects, drain);
		lastDrain = drain;
		lastObjects = objects;
	}
	return lastResult;
};
