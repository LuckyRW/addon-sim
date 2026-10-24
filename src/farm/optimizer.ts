import type { SimResult } from '../engine/protocol.js';
import { rankMaps, type FarmTarget, type RankedMap } from './metrics.js';

export type OptimizationStrategy = 'pure_sprint' | 'in_skill_balanced' | 'zero_strain_rest';

export type OptimizedPlaylist = {
	strategy: OptimizationStrategy;
	strategyLabel: string;
	projectedXpPerSec: number;
	rotation: RankedMap[];
	netDeltaMinutes: number;
	summary: string;
};

export type OptimizerOptions = {
	allResults: readonly SimResult[];
	target: FarmTarget;
	size?: number;
	overheadSec?: number;
	medalMultiplier?: number;
	maxFailRate?: number;
	maxBurstDurationSec?: number;
};

const REST_RATE = 0.4; // Game engine fatigue rest rate per minute

/**
 * Evaluates all farming strategies for a single skill and returns
 * the playlist with the highest projected sustained XP/second.
 */
export function optimizeSingleSkill(options: OptimizerOptions): OptimizedPlaylist {
	const {
		allResults,
		target,
		size = 5,
		overheadSec = 8,
		medalMultiplier = 1,
		maxFailRate = 0.5,
		maxBurstDurationSec = 135,
	} = options;

	const isPhysical = target.kind === 'skill' && ['speed', 'stamina', 'jackspeed'].includes(target.skill);

	// 1. Rank maps for the target skill
	const targetRanked = rankMaps(allResults, {
		target,
		overheadSec,
		medalMultiplier,
		maxFailRate,
	});

	if (targetRanked.length === 0) {
		return {
			strategy: 'pure_sprint',
			strategyLabel: 'No Maps Found',
			projectedXpPerSec: 0,
			rotation: [],
			netDeltaMinutes: 0,
			summary: 'No maps met the clear criteria.',
		};
	}

	// Non-physical skills (Coordination, Accuracy, Reading, Memory, etc.):
	// The game engine never tires them out, so Pure Sprint is mathematically optimal.
	if (!isPhysical) {
		const picks = getUniqueTop(targetRanked, size);
		const rate = calculateAverageRate(picks, overheadSec);
		return {
			strategy: 'pure_sprint',
			strategyLabel: 'Pure Max XP/s',
			projectedXpPerSec: rate,
			rotation: picks,
			netDeltaMinutes: picks.reduce((acc, m) => acc + m.fatigue.deltaMinutes, 0),
			summary: 'Non-physical skill: zero fatigue penalty applies in-game.',
		};
	}

	// --- EVALUATE STRATEGY A: PURE SPRINT (FATIGUE SATURATED) ---
	const burstCandidates = targetRanked.filter(m => m.durationSec <= maxBurstDurationSec);
	const sprintPool = burstCandidates.length >= size ? burstCandidates : targetRanked;
	const sprintPicks = getUniqueTop(sprintPool, size);
	const rawSprintRate = calculateAverageRate(sprintPicks, overheadSec);

	// In full fatigue saturation (>300m strain), skills are debuffed by up to 20%.
	// If baseline accuracy is >= 97%, the bot survives cleanly with ~90% XP yield.
	// If baseline accuracy is low (< 95%), note misses under fatigue heavily reduce XP.
	const avgAcc = sprintPicks.reduce((acc, m) => acc + m.accuracy, 0) / (sprintPicks.length || 1);
	const fatigueMultiplier = avgAcc >= 0.97 ? 0.90 : avgAcc >= 0.95 ? 0.75 : 0.40;
	const projectedSprintRate = rawSprintRate * fatigueMultiplier;

	// --- EVALUATE STRATEGY B: IN-SKILL BALANCED ---
	const inSkillBursts = targetRanked.filter(m => m.fatigue.deltaMinutes > 0 && m.durationSec <= maxBurstDurationSec);
	const inSkillHealers = targetRanked.filter(m => m.fatigue.deltaMinutes < 0);

	let inSkillPicks: RankedMap[] = [];
	let inSkillRate = 0;

	if (inSkillHealers.length > 0 && inSkillBursts.length > 0) {
		inSkillPicks = buildInterleavedBalanced(inSkillBursts, inSkillHealers, size);
		inSkillRate = calculateAverageRate(inSkillPicks, overheadSec);
	}

	// --- EVALUATE STRATEGY C: BURST + ZERO-STRAIN REST FILLERS ---
	// Rank entire library by pure fatigue healing speed (most negative delta per second)
	const allRankedTotal = rankMaps(allResults, {
		target: { kind: 'total' },
		overheadSec,
		medalMultiplier,
		maxFailRate: 0.1,
	});

	// Find the best zero-strain healers (<= 5% physical strain)
	const libraryHealers = allRankedTotal
		.filter(m => m.physicalShare <= 0.05 && m.fatigue.deltaMinutes < 0)
		.sort((a, b) => {
			const healSpeedA = Math.abs(a.fatigue.deltaMinutes) / (a.durationSec + overheadSec);
			const healSpeedB = Math.abs(b.fatigue.deltaMinutes) / (b.durationSec + overheadSec);
			return healSpeedB - healSpeedA;
		});

	let restBlendedPicks: RankedMap[] = [];
	let restBlendedRate = 0;

	if (libraryHealers.length > 0 && burstCandidates.length > 0) {
		const topBurst = burstCandidates[0]!;
		restBlendedPicks = buildRestRotation(topBurst, libraryHealers, size);
		// In Strategy C, rest maps produce 0 target XP, so only burst map XP is counted
		const totalBurstXp = restBlendedPicks
			.filter(m => m.beatmapId === topBurst.beatmapId)
			.reduce((sum, m) => sum + m.value, 0);
		const totalCycleSec = restBlendedPicks.reduce((sum, m) => sum + m.durationSec + overheadSec, 0);
		restBlendedRate = totalCycleSec > 0 ? totalBurstXp / totalCycleSec : 0;
	}

	// --- DECISION MATRIX ---
	if (projectedSprintRate >= inSkillRate && projectedSprintRate >= restBlendedRate) {
		return {
			strategy: 'pure_sprint',
			strategyLabel: 'Pure Sprint (Fatigue Tolerant)',
			projectedXpPerSec: projectedSprintRate,
			rotation: sprintPicks,
			netDeltaMinutes: sprintPicks.reduce((acc, m) => acc + m.fatigue.deltaMinutes, 0),
			summary: `Pure sprint wins (~${projectedSprintRate.toFixed(1)} XP/s). Clearance accuracy (${(avgAcc * 100).toFixed(1)}%) is high enough that fatigue penalty is cheaper than rest dilution.`,
		};
	}

	if (inSkillRate >= restBlendedRate && inSkillPicks.length > 0) {
		return {
			strategy: 'in_skill_balanced',
			strategyLabel: 'In-Skill Balanced',
			projectedXpPerSec: inSkillRate,
			rotation: inSkillPicks,
			netDeltaMinutes: inSkillPicks.reduce((acc, m) => acc + m.fatigue.deltaMinutes, 0),
			summary: `In-Skill Balance wins (~${inSkillRate.toFixed(1)} XP/s). Target skill has low-strain charts that sustain warmup without 0-XP rests.`,
		};
	}

	return {
		strategy: 'zero_strain_rest',
		strategyLabel: 'Burst + Zero-Strain Rest',
		projectedXpPerSec: restBlendedRate,
		rotation: restBlendedPicks,
		netDeltaMinutes: restBlendedPicks.reduce((acc, m) => acc + m.fatigue.deltaMinutes, 0),
		summary: `Rest Interleaving wins (~${restBlendedRate.toFixed(1)} XP/s). High burst difficulty risks failure under fatigue; 0-strain maps clear exhaustion safely.`,
	};
}

