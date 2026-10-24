/**
 * Turning simulated plays into farm value[cite: 7].
 *
 * A simulated play tells you what one attempt is worth[cite: 7]. Farming is a *rate*, so
 * the ranking divides by what the attempt costs in wall-clock time, and then
 * accounts for **mindblock**: repeating the same map inside a 24h window scales
 * its technique XP down toward 25%, over ~25 plays, with stamina, memory, speed
 * and jackspeed exempt[cite: 7]. That is why the best *single* map is not the best
 * *farm*[cite: 7].
 *
 * The curve is the game's own, mirroring the server's `mindblock.ts`, so this
 * cannot drift from what the player actually earns[cite: 7].
 *
 * (oss!idle 0.19 removed the session-fatigue XP multiplier - `getSkillsXP` no
 * longer takes a factor and `getServerXP` no longer computes one - so there is
 * nothing here for it.)[cite: 7]
 */

import { MINDBLOCK_SKILLS } from '@oss-idle/shared/skills';
import cubic_bezier from '@oss-idle/shared/math/cubic_bezier';
import lerp from '@oss-idle/shared/math/lerp';
import type { SimRequest, SimResult } from '../engine/protocol.js';

/**
 * How many times a session is expected to cycle the playlist, so each of its
 * maps is played this many times[cite: 7]. Charges mindblock in {@link buildRotation},
 * and puts memory halfway through those plays when a map is simulated[cite: 7].
 */
export const PLAYS_PER_MAP = 5;

/** Mindblock constants, mirroring the server's `mindblock.ts`. */
const PLAYS_FOR_FULL_BLOCK = 25;
const MIN_FACTOR = 0.25;
const BLOCK_CB = cubic_bezier(.6, 0, .6, 1);

/** How much technique XP survives after `recentPlays` repeats in 24h[cite: 7]. */
const mindblockFactor = (recentPlays: number): number =>
	lerp(1, MIN_FACTOR, BLOCK_CB(Math.min(1, recentPlays / PLAYS_FOR_FULL_BLOCK)));

const MINDBLOCK_SET = new Set<string>(MINDBLOCK_SKILLS as unknown as string[]);

/**
 * The XP a play awards after mindblock and then the medal bonus, per skill -
 * the order and flooring of the server's `getServerXP`[cite: 7].
 */
const adjustedXp = (
	xp: Record<string, number>,
	{ recentPlays = 0, medalMultiplier = 1 }: { recentPlays?: number; medalMultiplier?: number } = {},
): Record<string, number> => {
	const block = mindblockFactor(recentPlays);
	const out: Record<string, number> = {};
	for (const [skill, value] of Object.entries(xp)) {
		const blocked = MINDBLOCK_SET.has(skill) ? Math.floor(value * block) : value;
		out[skill] = Math.floor(blocked * medalMultiplier);
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

export type FatigueImpact = {
	strainedMinutes: number;
	deltaMinutes: number;
	formatted: string;
	isDrain: boolean;
};

const FULL_STRAIN_SHARE = 0.4;
const REST_RATE = 0.4;

/**
 * Calculates strained minutes and net fatigue change (Δ)[cite: 7].
 * Strains over 40% physical share saturate to 100% strained play[cite: 7].
 */
export function calculateFatigueDelta(
	durationSec: number,
	physicalShare: number,
	overheadSec = 8,
): FatigueImpact {
	const playDurationMins = durationSec / 60;
	const idleMins = overheadSec / 60;

	// Exact game playStrain formula: >= 40% physical share counts as 100% strained[cite: 7]
	const strainedMinutes = Math.min(1.0, physicalShare / FULL_STRAIN_SHARE) * playDurationMins;
	const unstrainedPlayMins = playDurationMins - strainedMinutes;

	// In-play recovery + gap overhead recovery[cite: 7]
	const recoveredMinutes = REST_RATE * (unstrainedPlayMins + idleMins);
	const deltaMinutes = strainedMinutes - recoveredMinutes;

	return {
		strainedMinutes,
		deltaMinutes,
		formatted: deltaMinutes >= 0 ? `+${deltaMinutes.toFixed(2)}m` : `${deltaMinutes.toFixed(2)}m`,
		isDrain: deltaMinutes > 0,
	};
}

type RankOptions = {
	target: FarmTarget;
	/** Repeats already made of each map in the last 24h, by beatmap id[cite: 7]. */
	recentPlays?: Map<number, number>;
	/**
	 * Seconds of overhead per play beyond the chart itself - result screen,
	 * transition and song load[cite: 7]. Autopilot pays this on every cycle, so it is
	 * part of the true rate and it penalises short maps[cite: 7].
	 */
	overheadSec?: number;
	/**
	 * Drop maps the character usually cannot clear[cite: 7]. Failing is probabilistic, so
	 * this is a threshold on the share of simulated runs that died, not a flag:
	 * a map that dies half the time is not a farm, but one that dies once in ten
	 * attempts still is[cite: 7].
	 */
	maxFailRate?: number;
	/** XP multiplier from the medals the character holds - see `medalMultiplier` in `engine/client.ts`[cite: 7]. */
	medalMultiplier?: number;
};

export type RankedMap = SimResult & {
	/** XP (or pp) toward the chosen target, after adjustments[cite: 7]. */
	value: number;
	/** `value` per second of wall-clock play. Meaningless for a pp target[cite: 7]. */
	perSecond: number;
	/** Full play cost including overhead[cite: 7]. */
	cycleSec: number;
	/** Repeats assumed when computing `value`[cite: 7]. */
	recentPlays: number;
	/** Macro fatigue strain impact and net delta[cite: 7] */
	fatigue: FatigueImpact;
	physicalShare: number;
};

/**
 * What the ranking actually sorts on[cite: 7].
 *
 * A rate for XP, which accrues with every play; the raw value for pp, which
 * does not[cite: 7].
 */
const rankingScore = (
	map: Pick<RankedMap, 'value' | 'perSecond'>,
	target: FarmTarget,
): number => (target.kind === 'pp' ? map.value : map.perSecond);

/** A row's identity: one difficulty at one rate[cite: 7]. */
export const rowKey = (map: Pick<SimResult, 'beatmapId' | 'rate'>): string =>
	`${map.beatmapId}@${map.rate}`;

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
			// Untouched by the XP adjustments - see the target's note[cite: 7].
			return result.pp;
	}
};

