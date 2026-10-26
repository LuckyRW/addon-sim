/**
 * Turning simulated plays into farm value.
 *
 * A simulated play tells you what one attempt is worth. Farming is a *rate*, so
 * the ranking divides by what the attempt costs in wall-clock time - the play
 * plus autopilot's delay before the next one.
 *
 * A play's XP is adjusted in the server's order (`serverXp`): mindblock, then
 * fatigue, then medals, then mods, each floored. The mindblock curve mirrors
 * the server's `mindblock.ts`, which the add-on cannot import.
 */

import cubic_bezier from '@oss-idle/shared/math/cubic_bezier';
import lerp from '@oss-idle/shared/math/lerp';
import { fatigueXp } from '@oss-idle/shared/fatigue';
import { modsLabel, type Mod } from '@oss-idle/shared/mods';
import { modXpMultipliers } from '@oss-idle/shared/rulesets/mania/4k/modXp';
import { MINDBLOCK_SKILLS, PHYSICAL_SKILLS } from '@oss-idle/shared/rulesets/mania/4k/skills';
import type { SimRequest, SimResult } from '../engine/protocol.js';

/**
 * Plays of each map a session is expected to have made, halfway through:
 * memory is seeded with this many plays beyond the map's count, since memory
 * trains on partly learned maps.
 */
export const MEMORY_AHEAD = 3;

/** Mindblock, mirroring the server's `mindblock.ts`: it counts a map's plays among the character's last RECENT_LIMIT in 24h. */
export const RECENT_LIMIT = 50;
const PLAYS_FOR_FULL_BLOCK = 25;
const MIN_FACTOR = 0.25;
const BLOCK_CB = cubic_bezier(.6, 0, .6, 1);

export const mindblockFactor = (recentPlays: number): number =>
	lerp(1, MIN_FACTOR, BLOCK_CB(Math.min(1, recentPlays / PLAYS_FOR_FULL_BLOCK)));

const MINDBLOCK = new Set<string>(MINDBLOCK_SKILLS);
const PHYSICAL = new Set<string>(PHYSICAL_SKILLS);

export type XpRules = {
	/** The map's plays among the character's recent ones. */
	recentPlays?: number;
	/** How tired the character plays, 0 rested to 1 exhausted (`fatigueLevel`). */
	fatigue?: number;
	/** XP multiplier from the medals held. */
	medals?: number;
	mods?: readonly Mod[];
};

/** The XP a play awards, per skill, in the server's order and flooring. */
export const serverXp = (
	xp: Record<string, number>,
	{ recentPlays = 0, fatigue = 0, medals = 1, mods = [] }: XpRules,
): Record<string, number> => {
	const block = mindblockFactor(recentPlays);
	const tired = fatigueXp(fatigue);
	const modded = modXpMultipliers(mods) as Record<string, number>;
	const out: Record<string, number> = {};
	for (const [skill, raw] of Object.entries(xp)) {
		let value = MINDBLOCK.has(skill) && block < 1 ? Math.floor(raw * block) : raw;
		if (PHYSICAL.has(skill)) value = Math.floor(value * tired);
		value = Math.floor(value * medals);
		out[skill] = Math.floor(value * (modded[skill] ?? 1));
	}
	return out;
};

/** What a {@link FarmTarget}'s secondary skills' XP is worth next to its main skills' XP. */
export const SECONDARY_WEIGHT = 0.5;

export type FarmTarget =
	| { kind: 'total' }
	/**
	 * The main skills' XP summed, plus the secondary skills' at
	 * {@link SECONDARY_WEIGHT}: the lighter plays a playlist needs to hold the
	 * peak earn little of physical main skills, so they go to the secondaries.
	 */
	| {
		kind: 'skills'; skills: readonly string[]; secondary?: readonly string[];
		/** Each skill's best XP per second, which balances several main skills: see {@link balanced}. */
		potential?: Readonly<Record<string, number>>;
	}
	/**
	 * Ranked by the pp itself, not per second: only your best score on a map
	 * counts, so playing it faster earns nothing extra. Mindblock and fatigue
	 * scale XP, not score.
	 */
	| { kind: 'pp' };

