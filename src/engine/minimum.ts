/**
 * The least levels a goal on a map takes: pass it, or reach an accuracy.
 *
 * The sim API plays any character it is described, so a character with other
 * levels is only another request. From the player's levels, it raises whichever
 * skill helps most until the goal is met, then lowers each skill again to the
 * least that still meets it. A goal already met is lowered from where it stands,
 * to show how much to spare there is.
 *
 * Plays are random, so a level is judged over several of them, and a goal is met
 * only when {@link PASS_SHARE} of them pass.
 */

import type { ApiSimulateRequest, ApiSimulation } from '@oss-idle/shared/apiV2';
import type { Mod } from '@oss-idle/shared/mods';
import { playLevelOf } from '@oss-idle/shared/xp';
import type { CharacterState } from './samples.js';
import { paced } from './sweep.js';

/** Pass the map, pass it at this accuracy (0 to 1), or pass it without a miss. */
export type Goal = { kind: 'pass' } | { kind: 'accuracy'; accuracy: number } | { kind: 'fc' };

/** The share of a level's plays that have to pass (or full combo, for that goal) for it to count: one lucky play is not a level. */
export const PASS_SHARE = 0.9;
/** The highest level tried: past it, a goal counts as out of reach. */
export const MAX_LEVEL = 500;
/** Levels a skill goes up by while looking for the goal; lowering it again finds the exact level. */
const STEP = 10;
/** Sim calls one search makes at most, or enough for this many checks if that is more: what it has found stands when they run out. */
const MAX_CALLS = 3000;
const MAX_CHECKS = 150;

export type MinimumJob = {
	state: CharacterState;
	beatmapId: number;
	rate: number;
	mods: Mod[];
	/** Strained minutes it is played at: the warm-up peak, unless asked otherwise. */
	minutes: number;
	/** The character's plays of the map, for memory. */
	mapPlays: number;
	goal: Goal;
	/** Plays each set of levels is judged over. */
	runs: number;
	/** Share of those plays (0 to 1) that have to succeed; {@link PASS_SHARE} unless set. */
	share?: number;
	/** Levels to start from instead of the character's, by skill: a skill's prestige is the least it can be. */
	startLevels?: Readonly<Record<string, number>>;
};

/** What a set of levels did. */
export type Trial = {
	/** Share of the plays that passed. */
	passShare: number;
	/** Their mean accuracy, 0 to 1. */
	accuracy: number;
	/** Share of the plays that passed without a miss. */
	fcShare: number;
	met: boolean;
};

export type MinimumResult = {
	/** False when even every skill at {@link MAX_LEVEL} does not meet the goal. */
	reachable: boolean;
	/** The goal was already met at the character's levels. */
	alreadyMet: boolean;
	/** The search was stopped or ran out of calls: `levels` is as far as it got, and may not be the least. */
	partial: boolean;
	/** The level each skill started from: the character's, or as set. */
	current: Record<string, number>;
	/** The least found to meet the goal. */
	levels: Record<string, number>;
	trial?: Trial;
	calls: number;
};

export type MinimumOptions = {
	onProgress?: (progress: { label: string; calls: number }) => void;
	cancelled?: () => boolean;
	/** How a call is spaced: under the rate limit, unless a test says otherwise. */
	pace?: <T>(call: () => Promise<T>) => Promise<T>;
};

/** `state` with `levels`: a skill at another level has only that level, with its prestige and upgrades kept, so any reading of it plays alike. */
const stateWith = (state: CharacterState, levels: Record<string, number>, current: Record<string, number>): ApiSimulateRequest['skills'] =>
	Object.fromEntries(Object.entries(state.skills).map(([skill, s]) => [skill, levels[skill] === current[skill]
		? s
		: { ...s, level: Math.max(0, levels[skill]! - s.prestige), xp: 0, lifetime_xp: 0 }]));

/** A skill's level as the character plays it, whole. */
export const currentLevels = (state: CharacterState): Record<string, number> =>
	Object.fromEntries(Object.entries(state.skills).map(([skill, s]) =>
		[skill, Math.floor(playLevelOf(s.level, s.xp, s.lifetime_xp, s.prestige))]));