/** Score and sort simulated maps by XP per second, best first[cite: 7]. */
export const rankMaps = (results: readonly SimResult[], options: RankOptions): RankedMap[] => {
	const {
		target,
		recentPlays = new Map<number, number>(),
		overheadSec = 8,
		maxFailRate = 0.5,
		medalMultiplier = 1,
	} = options;

	const ranked: RankedMap[] = [];
	// Every rendered row comes through here, and the table keys rows by
	// `rowKey` - so this is the one place that has to guarantee each difficulty
	// appears once per rate, whatever the sweep produced[cite: 7].
	const emitted = new Set<string>();

	for (const result of results) {
		if (result.failRate > maxFailRate) continue;
		const key = rowKey(result);
		if (emitted.has(key)) continue;
		emitted.add(key);

		const repeats = recentPlays.get(result.beatmapId) ?? 0;
		const xp = adjustedXp(result.xp, { recentPlays: repeats, medalMultiplier });
		const value = valueOf(xp, target, result);
		const cycleSec = result.durationSec + overheadSec;

		// Physical share includes all 3 physical skills: Speed, Stamina, and JackSpeed[cite: 7]
		const physXp = (result.xp['speed'] ?? 0) + (result.xp['stamina'] ?? 0) + (result.xp['jackspeed'] ?? 0);
		const totalEarnedXp = Object.values(result.xp).reduce((a, b) => a + b, 0) || 1;

		// Physical share ratio (clamped to [0, 1])[cite: 7]
		const physicalShare = Math.min(1, Math.max(0, physXp / totalEarnedXp));

		const fatigue = calculateFatigueDelta(result.durationSec, physicalShare, overheadSec);

		ranked.push({
			...result,
			value,
			cycleSec,
			perSecond: cycleSec > 0 ? value / cycleSec : 0,
			recentPlays: repeats,
			physicalShare,
			fatigue,
		});
	}

	return ranked.sort((a, b) => rankingScore(b, target) - rankingScore(a, target));
};

type RotationOptions = {
	size?: number;
	playsPerMap?: number;
	target: FarmTarget;
	overheadSec?: number;
	/**
	 * Allow at most one difficulty per beatmapset. Off by default - a taste
	 * preference, not a farm consideration, since mindblock is per difficulty[cite: 7].
	 */
	oneMapPerSet?: boolean;
	medalMultiplier?: number;
	/** Whether entries are locked at their rates, so the rotation can mix them[cite: 7]. */
	mixRates?: boolean;
	/**
	 * Let the rotation hold a difficulty at several rates. Never for a pp target,
	 * where only a difficulty's best score counts[cite: 7].
	 */
	severalRates?: boolean;
};

