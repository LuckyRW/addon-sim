/**
 * Turning simulated plays into farm value.
 *
 * A simulated play tells you what one attempt is worth. Farming is a *rate*, so
 * the ranking divides by what the attempt costs in wall-clock time, and then
 * accounts for **mindblock**: repeating the same map inside a 24h window scales
 * its technique XP down toward 25%, over ~25 plays, with stamina, memory, speed
 * and jackspeed exempt. That is why the best *single* map is not the best
 * *farm*.
 *
 * The curve is the game's own, mirroring the server's `mindblock.ts`, so this
 * cannot drift from what the player actually earns.
 *
 * (osu!idle 0.19 removed the session-fatigue XP multiplier - `getSkillsXP` no
 * longer takes a factor and `getServerXP` no longer computes one - so there is
 * nothing here for it.)
 */

import { MINDBLOCK_SKILLS } from '@osu-idle/shared/skills';
import cubic_bezier from '@osu-idle/shared/math/cubic_bezier';
import lerp from '@osu-idle/shared/math/lerp';
import type { SimResult } from '../engine/protocol.js';

/** Mindblock constants, mirroring the server's `mindblock.ts`. */
const PLAYS_FOR_FULL_BLOCK = 25;
const MIN_FACTOR = 0.25;
const BLOCK_CB = cubic_bezier(.6, 0, .6, 1);

/** How much technique XP survives after `recentPlays` repeats in 24h. */
const mindblockFactor = (recentPlays: number): number =>
	lerp(1, MIN_FACTOR, BLOCK_CB(Math.min(1, recentPlays / PLAYS_FOR_FULL_BLOCK)));

const MINDBLOCK_SET = new Set<string>(MINDBLOCK_SKILLS as unknown as string[]);

/** The XP a play awards after mindblock, per skill. */
const adjustedXp = (
	xp: Record<string, number>,
	{ recentPlays = 0 }: { recentPlays?: number } = {},
): Record<string, number> => {
	const block = mindblockFactor(recentPlays);
	const out: Record<string, number> = {};
	for (const [skill, value] of Object.entries(xp)) {
		out[skill] = MINDBLOCK_SET.has(skill) ? Math.floor(value * block) : value;
	}
	return out;
};

export type FarmTarget =
	/** Rank by the sum across every skill. */
	| { kind: 'total' }
	/** Rank by one skill's XP alone. */
	| { kind: 'skill'; skill: string }
	/**
	 * Rank by performance points.
	 *
	 * **Ranked by the pp itself, not by pp per second.** XP accumulates, so for
	 * XP the useful question is a rate - how much per minute of play. pp does
	 * not: only your best score on a map counts, and your total is a weighted
	 * sum of your top plays, so playing a map twice as fast earns you nothing
	 * extra. The question is simply which map your character would score most
	 * on. Mindblock does not apply either, since it scales XP rather than score.
	 */
	| { kind: 'pp' };

type RankOptions = {
	target: FarmTarget;
	/** Repeats already made of each map in the last 24h, by beatmap id. */
	recentPlays?: Map<number, number>;
	/**
	 * Seconds of overhead per play beyond the chart itself - result screen,
	 * transition and song load. Autopilot pays this on every cycle, so it is
	 * part of the true rate and it penalises short maps.
	 */
	overheadSec?: number;
	/**
	 * Drop maps the character usually cannot clear. Failing is probabilistic, so
	 * this is a threshold on the share of simulated runs that died, not a flag:
	 * a map that dies half the time is not a farm, but one that dies once in ten
	 * attempts still is.
	 */
	maxFailRate?: number;
};

export type RankedMap = SimResult & {
	/** XP (or pp) toward the chosen target, after adjustments. */
	value: number;
	/** `value` per second of wall-clock play. Meaningless for a pp target. */
	rate: number;
	/** Full play cost including overhead. */
	cycleSec: number;
	/** Repeats assumed when computing `value`. */
	recentPlays: number;
};

/**
 * What the ranking actually sorts on.
 *
 * A rate for XP, which accrues with every play; the raw value for pp, which
 * does not.
 */
const rankingScore = (
	map: Pick<RankedMap, 'value' | 'rate'>,
	target: FarmTarget,
): number => (target.kind === 'pp' ? map.value : map.rate);