function getUniqueTop(ranked: readonly RankedMap[], count: number): RankedMap[] {
	const out: RankedMap[] = [];
	const seen = new Set<number>();
	for (const m of ranked) {
		if (out.length >= count) break;
		if (seen.has(m.beatmapId)) continue;
		seen.add(m.beatmapId);
		out.push(m);
	}
	return out;
}

function calculateAverageRate(picks: readonly RankedMap[], overheadSec: number): number {
	const totalXp = picks.reduce((sum, m) => sum + m.value, 0);
	const totalTime = picks.reduce((sum, m) => sum + m.durationSec + overheadSec, 0);
	return totalTime > 0 ? totalXp / totalTime : 0;
}

function buildInterleavedBalanced(
	bursts: RankedMap[],
	healers: RankedMap[],
	maxSize: number,
): RankedMap[] {
	const bPicks: RankedMap[] = [];
	const hPicks: RankedMap[] = [];
	const seen = new Set<number>();
	let netDelta = 0;

	for (const b of bursts) {
		if (bPicks.length + hPicks.length >= maxSize) break;
		if (seen.has(b.beatmapId)) continue;
		seen.add(b.beatmapId);
		bPicks.push(b);
		netDelta += b.fatigue.deltaMinutes;

		while (netDelta > 0.25 && bPicks.length + hPicks.length < maxSize) {
			const h = healers.find(m => !seen.has(m.beatmapId));
			if (!h) break;
			seen.add(h.beatmapId);
			hPicks.push(h);
			netDelta += h.fatigue.deltaMinutes;
		}
	}

	const result: RankedMap[] = [];
	let bIdx = 0;
	let hIdx = 0;
	while (bIdx < bPicks.length || hIdx < hPicks.length) {
		if (bIdx < bPicks.length) result.push(bPicks[bIdx++]);
		if (hIdx < hPicks.length) result.push(hPicks[hIdx++]);
	}
	return result;
}

function buildRestRotation(
	burst: RankedMap,
	libraryHealers: RankedMap[],
	maxSize: number,
): RankedMap[] {
	const picks: RankedMap[] = [burst];
	let netDelta = burst.fatigue.deltaMinutes;
	const seen = new Set<number>([burst.beatmapId]);

	for (const healer of libraryHealers) {
		if (picks.length >= maxSize || netDelta <= 0.1) break;
		if (seen.has(healer.beatmapId)) continue;
		seen.add(healer.beatmapId);
		picks.push(healer);
		netDelta += healer.fatigue.deltaMinutes;
	}

	return picks;
}