type SkillsTarget = Extract<FarmTarget, { kind: 'skills' }>;

/**
 * Whether `target` farms several main skills, each to the same share of its
 * potential: summed, the skill with the most XP to give would take every play.
 */
export const balanced = (target: FarmTarget): target is SkillsTarget & { potential: Readonly<Record<string, number>> } =>
	target.kind === 'skills' && target.skills.length > 1 && !!target.potential;

/** `xp` of `skill` over its potential: seconds of its best play's worth, 0 for a skill no play earns. */
const share = (xp: Record<string, number>, skill: string, potential: Readonly<Record<string, number>>): number =>
	potential[skill] ? (xp[skill] ?? 0) / potential[skill] : 0;

const secondaryOf = (target: SkillsTarget): string[] =>
	(target.secondary ?? []).filter(skill => !target.skills.includes(skill));

/** What a play is worth to `target`. A balanced target sums each skill's share of its potential. */
export const targetValue = (xp: Record<string, number>, target: FarmTarget, pp: number): number => {
	switch (target.kind) {
		case 'total': return Object.values(xp).reduce((sum, value) => sum + value, 0);
		case 'skills': {
			const of = (skills: readonly string[]) => skills.reduce((sum, skill) =>
				sum + (balanced(target) ? share(xp, skill, target.potential) : xp[skill] ?? 0), 0);
			return of(target.skills) + SECONDARY_WEIGHT * of(secondaryOf(target));
		}
		case 'pp': return pp;
	}
};

/**
 * What a session earning `xp` is worth to `target`. A balanced target takes
 * the geometric mean of its main skills' shares, so earning half of each beats
 * earning all of one and none of the other; secondaries count at their weight.
 */
export const sessionValue = (xp: Record<string, number>, target: FarmTarget): number => {
	if (!balanced(target)) return targetValue(xp, target, 0);
	const mains = target.skills.filter(skill => target.potential[skill]);
	const logs = mains.reduce((sum, skill) => sum + Math.log(share(xp, skill, target.potential)), 0);
	const fill = secondaryOf(target).reduce((sum, skill) => sum + share(xp, skill, target.potential), 0);
	return (mains.length ? Math.exp(logs / mains.length) : 0) + SECONDARY_WEIGHT * fill;
};

/** Each of `skills`' best XP per second among `plays`: what its best play earns played nonstop at the peak. */
export const potentialOf = (
	plays: readonly Pick<RankedMap, 'earned' | 'durationSec'>[],
	skills: readonly string[],
	delaySec: number,
): Record<string, number> => {
	const potential: Record<string, number> = {};
	for (const skill of skills) {
		potential[skill] = plays.reduce((best, play) => Math.max(best, (play.earned[skill] ?? 0) / (play.durationSec + delaySec)), 0);
	}
	return potential;
};

/** `target` with its potential read off `plays`, when it farms several main skills. */
export const withPotential = (
	target: FarmTarget,
	plays: readonly Pick<RankedMap, 'earned' | 'durationSec'>[],
	delaySec: number,
): FarmTarget =>
	target.kind === 'skills' && target.skills.length > 1 && !target.potential
		? { ...target, potential: potentialOf(plays, [...target.skills, ...secondaryOf(target)], delaySec) }
		: target;

/** A play's identity: one difficulty at one rate with one set of mods. */
export const playKey = (play: Pick<SimResult, 'beatmapId' | 'rate' | 'mods'>): string =>
	`${play.beatmapId}@${play.rate}${play.mods.length ? `+${modsLabel(play.mods)}` : ''}`;

