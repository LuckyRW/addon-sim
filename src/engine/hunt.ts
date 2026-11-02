/**
 * The easiest map for a goal, out of every map at some star rating or more:
 * the 9★ full combo medal, say, which counts the stars a play was made at.
 *
 * A full search for the least levels is thousands of sim calls, too many to
 * run on every map. So each candidate is first played a few times at the
 * starting levels and ranked by how close it comes (`closeness`), and only the
 * closest few are searched in full, then ranked by the XP their levels cost.
 */

import type { ApiSimulateRequest, ApiSimulation } from '@oss-idle/shared/apiV2';
import { xpToLevel } from '@oss-idle/shared/xp';
import { closeness, currentLevels, findMinimum, startOf, stateWith, type MinimumJob, type MinimumOptions, type MinimumResult } from './minimum.js';
import type { CharacterState } from './samples.js';
import { paced } from './sweep.js';

/** A difficulty at a rate, with the stars it is played at there. */
export type Candidate = { beatmapId: number; rate: number; stars: number };

/**
 * Each difficulty once, at the slowest of `rates` its stars reach `minStars` at:
 * a faster rate is only harder. `x1` is the difficulty's own stars, the others
 * the server's stars at that rate.
 */
export const candidatesOf = (
	difficulties: readonly { beatmapId: number; stars: number }[],
	rates: readonly number[],
	starsAt: ReadonlyMap<number, ReadonlyMap<number, number>>,
	minStars: number,
): Candidate[] => {
	const slowest = [...rates].sort((a, b) => a - b);
	const out: Candidate[] = [];
	for (const { beatmapId, stars } of difficulties) {
		for (const rate of slowest) {
			const at = rate === 1 ? stars : starsAt.get(rate)?.get(beatmapId);
			if (at !== undefined && at >= minStars) {
				out.push({ beatmapId, rate, stars: at });
				break;
			}
		}
	}
	return out.sort((a, b) => a.stars - b.stars);
};

/** The XP raising the skills from `result.current` to `result.levels` costs, from where each skill really is. */
export const xpNeeded = (state: CharacterState, result: Pick<MinimumResult, 'current' | 'levels'>): number => {
	const real = currentLevels(state);
	let total = 0;
	for (const [skill, level] of Object.entries(result.levels)) {
		const from = result.current[skill]!;
		if (level <= from) continue;
		const s = state.skills[skill as keyof CharacterState['skills']];
		// a play level is the skill's level and its prestige; a level set by hand starts with no xp into it
		const had = from === real[skill] ? xpToLevel(s.level) + s.xp : xpToLevel(Math.max(0, from - s.prestige));
		total += Math.max(0, xpToLevel(Math.max(0, level - s.prestige)) - had);
	}
	return total;
};

export type HuntJob = Omit<MinimumJob, 'beatmapId' | 'rate' | 'mapPlays'> & {
	candidates: readonly Candidate[];
	/** The character's plays of a map, for memory. */
	mapPlays: (beatmapId: number) => number;
	/** Plays each candidate is screened over. */
	screenRuns: number;
	/** How many of the closest are searched in full. */
	finalists: number;
};

export type HuntRow = Candidate & {
	/** How close its screening plays came: higher is closer. */
	closeness: number;
	result?: MinimumResult;
	/** XP the least levels cost, from the starting levels. */
	xp?: number;
};

export type Hunt = {
	/** The finalists, easiest first; those out of reach last. */
	rows: HuntRow[];
	screened: number;
	calls: number;
	/** Stopped before it was through. */
	partial: boolean;
	/** Why it stopped, when the sim API failed it: what it finished stands. */
	error?: string;
};

export const huntEasiest = async (
	job: HuntJob,
	simulate: (body: ApiSimulateRequest) => Promise<ApiSimulation>,
	{ onProgress, cancelled = () => false, pace = paced }: MinimumOptions = {},
): Promise<Hunt> => {
	let calls = 0;
	let error: string | undefined;
	const failed = (e: unknown) => {
		error = e instanceof Error ? e.message : String(e);
	};
	const skills = stateWith(job.state, startOf(job), currentLevels(job.state));
	const screened: HuntRow[] = [];
	for (const [i, candidate] of job.candidates.entries()) {
		if (cancelled() || error) break;
		const plays = await Promise.all(Array.from({ length: job.screenRuns }, () => pace(() => {
			calls++;
			onProgress?.({ label: `Screening ${i + 1} of ${job.candidates.length}`, calls });
			return simulate({
				beatmap_id: candidate.beatmapId,
				rate: candidate.rate,
				mods: job.mods,
				generation: job.state.generation,
				strain_minutes: job.minutes,
				map_plays: job.mapPlays(candidate.beatmapId),
				// at the starting levels, as findMinimum's own first check plays them
				skills,
			});
		}))).catch(failed);
		if (plays) screened.push({ ...candidate, closeness: closeness(plays, job.goal) });
	}

	const finalists = [...screened].sort((a, b) => b.closeness - a.closeness).slice(0, job.finalists);
	for (const [i, row] of finalists.entries()) {
		if (cancelled() || error) break;
		const before = calls;
		const result = await findMinimum({
			...job,
			beatmapId: row.beatmapId,
			rate: row.rate,
			mapPlays: job.mapPlays(row.beatmapId),
		}, simulate, {
			onProgress: ({ calls: own }) => onProgress?.({ label: `Searching ${i + 1} of ${finalists.length}`, calls: before + own }),
			cancelled,
			pace,
		}).catch(failed);
		if (!result) break;
		row.result = result;
		calls = before + result.calls;
		if (result.reachable) row.xp = xpNeeded(job.state, result);
	}

	const rank = (row: HuntRow) => (row.result?.reachable ? row.xp ?? 0 : Infinity);
	return {
		rows: finalists.filter(row => row.result).sort((a, b) => rank(a) - rank(b)),
		screened: screened.length,
		calls,
		partial: cancelled() || !!error,
		error,
	};
};