/**
 * Pick a rotation of `size` maps[cite: 7].
 *
 * Not simply the top N: mindblock is per map, so a rotation's real value
 * depends on how often each map comes round[cite: 7]. Maps are chosen greedily by the
 * rate they would have *at their position in the rotation* - the first pick is
 * played most and is charged the most repeats - which naturally spreads the
 * playlist across several maps instead of stacking near-identical ones[cite: 7].
 *
 * Two difficulties of one beatmapset are **not** the same map for this purpose:
 * mindblock counts plays per difficulty, so each carries its own decay and both
 * can earn a place[cite: 7]. `oneMapPerSet` exists only for players who would rather not
 * hear one song on repeat, and is off by default[cite: 7].
 *
 * `playsPerMap` is how many times the player expects to cycle the whole
 * playlist in a session; with a rotation of `size`, each map is then played
 * that many times rather than all repeats landing on one map[cite: 7].
 *
 * An unlocked playlist plays at the one rate the player has picked, so unless
 * entries are locked (`mixRates`) the rotation is built at each rate the
 * ranking holds and the best one kept: every map in it shares
 * {@link RankedMap.rate}[cite: 7].
 */
export const buildRotation = (
	ranked: readonly RankedMap[],
	options: RotationOptions,
): RankedMap[] => {
	if (options.mixRates) return rotationAt(ranked, options);

	const byRate = new Map<number, RankedMap[]>();
	for (const map of ranked) {
		const maps = byRate.get(map.rate);
		if (maps) maps.push(map);
		else byRate.set(map.rate, [map]);
	}

	let best: RankedMap[] = [];
	let bestTotal = -Infinity;
	for (const maps of byRate.values()) {
		const rotation = rotationAt(maps, options);
		const total = rotation.reduce((sum, map) => sum + rankingScore(map, options.target), 0);
		if (total > bestTotal) {
			best = rotation;
			bestTotal = total;
		}
	}
	return best;
};

