/**
 * Messages between the overlay and the simulation worker.
 *
 * Everything crossing this boundary is structured-cloneable: the worker
 * receives a plain snapshot of the character (the `character` row as stored)
 * and rebuilds the game's `Skill` objects on its own side, because those carry
 * behaviour and cannot be cloned.
 */

import type { Mod } from '@oss-idle/shared/mods';

/**
 * One difficulty to simulate, and how: every rate × mods × tiredness listed.
 *
 * Deliberately just ids: charts are read a set at a time as a worker takes it.
 * Reading them all up front would mean holding an entire library of `.osu` text
 * in memory (a thousand maps is easily hundreds of megabytes).
 */
export type SimRequest = {
	setId: number;
	beatmapId: number;
	rates: number[];
	/** Mod sets to play it with; `[]` is no mod. */
	mods: Mod[][];
	/**
	 * How tired to play it: the character's fatigue in strained minutes, which
	 * sets both its warm-up and its fatigue (the game's `fatigue.ts`).
	 */
	minutes: number[];
};

/**
 * What a simulated play is worth, before mindblock, fatigue, medals and mods.
 *
 * The simulation is **stochastic** - the bot's hit error is sampled, so the same
 * chart played twice earns different XP (measured at 4-17% variation run to
 * run, worst on maps the character is only just clearing). Every field here is
 * therefore a mean over `runs` attempts.
 */
export type SimResult = {
	setId: number;
	beatmapId: number;
	rate: number;
	mods: Mod[];
	/** The fatigue minutes it was played at. */
	minutes: number;
	/** Star rating at that rate and mods (0 if rosu-pp is unavailable). */
	stars: number;
	/** Mean per-skill XP per play, read off the score at the map's own windows. */
	xp: Record<string, number>;
	totalXp: number;
	/** Mean wall-clock cost in seconds: lead-in plus time to the play's end. */
	durationSec: number;
	/** The play's length at its rate in minutes, which fatigue counts whether or not it fails. */
	lengthMin: number;
	/** Mean minutes of it the physical skills were strained, which tire and warm the character. */
	strained: number;
	accuracy: number;
	/** Grade of the median run. */
	grade: string;
	pp: number;
	runs: number;
	/** Share of runs that died (0 = always clears, 1 = never). */
	failRate: number;
	/** Relative spread of total XP across runs - how trustworthy the mean is. */
	variation: number;
};

export type SimError = {
	setId: number;
	beatmapId: number;
	message: string;
};

/**
 * One beatmapset's difficulties, handed to a free worker.
 *
 * A whole set per job because a set's charts are one read. The charts come
 * with the job, read on the main thread: in the desktop app they live in the
 * maps folder, which only the page can reach.
 */
export type WorkerRequest = {
	type: 'job';
	setId: number;
	/** The set's `.osu` texts by difficulty id. */
	charts: Record<number, string>;
	/** The `character` row, used to rebuild the player's skills worker-side. */
	character: Record<string, unknown>;
	divine: boolean;
	runs: number;
	maps: (Omit<SimRequest, 'setId'> & {
		/**
		 * Plays to seed the memory skill with, which is the only thing that makes
		 * it earn: it trains on *partially* learned maps.
		 */
		timesPlayed: number;
	})[];
};

/**
 * A worker reports each variant as it finishes and each map once it is through
 * with it, so the overlay fills in as it goes - and so a worker that dies or
 * stalls can be pinned to the map it was on.
 */
export type WorkerResponse =
	| { type: 'result'; result: SimResult }
	| { type: 'map'; beatmapId: number; error?: string }
	/** The job is over; any of its maps not reported were not simulated. */
	| { type: 'idle' };