const valueOf = (
	xp: Record<string, number>,
	target: FarmTarget,
	result: { pp: number },
): number => {
	switch (target.kind) {
		case 'total':
			return Object.values(xp).reduce((sum, value) => sum + value, 0);
		case 'skill':
			return xp[target.skill] ?? 0;
		case 'pp':
			// Untouched by the XP adjustments - see the target's note.
			return result.pp;
	}
};

/** Score and sort simulated maps by XP per second, best first. */
export const rankMaps = (results: readonly SimResult[], options: RankOptions): RankedMap[] => {
	const {
		target,
		recentPlays = new Map<number, number>(),
		overheadSec = 8,
		maxFailRate = 0.5,
	} = options;

	const ranked: RankedMap[] = [];
	// Every rendered row comes through here, and the table keys rows by
	// beatmapId - so this is the one place that has to guarantee each difficulty
	// appears once, whatever the sweep produced.
	const emitted = new Set<number>();

	for (const result of results) {
		if (result.failRate > maxFailRate) continue;
		if (emitted.has(result.beatmapId)) continue;
		emitted.add(result.beatmapId);

		const repeats = recentPlays.get(result.beatmapId) ?? 0;
		const xp = adjustedXp(result.xp, { recentPlays: repeats });
		const value = valueOf(xp, target, result);
		const cycleSec = result.durationSec + overheadSec;

		ranked.push({
			...result,
			value,
			cycleSec,
			rate: cycleSec > 0 ? value / cycleSec : 0,
			recentPlays: repeats,
		});
	}

	return ranked.sort((a, b) => rankingScore(b, target) - rankingScore(a, target));
};

/**
 * Pick a rotation of `size` maps.
 *
 * Not simply the top N: mindblock is per map, so a rotation's real value
 * depends on how often each map comes round. Maps are chosen greedily by the
 * rate they would have *at their position in the rotation* - the first pick is
 * played most and is charged the most repeats - which naturally spreads the
 * playlist across several maps instead of stacking near-identical ones.
 *
 * Two difficulties of one beatmapset are **not** the same map for this purpose:
 * mindblock counts plays per difficulty, so each carries its own decay and both
 * can earn a place. `oneMapPerSet` exists only for players who would rather not
 * hear one song on repeat, and is off by default.
 *
 * `playsPerMap` is how many times the player expects to cycle the whole
 * playlist in a session; with a rotation of `size`, each map is then played
 * that many times rather than all repeats landing on one map.
 */
export const buildRotation = (
	ranked: readonly RankedMap[],
	{
		size = 5,
		playsPerMap = 5,
		target,
		overheadSec = 8,
		oneMapPerSet = false,
	}: {
		size?: number;
		playsPerMap?: number;
		target: FarmTarget;
		overheadSec?: number;
		/**
		 * Allow at most one difficulty per beatmapset. Off by default - a taste
		 * preference, not a farm consideration, since mindblock is per difficulty.
		 */
		oneMapPerSet?: boolean;
	},
): RankedMap[] => {
	const chosen: RankedMap[] = [];
	const usedSets = new Set<number>();
	const remaining = [...ranked];

	while (chosen.length < size && remaining.length) {
		let bestIndex = -1;
		let bestRate = -Infinity;

		remaining.forEach((candidate, index) => {
			if (oneMapPerSet && usedSets.has(candidate.setId)) return;
			// Charge this candidate the repeats it would actually accumulate.
			// (Mindblock scales XP only, so for a pp target this is a no-op and
			// the pick is simply the best-scoring map left.)
			const xp = adjustedXp(candidate.xp, { recentPlays: candidate.recentPlays + playsPerMap });
			const value = valueOf(xp, target, candidate);
			const score = rankingScore(
				{ value, rate: value / (candidate.durationSec + overheadSec) },
				target,
			);
			if (score > bestRate) {
				bestRate = score;
				bestIndex = index;
			}
		});

		if (bestIndex < 0) break;
		const [pick] = remaining.splice(bestIndex, 1);
		if (!pick) break;
		usedSets.add(pick.setId);
		// Keep the map's own numbers for a pp target; only an XP rate is
		// re-derived from the repeats charged above.
		chosen.push(target.kind === 'pp' ? pick : { ...pick, rate: bestRate });
	}

	return chosen;
};
