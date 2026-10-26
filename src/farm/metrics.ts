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

/** What a {@link FarmTarget}'s secondary skill's XP is worth next to its main skills' XP. */
export const SECONDARY_WEIGHT = 0.5;

export type FarmTarget =
	| { kind: 'total' }
	/**
	 * The main skills' XP summed, plus the secondary skill's at
	 * {@link SECONDARY_WEIGHT}: the lighter plays a playlist needs to hold the
	 * peak earn little of physical main skills, so they go to the secondary.
	 */
	| { kind: 'skills'; skills: readonly string[]; secondary?: string }
	/**
	 * Ranked by the pp itself, not per second: only your best score on a map
	 * counts, so playing it faster earns nothing extra. Mindblock and fatigue
	 * scale XP, not score.
	 */
	| { kind: 'pp' };

export const targetValue = (xp: Record<string, number>, target: FarmTarget, pp: number): number => {
	switch (target.kind) {
		case 'total': return Object.values(xp).reduce((sum, value) => sum + value, 0);
		case 'skills': {
			const main = target.skills.reduce((sum, skill) => sum + (xp[skill] ?? 0), 0);
			const { secondary } = target;
			return secondary && !target.skills.includes(secondary) ? main + SECONDARY_WEIGHT * (xp[secondary] ?? 0) : main;
		}
		case 'pp': return pp;
	}
};

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
	/** XP (or pp) toward the target, after mindblock, medals and mods. */
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
	const { target, recentPlays = new Map(), delaySec = 30, maxFailRate = 0.5, medals = 1, noPp } = options;
	const ranked: RankedMap[] = [];
	// the table keys rows by playKey, so each play has to appear once whatever the sweep produced
	const emitted = new Set<string>();
	for (const result of results) {
		if (result.failRate > maxFailRate) continue;
		if (target.kind === 'pp' && noPp?.has(result.beatmapId)) continue;
		const key = playKey(result);
		if (emitted.has(key)) continue;
		emitted.add(key);
		const repeats = recentPlays.get(result.beatmapId) ?? 0;
		const xp = serverXp(result.xp, { recentPlays: repeats, medals, mods: result.mods });
		const value = targetValue(xp, target, result.pp);
		const cycle = result.durationSec + delaySec;
		ranked.push({ ...result, value, perSecond: cycle > 0 ? value / cycle : 0, recentPlays: repeats });
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
