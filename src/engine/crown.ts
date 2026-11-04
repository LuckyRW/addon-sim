/**
 * Which maps the character would take #1 on: every live 4K difficulty played a
 * few times at x1 with no mods, each play held against the map's leaderboard top.
 *
 * Plays rank as the game ranks them (`scoreOrder.ts`): score, then accuracy, and
 * a tie stays with whoever set it first, so a tied play never takes #1. The board
 * keeps each player's best at any rate, so its top may be a faster play.
 */

import type { ApiSimulateRequest, ApiSimulation } from '@oss-idle/shared/apiV2';
import { afterPlay, restedFatigue, warmupCurve, type Fatigue } from '@oss-idle/shared/fatigue';
import { LEAD_IN_MS } from '@oss-idle/shared/play';
import { rankValue } from '@oss-idle/shared/scoreOrder';
import type { CharacterState } from './samples.js';
import { paced } from './sweep.js';

/** A leaderboard's top play, as the board lists it. */
export type BoardTop = {
	characterId: number;
	score: number;
	/** 0 to 1. */
	accuracy: number;
	rate: number;
};

/** A map's leaderboard top, or undefined when nobody has set a score on it. */
export type ReadBoard = (beatmapId: number) => Promise<BoardTop | undefined>;

export type CrownJob = {
	state: CharacterState;
	/** The character's own id: a board it already tops is its own. */
	characterId: number;
	beatmapIds: readonly number[];
	/** Plays each map is simulated over. */
	runs: number;
	/** Strained minutes the plays are made at: the warm-up peak. */
	minutes: number;
	/** The character's plays of a map, for memory. */
	mapPlays: (beatmapId: number) => number;
};

export type CrownRow = {
	beatmapId: number;
	/** Undefined for an empty board: any pass takes #1. */
	top?: BoardTop;
	/** The board's top is already this character's. */
	yours: boolean;
	/** Plays that would take #1. */
	wins: number;
	passes: number;
	runs: number;
	/** The best of the plays, by the board's order. */
	bestScore: number;
	bestAccuracy: number;
	/** Mean accuracy of the plays that passed, 0 to 1. */
	accuracy: number;
	/** Mean minutes a play strained the physical skills: what tires and warms the character. */
	strained: number;
};

export type CrownProgress = { done: number; total: number; calls: number; rows: CrownRow[] };

export type Crown = {
	rows: CrownRow[];
	calls: number;
	/** Stopped before it was through. */
	partial: boolean;
	/** Why it stopped, when the sim API or the server failed it: what it finished stands. */
	error?: string;
};

/** Maps simulated at once: each waits on the server most of the time. */
const MAPS_AT_ONCE = 6;

/** Whether a play takes #1 from `top`: a tie stays with the earlier play. */
export const beats = (play: { score: number; accuracy: number }, top: BoardTop | undefined): boolean =>
	!top || rankValue(play.score, play.accuracy) > rankValue(top.score, top.accuracy);

/** A map's row from its plays. Failed plays never reach the board. */
export const rowOf = (
	beatmapId: number,
	top: BoardTop | undefined,
	characterId: number,
	plays: readonly Pick<ApiSimulation, 'score' | 'accuracy' | 'passed' | 'strained_minutes'>[],
): CrownRow => {
	const passed = plays.filter(play => play.passed);
	const best = passed.reduce<typeof passed[number] | undefined>(
		(a, b) => (!a || rankValue(b.score, b.accuracy) > rankValue(a.score, a.accuracy) ? b : a),
		undefined,
	);
	return {
		beatmapId,
		top,
		yours: top?.characterId === characterId,
		wins: passed.filter(play => beats(play, top)).length,
		passes: passed.length,
		runs: plays.length,
		bestScore: best?.score ?? 0,
		bestAccuracy: best?.accuracy ?? 0,
		accuracy: passed.length ? passed.reduce((sum, play) => sum + play.accuracy, 0) / passed.length : 0,
		strained: plays.length ? plays.reduce((sum, play) => sum + play.strained_minutes, 0) / plays.length : 0,
	};
};

