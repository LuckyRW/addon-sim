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

/** Pass the map, or pass it at this accuracy (0 to 1) on average. */
export type Goal = { kind: 'pass' } | { kind: 'accuracy'; accuracy: number };

/** The share of a level's plays that have to pass for it to count: one lucky play is not a level. */
export const PASS_SHARE = 0.9;
/** The highest level tried: past it, a goal counts as out of reach. */
export const MAX_LEVEL = 150;
/** Levels a skill goes up by while looking for the goal; lowering it again finds the exact level. */
const STEP = 10;
/** Sim calls one search makes at most: what it has found stands when they run out. */
const MAX_CALLS = 3000;

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
};

/** What a set of levels did. */
export type Trial = {
	/** Share of the plays that passed. */
	passShare: number;
	/** Their mean accuracy, 0 to 1. */
	accuracy: number;
	met: boolean;
};

export type MinimumResult = {
	/** False when even every skill at {@link MAX_LEVEL} does not meet the goal. */
	reachable: boolean;
	/** The goal was already met at the character's levels. */
	alreadyMet: boolean;
	/** The search was stopped or ran out of calls: `levels` is as far as it got, and may not be the least. */
	partial: boolean;
	/** The character's level in each skill. */
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

export const findMinimum = async (
	job: MinimumJob,
	simulate: (body: ApiSimulateRequest) => Promise<ApiSimulation>,
	{ onProgress, cancelled = () => false, pace = paced }: MinimumOptions = {},
): Promise<MinimumResult> => {
	const current = currentLevels(job.state);
	const skills = Object.keys(current);
	let calls = 0;
	let label = '';
	const spent = () => cancelled() || calls >= MAX_CALLS;

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
				skills: stateWith(job.state, levels, current),
			});
		})));
		const mean = (of: (play: ApiSimulation) => number) => plays.reduce((sum, play) => sum + of(play), 0) / plays.length;
		const passShare = mean(play => (play.passed ? 1 : 0));
		const accuracy = mean(play => play.accuracy);
		const trial = {
			passShare,
			accuracy,
			met: passShare >= PASS_SHARE && (job.goal.kind === 'pass' || accuracy >= job.goal.accuracy),
			// how far through the map plays get counts too: while all of them fail, it alone tells levels apart
			measure: mean(play => (play.passed ? 1 : play.fail_progress ?? 0)) + accuracy,
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

	const { passShare, accuracy, met } = await check(levels);
	return { reachable: true, alreadyMet, partial: spent(), current, levels, trial: { passShare, accuracy, met }, calls };
};
