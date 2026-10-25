/**
 * Turning simulated plays into farm value.
 *
 * A simulated play tells you what one attempt is worth. Farming is a *rate*, so
 * the ranking divides by what the attempt costs in wall-clock time, and then
 * accounts for **mindblock**: repeating the same map inside a 24h window scales
 * its technique XP down toward 25%, over ~25 plays.
 *
 * As of v1.2.5.0, physical skills (speed, stamina, jackspeed, and coordination)
 * are exempt from mindblock, while non-physical skills (reading, accuracy, etc.)
 * accumulate it.
 */

import { MINDBLOCK_SKILLS } from '@oss-idle/shared/skills';
import cubic_bezier from '@oss-idle/shared/math/cubic_bezier';
import lerp from '@oss-idle/shared/math/lerp';
import type { SimRequest, SimResult } from '../engine/protocol.js';

export const PHYSICAL_SKILLS = new Set<string>([
	'speed',
	'stamina',
	'jackspeed',
	'coordination',
]);

/**
 * How many times a session is expected to cycle the playlist, so each of its
 * maps is played this many times. Charges mindblock in {@link buildRotation},
 * and puts memory halfway through those plays when a map is simulated.
 */
export const PLAYS_PER_MAP = 5;

/** Mindblock constants, mirroring the server's `mindblock.ts`. */
const PLAYS_FOR_FULL_BLOCK = 25;
const MIN_FACTOR = 0.25;
const BLOCK_CB = cubic_bezier(0.6, 0, 0.6, 1);

/** How much technique XP survives after `recentPlays` repeats in 24h. */
const mindblockFactor = (recentPlays: number): number =>
	lerp(1, MIN_FACTOR, BLOCK_CB(Math.min(1, recentPlays / PLAYS_FOR_FULL_BLOCK)));

const MINDBLOCK_SET = new Set<string>(MINDBLOCK_SKILLS as unknown as string[]);
// Coordination is now physical in v1.2.5.0 and no longer mindblocked
MINDBLOCK_SET.delete('coordination');

/**
 * The XP a play awards after mindblock and then the medal bonus, per skill -
 * the order and flooring of the server's `getServerXP`.
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
 * Calculates strained minutes and net fatigue change (Δ).
 * Strains over 40% physical share saturate to 100% strained play.
 */
export function calculateFatigueDelta(
	durationSec: number,
	physicalShare: number,
	overheadSec = 8,
): FatigueImpact {
	const playDurationMins = durationSec / 60;
	const idleMins = overheadSec / 60;

	// Exact game playStrain formula: >= 40% physical share counts as 100% strained
	const strainedMinutes = Math.min(1.0, physicalShare / FULL_STRAIN_SHARE) * playDurationMins;
	const unstrainedPlayMins = playDurationMins - strainedMinutes;

	// In-play recovery + gap overhead recovery
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
	/** XP multiplier from the medals the character holds - see `medalMultiplier` in `engine/client.ts`. */
	medalMultiplier?: number;
};

export type RankedMap = SimResult & {
	/** XP (or pp) toward the chosen target, after adjustments. */
	value: number;
	/** `value` per second of wall-clock play. Meaningless for a pp target. */
	perSecond: number;
	/** Full play cost including overhead. */
	cycleSec: number;
	/** Repeats assumed when computing `value`. */
	recentPlays: number;
	/** Macro fatigue strain impact and net delta */
	fatigue: FatigueImpact;
	physicalShare: number;
};

/**
 * What the ranking actually sorts on.
 *
 * A rate for XP, which accrues with every play; the raw value for pp, which
 * does not.
 */
const rankingScore = (
	map: Pick<RankedMap, 'value' | 'perSecond'>,
	target: FarmTarget,
): number => (target.kind === 'pp' ? map.value : map.perSecond);

/** A row's identity: one difficulty at one rate. */
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
		medalMultiplier = 1,
	} = options;

	const ranked: RankedMap[] = [];
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

		// Prefer the simulation bot's ground-truth physicalShare over the XP heuristic
		let physicalShare: number;
		if (result.physicalShare !== undefined) {
			physicalShare = Math.min(1, Math.max(0, result.physicalShare));
		} else {
			// Physical skills include speed, stamina, jackspeed, and coordination
			const physXp =
				(result.xp['speed'] ?? 0) +
				(result.xp['stamina'] ?? 0) +
				(result.xp['jackspeed'] ?? 0) +
				(result.xp['coordination'] ?? 0);
			const totalEarnedXp = Object.values(result.xp).reduce((a, b) => a + b, 0) || 1;
			physicalShare = Math.min(1, Math.max(0, physXp / totalEarnedXp));
		}

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
	oneMapPerSet?: boolean;
	medalMultiplier?: number;
	mixRates?: boolean;
	severalRates?: boolean;
};

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
			const xp = adjustedXp(candidate.xp, {
				recentPlays: candidate.recentPlays + playsPerMap * (picked + 1),
				medalMultiplier,
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
		chosen.push(target.kind === 'pp' ? pick : { ...pick, perSecond: bestRate });
	}

	return chosen;
};

export const tableRows = (
	ranked: readonly RankedMap[],
	rotation: readonly RankedMap[],
): RankedMap[] => {
	const picked = new Set(rotation.map(rowKey));
	const inRotation = new Set(rotation.map(map => map.beatmapId));
	const listed = new Set<number>();
	return ranked.filter(map => {
		const show =
			picked.has(rowKey(map)) ||
			(!inRotation.has(map.beatmapId) && !listed.has(map.beatmapId));
		if (show) listed.add(map.beatmapId);
		return show;
	});
};

export const screenRates = (rates: readonly number[]): number[] =>
	rates.length <= 5
		? [...rates]
		: rates.filter((rate, i) => i % 3 === 0 || i === rates.length - 1 || rate === 1);

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

export type PureFarmOptions = {
	allResults: readonly SimResult[];
	target: FarmTarget;
	size?: number;
	overheadSec?: number;
	medalMultiplier?: number;
	maxFailRate?: number;
	maxDurationSec?: number;
};

/**
 * Builds a pure, unconstrained maximum XP/second playlist for the chosen target.
 * Picks the absolute top distinct beatmaps by XP/s at their best respective rates.
 */
export function buildMaxXpRotation(options: PureFarmOptions): RankedMap[] {
	const {
		allResults,
		target,
		size = 5,
		overheadSec = 8,
		medalMultiplier = 1,
		maxFailRate = 0.5,
		maxDurationSec = 150, // Avoid 2.5m+ marathons if specifically farming physical speed
	} = options;

	const ranked = rankMaps(allResults, {
		target,
		overheadSec,
		medalMultiplier,
		maxFailRate,
	});

	const picks: RankedMap[] = [];
	const seenBeatmaps = new Set<number>();

	for (const map of ranked) {
		if (picks.length >= size) break;
		if (seenBeatmaps.has(map.beatmapId)) continue;

		// Filter out long marathons if specifically farming physical speed skills
		const isSpeed = target.kind === 'skill' && (target.skill === 'speed' || target.skill === 'jackspeed');
		if (isSpeed && map.durationSec > maxDurationSec) continue;

		seenBeatmaps.add(map.beatmapId);
		picks.push(map);
	}

	return picks;
}