/** The greedy pick of {@link buildRotation}, among maps at one rate[cite: 7]. */
const rotationAt = (
	ranked: readonly RankedMap[],
	{
		size = 5,
		playsPerMap = PLAYS_PER_MAP,
		target,
		overheadSec = 8,
		oneMapPerSet = false,
		medalMultiplier = 1,
		severalRates = false,
	}: RotationOptions,
): RankedMap[] => {
	const chosen: RankedMap[] = [];
	const usedSets = new Set<number>();
	/** Rates already picked of each difficulty: mindblock counts them all as its plays[cite: 7]. */
	const picks = new Map<number, number>();
	const oncePerDifficulty = !severalRates || target.kind === 'pp';
	const remaining = [...ranked];

	while (chosen.length < size && remaining.length) {
		let bestIndex = -1;
		let bestRate = -Infinity;

		remaining.forEach((candidate, index) => {
			if (oneMapPerSet && usedSets.has(candidate.setId)) return;
			const picked = picks.get(candidate.beatmapId) ?? 0;
			if (oncePerDifficulty && picked) return;
			// Charge this candidate the repeats it would actually accumulate,
			// its other rates' plays included[cite: 7]. (Mindblock scales XP only, so for
			// a pp target this is a no-op and the pick is simply the best-scoring
			// map left[cite: 7].)
			const xp = adjustedXp(candidate.xp, {
				recentPlays: candidate.recentPlays + playsPerMap * (picked + 1), medalMultiplier,
			});
			const value = valueOf(xp, target, candidate);
			const score = rankingScore(
				{ value, perSecond: value / (candidate.durationSec + overheadSec) },
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
		picks.set(pick.beatmapId, (picks.get(pick.beatmapId) ?? 0) + 1);
		// Keep the map's own numbers for a pp target; only an XP rate is
		// re-derived from the repeats charged above[cite: 7].
		chosen.push(target.kind === 'pp' ? pick : { ...pick, perSecond: bestRate });
	}

	return chosen;
};

/**
 * What the table lists: each difficulty once, at its best rate - unless the
 * rotation holds it, then at the rates the rotation holds it at, so the picks
 * shown are the plays the playlist makes[cite: 7].
 */
export const tableRows = (
	ranked: readonly RankedMap[],
	rotation: readonly RankedMap[],
): RankedMap[] => {
	const picked = new Set(rotation.map(rowKey));
	const inRotation = new Set(rotation.map(map => map.beatmapId));
	const listed = new Set<number>();
	return ranked.filter(map => {
		const show = picked.has(rowKey(map))
			|| (!inRotation.has(map.beatmapId) && !listed.has(map.beatmapId));
		if (show) listed.add(map.beatmapId);
		return show;
	});
};

/**
 * The rates every map is screened at: every third of `rates`, the fastest and
 * x1 - all of them when there are only a few[cite: 7].
 *
 * A sweep at every rate is a full library sweep per rate, and most of the
 * library is nowhere near the top[cite: 7]. The rates in between are filled in by
 * {@link refinePlan} for the maps that are, which assumes a map's value rises
 * and falls once across its rates rather than peaking twice[cite: 7].
 */
export const screenRates = (rates: readonly number[]): number[] =>
	rates.length <= 5
		? [...rates]
		: rates.filter((rate, i) => i % 3 === 0 || i === rates.length - 1 || rate === 1);

/**
 * What the second pass re-simulates at the full run count: the `count` best
 * difficulties of the screening pass, each at every rate between the screened
 * rates either side of its best one[cite: 7].
 *
 * `ranked` is best first, so a difficulty's first row is its best rate[cite: 7].
 */
export const refinePlan = (
	ranked: readonly RankedMap[],
	rates: readonly number[],
	screened: readonly number[],
	count: number,
): SimRequest[] => {
	const plan: SimRequest[] = [];
	const seen = new Set<number>();
	for (const map of ranked) {
		if (plan.length >= count) break;
		if (seen.has(map.beatmapId)) continue;
		seen.add(map.beatmapId);
		const at = screened.indexOf(map.rate);
		const below = screened[at - 1] ?? -Infinity;
		const above = screened[at + 1] ?? Infinity;
		plan.push({
			setId: map.setId,
			beatmapId: map.beatmapId,
			rates: rates.filter(rate => rate > below && rate < above),
		});
	}
	return plan;
};

export type DualFarmOptions = {
	allResults: readonly SimResult[];
	coordTarget?: string; // defaults to 'coordination'
	speedTarget?: string; // defaults to 'speed'
	maxCoordStrainShare?: number; // 0.06 (6%)
	overheadSec?: number;
	medalMultiplier?: number;
	maxCoordPicks?: number;
};

/**
 * Builds an optimal, net-zero fatigue playlist pairing non-physical
 * recovery maps with high-efficiency speed burst maps[cite: 7].
 */
export function buildBalancedDualRotation(options: DualFarmOptions): RankedMap[] {
	const {
		allResults,
		coordTarget = 'coordination',
		speedTarget = 'speed',
		maxCoordStrainShare = 0.06,
		overheadSec = 8,
		medalMultiplier = 1,
		maxCoordPicks = 3,
	} = options;

	// 1. Rank for Coordination[cite: 7]
	const coordRanked = rankMaps(allResults, {
		target: { kind: 'skill', skill: coordTarget },
		overheadSec,
		medalMultiplier,
	});

	// Filter down to ultra-low strain healers[cite: 7]
	const coordCandidates = coordRanked.filter(
		m => m.physicalShare <= maxCoordStrainShare && m.fatigue.deltaMinutes < 0,
	);

	const coordPicks: RankedMap[] = [];
	const seenSets = new Set<number>();
	let totalFatigueHealed = 0;

	for (const map of coordCandidates) {
		if (coordPicks.length >= maxCoordPicks) break;
		if (seenSets.has(map.setId)) continue;
		seenSets.add(map.setId);
		coordPicks.push(map);
		totalFatigueHealed += Math.abs(map.fatigue.deltaMinutes);
	}

	if (coordPicks.length === 0) return [];

	// 2. Rank for Speed[cite: 7]
	const speedRanked = rankMaps(allResults, {
		target: { kind: 'skill', skill: speedTarget },
		overheadSec,
		medalMultiplier,
	});

	// Filter down to positive strain maps and sort by efficiency: Raw Speed XP / deltaDrain
	const speedCandidates = speedRanked
		.filter(m => m.fatigue.deltaMinutes > 0 && !seenSets.has(m.setId))
		.map(m => ({
			map: m,
			efficiency: m.value / Math.max(0.1, m.fatigue.deltaMinutes),
		}))
		.sort((a, b) => b.efficiency - a.efficiency);

	const speedPicks: RankedMap[] = [];
	let totalFatigueDrained = 0;

	for (const candidate of speedCandidates) {
		const drain = candidate.map.fatigue.deltaMinutes;
		// Stop if adding this map exceeds our earned recovery budget[cite: 7]
		if (totalFatigueDrained + drain > totalFatigueHealed) continue;

		if (seenSets.has(candidate.map.setId)) continue;
		seenSets.add(candidate.map.setId);
		speedPicks.push(candidate.map);
		totalFatigueDrained += drain;
	}

	// 3. Interleave so character rests between intense strain bursts[cite: 7]
	const interleaved: RankedMap[] = [];
	const maxLen = Math.max(coordPicks.length, speedPicks.length);
	for (let i = 0; i < maxLen; i++) {
		if (speedPicks[i]) interleaved.push(speedPicks[i]);
		if (coordPicks[i]) interleaved.push(coordPicks[i]);
	}

	return interleaved;
}