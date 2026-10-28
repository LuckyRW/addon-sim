/**
 * The playlist search, off the game's thread.
 *
 * `buildRotation` forecasts a day of play about a thousand times: seconds of
 * solid CPU on a large library, and the overlay searches again whenever what it
 * knows changes - every forecasting pass, every setting. On the game's thread
 * that froze the game for seconds at a time.
 *
 * The bundler inlines this file into the add-on as a string (`worker:` import),
 * since a Blob-loaded add-on has no URL to load a separate worker file from.
 */

import type { SimResult } from '../engine/protocol.js';
import { playKey, type RankedMap } from './metrics.js';
import { buildRepeating, buildRotation, buildWarmup, coldCurve, stateLookup, type RotationOptions } from './session.js';

/** A search: the session's `lookup` is a function, so it is rebuilt here from the plays it reads. */
export type RotationJob = {
	id: number;
	warmup: boolean;
	/** Play each map several times in a row where that earns more: `buildRepeating`. */
	repeat?: boolean;
	ranked: RankedMap[];
	/** The plays simulated at their peak, which the tired ones are measured against. */
	peaks: SimResult[];
	/** The same plays simulated tired. */
	states: SimResult[];
	options: Omit<RotationOptions, 'lookup'>;
};

/** The playlist found, by `playKey`, and how many times in a row each plays. */
export type RotationAnswer = { id: number; keys: string[]; repeats: number[] } | { id: number; error: string };

const post = (answer: RotationAnswer) => (self as unknown as Worker).postMessage(answer);

self.onmessage = ({ data: job }: MessageEvent<RotationJob>) => {
	try {
		const peaks = new Map(job.peaks.map(play => [playKey(play), play]));
		const { gear } = job.options;
		const options = { ...job.options, lookup: stateLookup(job.states, gear, coldCurve(job.states, peaks, gear)) };
		const { rotation, repeats } = job.warmup
			? { rotation: buildWarmup(job.ranked, options), repeats: undefined }
			: job.repeat
				? buildRepeating(job.ranked, options)
				: { rotation: buildRotation(job.ranked, options), repeats: undefined };
		post({ id: job.id, keys: rotation.map(playKey), repeats: repeats ?? rotation.map(() => 1) });
	} catch (e) {
		post({ id: job.id, error: e instanceof Error ? e.message : String(e) });
	}
};