/** The levels a job starts from: the character's, or as set, a skill's prestige the least it can be. */
const startOf = (job: Pick<MinimumJob, 'state' | 'startLevels'>): Record<string, number> =>
	Object.fromEntries(Object.entries(currentLevels(job.state)).map(([skill, level]) => {
		const set = job.startLevels?.[skill];
		return [skill, set === undefined ? level : Math.max(job.state.skills[skill as keyof CharacterState['skills']].prestige, Math.round(set))];
	}));

/** How often the starting levels meet each goal, over plays of the map. */
export type Chance = {
	/** Plays actually made: fewer than asked when stopped. */
	plays: number;
	/** Share of them that passed, full combo'd, and met the goal asked. */
	passShare: number;
	fcShare: number;
	goalShare: number;
	accuracy: number;
	/** Mean seconds an attempt takes, a failed one ending where it failed; the gap after it not included. */
	seconds: number;
};

/** The chance one attempt meets the goal at the starting levels: `job.runs` plays, each its own attempt. */
export const findChance = async (
	job: MinimumJob,
	lengthSec: number,
	simulate: (body: ApiSimulateRequest) => Promise<ApiSimulation>,
	{ onProgress, cancelled = () => false, pace = paced }: MinimumOptions = {},
): Promise<Chance> => {
	const real = currentLevels(job.state);
	const levels = startOf(job);
	let calls = 0;
	const plays = (await Promise.all(Array.from({ length: job.runs }, () => pace(async () => {
		if (cancelled()) return undefined;
		calls++;
		onProgress?.({ label: `Playing it ${job.runs} times`, calls });
		return simulate({
			beatmap_id: job.beatmapId,
			rate: job.rate,
			mods: job.mods,
			generation: job.state.generation,
			strain_minutes: job.minutes,
			map_plays: job.mapPlays,
			skills: stateWith(job.state, levels, real),
		});
	})))).filter((play): play is ApiSimulation => !!play);
	const mean = (of: (play: ApiSimulation) => number) => (plays.length ? plays.reduce((sum, play) => sum + of(play), 0) / plays.length : 0);
	const fc = (play: ApiSimulation) => play.passed && (play.statistics?.miss ?? 0) === 0;
	const { goal } = job;
	return {
		plays: plays.length,
		passShare: mean(play => (play.passed ? 1 : 0)),
		fcShare: mean(play => (fc(play) ? 1 : 0)),
		goalShare: mean(play => ((goal.kind === 'fc' ? fc(play) : play.passed && (goal.kind === 'pass' || play.accuracy >= goal.accuracy)) ? 1 : 0)),
		accuracy: mean(play => play.accuracy),
		seconds: mean(play => (play.passed ? lengthSec / job.rate : play.fail_seconds ?? lengthSec / job.rate)),
	};
};