export type RankOptions = {
	target: FarmTarget;
	/** Plays of each map in the last 24h, by beatmap id. */
	recentPlays?: ReadonlyMap<number, number>;
	/** Seconds autopilot waits between plays. */
	delaySec?: number;
	/** Drop plays that fail more often than this. */
	maxFailRate?: number;
	medals?: number;
	/** Difficulties whose plays give no pp: loved ones. Left out of a pp target. */
	noPp?: ReadonlySet<number>;
};

export type RankedMap = SimResult & {
	/** XP per skill, after mindblock, medals and mods. */
	earned: Record<string, number>;
	/** XP (or pp) toward the target, after mindblock, medals and mods; shares of potential for a balanced target. */
	value: number;
	/** `value` per second of wall clock. Meaningless for a pp target. */
	perSecond: number;
	recentPlays: number;
};

/** What the ranking sorts on: a rate for XP, which accrues with every play; the raw value for pp. */
export const rankingScore = (map: Pick<RankedMap, 'value' | 'perSecond'>, target: FarmTarget): number =>
	target.kind === 'pp' ? map.value : map.perSecond;

/** Score and sort plays at peak warm-up, best first, each play once. */
export const rankMaps = (results: readonly SimResult[], options: RankOptions): RankedMap[] => {
	const { recentPlays = new Map(), delaySec = 30, maxFailRate = 0.5, medals = 1, noPp } = options;
	const ranked: RankedMap[] = [];
	// the table keys rows by playKey, so each play has to appear once whatever the sweep produced
	const emitted = new Set<string>();
	for (const result of results) {
		if (result.failRate > maxFailRate) continue;
		if (options.target.kind === 'pp' && noPp?.has(result.beatmapId)) continue;
		const key = playKey(result);
		if (emitted.has(key)) continue;
		emitted.add(key);
		const repeats = recentPlays.get(result.beatmapId) ?? 0;
		const earned = serverXp(result.xp, { recentPlays: repeats, medals, mods: result.mods });
		ranked.push({ ...result, earned, value: 0, perSecond: 0, recentPlays: repeats });
	}
	const target = withPotential(options.target, ranked, delaySec);
	for (const map of ranked) {
		map.value = targetValue(map.earned, target, map.pp);
		const cycle = map.durationSec + delaySec;
		map.perSecond = cycle > 0 ? map.value / cycle : 0;
	}
	return ranked.sort((a, b) => rankingScore(b, target) - rankingScore(a, target));
};

/** Each difficulty once, at its best play: what the All maps table lists. */
export const bestPerDifficulty = (ranked: readonly RankedMap[]): RankedMap[] => {
	const seen = new Set<number>();
	return ranked.filter(map => !seen.has(map.beatmapId) && seen.add(map.beatmapId));
};

/**
 * The rates every map is screened at: every third of `rates`, the fastest and
 * x1 - all of them when there are only a few. The rates in between are filled
 * in by {@link refinePlan} for the maps near the top, which assumes a map's
 * value rises and falls once across its rates.
 */
export const screenRates = (rates: readonly number[]): number[] =>
	rates.length <= 5
		? [...rates]
		: rates.filter((rate, i) => i % 3 === 0 || i === rates.length - 1 || rate === 1);

/**
 * What the second pass re-simulates at the full run count: the `count` best
 * difficulties of the screening pass, each at every rate between the screened
 * rates either side of its best one, with every mod set.
 */
export const refinePlan = (
	ranked: readonly RankedMap[],
	rates: readonly number[],
	screened: readonly number[],
	count: number,
	mods: Mod[][],
	minutes: number,
): SimRequest[] => {
	const plan: SimRequest[] = [];
	for (const map of bestPerDifficulty(ranked).slice(0, count)) {
		const at = screened.indexOf(map.rate);
		const below = screened[at - 1] ?? -Infinity;
		const above = screened[at + 1] ?? Infinity;
		plan.push({
			setId: map.setId,
			beatmapId: map.beatmapId,
			rates: rates.filter(rate => rate > below && rate < above),
			mods,
			minutes: [minutes],
		});
	}
	return plan;
};