export const findCrowns = async (
	job: CrownJob,
	simulate: (body: ApiSimulateRequest) => Promise<ApiSimulation>,
	readBoard: ReadBoard,
	{ onProgress, cancelled = () => false, pace = paced }: {
		onProgress?: (progress: CrownProgress) => void;
		cancelled?: () => boolean;
		pace?: typeof paced;
	} = {},
): Promise<Crown> => {
	const rows: CrownRow[] = [];
	let calls = 0;
	let done = 0;
	let error: string | undefined;
	const stopped = () => cancelled() || error !== undefined;

	const crownOf = async (beatmapId: number) => {
		const top = await readBoard(beatmapId);
		// a #1 already this character's has nothing to take: no plays spent on it
		if (top?.characterId === job.characterId) {
			const row = rowOf(beatmapId, top, job.characterId, []);
			rows.push(row);
			done++;
			onProgress?.({ done, total: job.beatmapIds.length, calls, rows: [row] });
			return;
		}
		const plays: ApiSimulation[] = [];
		for (let i = 0; i < job.runs && !stopped(); i++) {
			plays.push(await pace(() => {
				calls++;
				return simulate({
					beatmap_id: beatmapId,
					rate: 1,
					mods: [],
					generation: job.state.generation,
					strain_minutes: job.minutes,
					map_plays: job.mapPlays(beatmapId),
					skills: job.state.skills,
				});
			}));
		}
		if (plays.length < job.runs) return;
		const row = rowOf(beatmapId, top, job.characterId, plays);
		rows.push(row);
		done++;
		onProgress?.({ done, total: job.beatmapIds.length, calls, rows: [row] });
	};

	const queue = [...job.beatmapIds];
	await Promise.all(Array.from({ length: Math.min(MAPS_AT_ONCE, queue.length) }, async () => {
		for (let id = queue.shift(); id !== undefined && !stopped(); id = queue.shift()) {
			try {
				await crownOf(id);
			} catch (e) {
				const status = (e as { status?: number })?.status;
				// a map gone from the server is skipped; anything else stops the run
				if (status === 404 || status === 422) {
					done++;
					onProgress?.({ done, total: job.beatmapIds.length, calls, rows: [] });
					continue;
				}
				error ??= e instanceof Error ? e.message : String(e);
			}
		}
	}));

	return { rows, calls, partial: stopped(), error };
};

export type PeakPlaylist = {
	/** The maps taken, in order. */
	beatmapIds: number[];
	/** Strained minutes after each map and the wait after it. */
	minutes: number[];
	/** Why it stopped: the next map would leave the peak, or no maps were left. */
	stopped: 'peak' | 'maps';
	/** Where the peak is, in strained minutes. */
	peak: { from: number; to: number };
};

/**
 * Winnable maps, from the top, for as long as they keep the character at its warm-up
 * peak: each map is stepped through the game's own fatigue (`fatigue.ts`) from
 * `startMinutes`, with autopilot's wait after it, and the first that would push it
 * past the peak's end ends the playlist. Started below the peak, maps that warm the
 * character up are taken until it is there; once there, one that would cool it off
 * the peak ends it too. A map always plays whole, so a failed play counts as passed.
 */
export const peakPlaylist = (
	rows: readonly Pick<CrownRow, 'beatmapId' | 'strained'>[],
	{ startMinutes, gear, delaySec, lengthSec }: {
		startMinutes: number;
		/** Stamina upgrades: they move and hold the peak. */
		gear: number;
		delaySec: number;
		/** A map's length at x1, in seconds. */
		lengthSec: (beatmapId: number) => number | undefined;
	},
): PeakPlaylist => {
	const { warm, peakEnd } = warmupCurve(gear);
	const beatmapIds: number[] = [];
	const minutes: number[] = [];
	let now = startMinutes;
	for (const row of rows) {
		const length = lengthSec(row.beatmapId);
		if (!length) continue;
		const played: Fatigue = afterPlay({ at: 0, minutes: now }, length / 60, row.strained, LEAD_IN_MS + length * 1000);
		const next = restedFatigue(played, played.at + delaySec * 1000);
		const inPeak = next >= warm && next <= peakEnd;
		// below the peak it may still be warming up; anything else leaves it
		const warming = now < warm && next > now && next <= peakEnd;
		if (!inPeak && !warming) return { beatmapIds, minutes, stopped: 'peak', peak: { from: warm, to: peakEnd } };
		beatmapIds.push(row.beatmapId);
		minutes.push(next);
		now = next;
	}
	return { beatmapIds, minutes, stopped: 'maps', peak: { from: warm, to: peakEnd } };
};