export const findMinimum = async (
	job: MinimumJob,
	simulate: (body: ApiSimulateRequest) => Promise<ApiSimulation>,
	{ onProgress, cancelled = () => false, pace = paced }: MinimumOptions = {},
): Promise<MinimumResult> => {
	const real = currentLevels(job.state);
	const current = startOf(job);
	const skills = Object.keys(current);
	let calls = 0;
	let label = '';
	const needed = job.share ?? PASS_SHARE;
	const spent = () => cancelled() || calls >= Math.max(MAX_CALLS, job.runs * MAX_CHECKS);

	/** What each set of levels did, and how well, to compare sets that all fail. */
	const seen = new Map<string, Trial & { measure: number }>();
	const check = async (levels: Record<string, number>) => {
		const key = skills.map(skill => levels[skill]).join();
		const known = seen.get(key);
		if (known) return known;
		const plays = await Promise.all(Array.from({ length: job.runs }, () => pace(() => {
			calls++;
			onProgress?.({ label, calls });
			return simulate({
				beatmap_id: job.beatmapId,
				rate: job.rate,
				mods: job.mods,
				generation: job.state.generation,
				strain_minutes: job.minutes,
				map_plays: job.mapPlays,
				skills: stateWith(job.state, levels, real),
			});
		})));
		const mean = (of: (play: ApiSimulation) => number) => plays.reduce((sum, play) => sum + of(play), 0) / plays.length;
		const passShare = mean(play => (play.passed ? 1 : 0));
		const accuracy = mean(play => play.accuracy);
		// not the API's `perfect`, which a GOOD or BAD also loses
		const misses = (play: ApiSimulation) => play.statistics?.miss ?? 0;
		const fcShare = mean(play => (play.passed && misses(play) === 0 ? 1 : 0));
			const { goal } = job;
		const trial = {
			passShare,
			accuracy,
			fcShare,
			met: goal.kind === 'fc'
				? fcShare >= needed
				: goal.kind === 'accuracy'
					? mean(play => (play.passed && play.accuracy >= goal.accuracy ? 1 : 0)) >= needed
					: passShare >= needed,
			// how far through the map plays get counts too: while all of them fail, it alone tells levels apart
			measure: mean(play => (play.passed ? 1 : play.fail_progress ?? 0)) + accuracy
				// fewer misses tell levels apart while none of them full combos
				+ (job.goal.kind === 'fc' ? 1 / (1 + mean(misses)) : 0),
		};
		seen.set(key, trial);
		return trial;
	};

	label = 'Trying your levels';
	const start = await check(current);
	const alreadyMet = start.met;
	let levels = { ...current };
	/** How low lowering a skill may go: your own level, or its prestige once you already meet the goal. */
	const floor: Record<string, number> = alreadyMet
		? Object.fromEntries(skills.map(skill => [skill, job.state.skills[skill as keyof CharacterState['skills']].prestige]))
		: { ...current };

	if (!alreadyMet) {
		label = 'Checking it can be done';
		const top = Object.fromEntries(skills.map(skill => [skill, Math.max(current[skill]!, MAX_LEVEL)]));
		if (!(await check(top)).met) {
			return { reachable: false, alreadyMet, partial: false, current, levels: top, calls };
		}

		// up: the skill that helps most, a step at a time
		label = 'Raising the skills that help most';
		let at = start;
		let helping = skills;
		while (!at.met && !spent()) {
			const tried = await Promise.all(helping
				.filter(skill => levels[skill]! < MAX_LEVEL)
				.map(async skill => ({ skill, trial: await check({ ...levels, [skill]: Math.min(MAX_LEVEL, levels[skill]! + STEP) }) })));
			const best = tried.reduce<(typeof tried)[number] | undefined>(
				(top, one) => (!top || one.trial.measure > top.trial.measure ? one : top), undefined);
			if (!best) break;
			if (best.trial.measure > at.measure) {
				levels = { ...levels, [best.skill]: Math.min(MAX_LEVEL, levels[best.skill]! + STEP) };
				at = best.trial;
				// a skill that did nothing this round is skipped until nothing else helps
				const useful = tried.filter(one => one.trial.measure > start.measure).map(one => one.skill);
				helping = useful.length ? useful : skills;
			} else {
				// no one skill helps: some goals only give way to several at once
				for (const { skill } of tried) levels[skill] = Math.min(MAX_LEVEL, levels[skill]! + STEP);
				levels = { ...levels };
				at = await check(levels);
				helping = skills;
			}
		}
		if (!at.met) return { reachable: true, alreadyMet, partial: true, current, levels, calls };
	}

	// down: each skill to the least that still meets the goal, the others as they stand
	for (const skill of skills) {
		const low = floor[skill]!;
		if (levels[skill]! <= low || spent()) continue;
		label = `Finding the least ${skill}`;
		if ((await check({ ...levels, [skill]: low })).met) {
			levels = { ...levels, [skill]: low };
			continue;
		}
		let lo = low;
		let hi = levels[skill]!;
		while (hi - lo > 1 && !spent()) {
			const mid = Math.floor((lo + hi) / 2);
			if ((await check({ ...levels, [skill]: mid })).met) hi = mid;
			else lo = mid;
		}
		levels = { ...levels, [skill]: hi };
	}

	const { passShare, accuracy, fcShare, met } = await check(levels);
	return { reachable: true, alreadyMet, partial: spent(), current, levels, trial: { passShare, accuracy, fcShare, met }, calls };
};
