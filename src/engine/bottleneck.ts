/**
 * Which skill holds the character back on each map, and how often each one does.
 *
 * Every map is played once at the starting levels. A failed play is played again
 * `retries` times; when fewer than `share` of those pass, the least levels to pass
 * it at that share are searched for, and the skill that has to go up the most is
 * the map's bottleneck. At the end, the maps each skill holds back are counted.
 */

import type { ApiSimulateRequest, ApiSimulation } from '@oss-idle/shared/apiV2';
import { currentLevels, findMinimum, startOf, stateWith, type MinimumJob, type MinimumOptions, type MinimumResult } from './minimum.js';
import { paced } from './sweep.js';

/** A difficulty at a rate. */
export type SweepMap = { beatmapId: number; rate: number };

export type BottleneckJob = Omit<MinimumJob, 'beatmapId' | 'rate' | 'mapPlays' | 'goal' | 'share'> & {
	maps: readonly SweepMap[];
	/** The character's plays of a map, for memory. */
	mapPlays: (beatmapId: number) => number;
	/** Plays again after a failed first play. */
	retries: number;
	/** Share of those (0 to 1) that have to pass; below it, the least levels are searched. */
	share: number;
};

export type BottleneckRow = SweepMap & {
	/** Passed the first play; retried and passed often enough; needs levels; or even level 500 fails. */
	status: 'passed' | 'retried' | 'levels' | 'out of reach' | 'stopped' | 'skipped';
	/** Why the sim API would not play it, when skipped. */
	reason?: string;
	/** Share of the retries that passed, when it was retried. */
	retryShare?: number;
	result?: MinimumResult;
	/** The skill raised the most, and by how much: the map's bottleneck. */
	skill?: string;
	ups?: number;
	calls: number;
};

/** The skill a search raised the most, ties to the one raised to the higher level; none when nothing went up. */
export const bottleneckOf = (result: Pick<MinimumResult, 'current' | 'levels'>): { skill: string; ups: number } | undefined => {
	let best: { skill: string; ups: number } | undefined;
	for (const [skill, level] of Object.entries(result.levels)) {
		const ups = level - (result.current[skill] ?? level);
		if (ups <= 0) continue;
		if (!best || ups > best.ups || (ups === best.ups && level > result.levels[best.skill]!)) best = { skill, ups };
	}
	return best;
};

/** Maps each skill is the bottleneck of, most first: a search stopped part way does not count. */
export const tally = (rows: readonly Pick<BottleneckRow, 'skill' | 'status'>[]): [string, number][] => {
	const counts = new Map<string, number>();
	for (const { skill, status } of rows) if (skill && status === 'levels') counts.set(skill, (counts.get(skill) ?? 0) + 1);
	return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

export type BottleneckSweep = { rows: BottleneckRow[]; calls: number; partial: boolean; error?: string };

export const sweepBottlenecks = async (
	job: BottleneckJob,
	simulate: (body: ApiSimulateRequest) => Promise<ApiSimulation>,
	{ onProgress, cancelled = () => false, pace = paced }: MinimumOptions = {},
	/** Each map's row as it is finished, so a long sweep fills in as it goes. */
	onRow?: (row: BottleneckRow) => void,
): Promise<BottleneckSweep> => {
	const skills = stateWith(job.state, startOf(job), currentLevels(job.state));
	const rows: BottleneckRow[] = [];
	let calls = 0;
	let error: string | undefined;
	/** Maps the sim API refused in a row: past a few, it is the API that is down, not the maps. */
	let refused = 0;
	const done = (row: BottleneckRow) => { rows.push(row); onRow?.(row); };

	for (const [i, map] of job.maps.entries()) {
		if (cancelled() || error) break;
		const of = `${i + 1} of ${job.maps.length}`;
		const before = calls;
		const body: ApiSimulateRequest = {
			beatmap_id: map.beatmapId,
			rate: map.rate,
			mods: job.mods,
			generation: job.state.generation,
			strain_minutes: job.minutes,
			map_plays: job.mapPlays(map.beatmapId),
			skills,
		};
		const play = () => pace(() => {
			calls++;
			onProgress?.({ label: `Map ${of}: playing`, calls });
			return simulate(body);
		});
		try {
			if ((await play()).passed) {
				done({ ...map, status: 'passed', calls: calls - before });
				continue;
			}
			const tries = await Promise.all(Array.from({ length: Math.max(1, job.retries) }, play));
			const retryShare = tries.filter(t => t.passed).length / tries.length;
			if (retryShare >= job.share) {
				done({ ...map, status: 'retried', retryShare, calls: calls - before });
				continue;
			}
			const result = await findMinimum({
				...job,
				beatmapId: map.beatmapId,
				rate: map.rate,
				mapPlays: job.mapPlays(map.beatmapId),
				goal: { kind: 'pass' },
				share: job.share,
			}, simulate, {
				onProgress: ({ label, calls: own }) => onProgress?.({ label: `Map ${of}: ${label}`, calls: before + tries.length + 1 + own }),
				cancelled,
				pace,
			});
			calls += result.calls;
			const top = result.reachable ? bottleneckOf(result) : undefined;
			done({
				...map,
				status: !result.reachable ? 'out of reach' : result.partial && cancelled() ? 'stopped' : 'levels',
				retryShare,
				result,
				skill: top?.skill,
				ups: top?.ups,
				calls: calls - before,
			});
			refused = 0;
		} catch (e) {
			const reason = e instanceof Error ? e.message : String(e);
			if (cancelled()) break;
			if (++refused >= 3) { error = reason; break; }
			done({ ...map, status: 'skipped', reason, calls: calls - before });
		}
	}
	return { rows, calls, partial: cancelled() || !!error, error };
};
