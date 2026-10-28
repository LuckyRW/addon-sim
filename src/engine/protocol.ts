/**
 * What a sweep asks for and what it reports.
 */

import type { Mod } from '@oss-idle/shared/mods';

/** One difficulty to simulate, and how: every rate × mods × tiredness listed. */
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
 * therefore a mean over `runs` plays.
 */
export type SimResult = {
	setId: number;
	beatmapId: number;
	rate: number;
	mods: Mod[];
	/** The fatigue minutes it was played at. */
	minutes: number;
	/** Mean per-skill XP per play; a failed play earns none. */
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
