import type { SimResult } from '../engine/protocol.js';
import { rankMaps, type FarmTarget, type RankedMap } from './metrics.js';

export type OptimizedPlaylist = {
	expectedXpPerSec: number;
	projectedXpPerSec: number;
	hourlyStrainRate: number;
	rotation: RankedMap[];
	netDeltaMinutes: number;
	cycleDurationSec: number;
	summary: string;
};

export type OptimizerOptions = {
	allResults: readonly SimResult[];
	target: FarmTarget;
	maxHourlyStrain?: number; // Target hourly limit in minutes of fatigue gain per hour
	maxPlaylistSize?: number; // Upper bound on playlist entries
	overheadSec?: number;
	medalMultiplier?: number;
	maxFailRate?: number;
	maxBurstDurationSec?: number;
};

/**
 * Mathematically finds the playlist combination that maximizes target XP/s
 * subject to: Hourly Strain Accumulation Rate <= maxHourlyStrain (e.g. 7.5m/hr).
 */
export function optimizeSingleSkill(options: OptimizerOptions): OptimizedPlaylist {
	const {
		allResults,
		target,
		maxHourlyStrain = 7.5,
		maxPlaylistSize = 6,
		overheadSec = 8,
		medalMultiplier = 1,
		maxFailRate = 0.5,
		maxBurstDurationSec = 135,
	} = options;

	const targetSkillKey = target.kind === 'skill' ? target.skill : 'speed';
	const isPhysical = target.kind === 'skill' && ['speed', 'stamina', 'jackspeed'].includes(target.skill);

	// Helper to extract target XP earned from any map
	const getMapXp = (m: RankedMap): number => {
		if (target.kind === 'skill') {
			return m.xp?.[targetSkillKey] ?? 0;
		}
		return m.value ?? 0;
	};

	// 1. Rank target skill maps by XP/s
	const targetRanked = rankMaps(allResults, {
		target,
		overheadSec,
		medalMultiplier,
		maxFailRate,
	});

	if (targetRanked.length === 0) {
		return {
			expectedXpPerSec: 0,
			projectedXpPerSec: 0,
			hourlyStrainRate: 0,
			rotation: [],
			netDeltaMinutes: 0,
			cycleDurationSec: 0,
			summary: 'No maps met clear criteria.',
		};
	}

	// 2. Non-physical skills (Accuracy, Coordination, Reading, Memory):
	// Immune to fatigue penalties in the game engine. Always run the top map.
	if (!isPhysical) {
		const bestMap = targetRanked[0]!;
		return {
			expectedXpPerSec: bestMap.perSecond,
			projectedXpPerSec: bestMap.perSecond,
			hourlyStrainRate: 0,
			rotation: [bestMap],
			netDeltaMinutes: 0,
			cycleDurationSec: bestMap.cycleSec,
			summary: 'Non-physical skill: immune to fatigue penalties.',
		};
	}

	// 3. Candidate pool from target skill (capped at maxBurstDurationSec to avoid stamina drag)
	const filteredCandidates = targetRanked.filter(m => m.durationSec <= maxBurstDurationSec);
	const candidates = (filteredCandidates.length > 0 ? filteredCandidates : targetRanked).slice(0, 16);

	let bestRotation: RankedMap[] = [];
	let bestXpPerSec = 0;
	let bestHourlyStrain = Infinity;
	let bestNetDelta = 0;
	let bestCycleSec = 0;

	// Evaluator function to check candidate playlist rotations
	const evaluate = (rotation: RankedMap[]) => {
		if (rotation.length === 0 || rotation.length > maxPlaylistSize) return;

		const totalTime = rotation.reduce((acc, m) => acc + m.cycleSec, 0);
		if (totalTime <= 0) return;

		const totalXp = rotation.reduce((acc, m) => acc + getMapXp(m), 0);
		const totalDelta = rotation.reduce((acc, m) => acc + m.fatigue.deltaMinutes, 0);
		const rate = totalXp / totalTime;
		const hourlyRate = (totalDelta / totalTime) * 3600;

		// Check if it satisfies the strain constraint and beats our best XP/s
		if (hourlyRate <= maxHourlyStrain && rate > bestXpPerSec) {
			bestXpPerSec = rate;
			bestRotation = [...rotation];
			bestHourlyStrain = hourlyRate;
			bestNetDelta = totalDelta;
			bestCycleSec = totalTime;
		}
	};

	// 4. Test EVERY candidate map in target skill individually (e.g. Map #4 or Map #8 solo)
	for (const map of candidates) {
		evaluate([map]);
	}

	// 5. Test 2-map combinations within target skill (e.g. Map #1 + Map #8)
	for (let i = 0; i < candidates.length; i++) {
		for (let j = i + 1; j < candidates.length; j++) {
			evaluate([candidates[i]!, candidates[j]!]);
		}
	}

	// 6. Test 3-map combinations within target skill
	for (let i = 0; i < Math.min(candidates.length, 6); i++) {
		for (let j = i + 1; j < Math.min(candidates.length, 8); j++) {
			for (let k = j + 1; k < Math.min(candidates.length, 12); k++) {
				evaluate([candidates[i]!, candidates[j]!, candidates[k]!]);
			}
		}
	}

	// 7. If target maps alone cannot meet the threshold, test pairing top bursts with external healers
	const allRankedTotal = rankMaps(allResults, {
		target: { kind: 'total' },
		overheadSec,
		medalMultiplier,
		maxFailRate: 0.1,
	});

	// External healers: charts from entire library with negative delta, sorted by fastest recovery/sec
	const externalHealers = allRankedTotal
		.filter(m => m.fatigue.deltaMinutes < 0)
		.sort((a, b) => {
			const healA = Math.abs(a.fatigue.deltaMinutes) / (a.cycleSec || 1);
			const healB = Math.abs(b.fatigue.deltaMinutes) / (b.cycleSec || 1);
			return healB - healA;
		})
		.slice(0, 8);

	// Try pairing top 4 bursts with external healers
	for (const burst of candidates.slice(0, 4)) {
		let current = [burst];
		const seen = new Set([burst.beatmapId]);

		for (const healer of externalHealers) {
			if (seen.has(healer.beatmapId)) continue;
			seen.add(healer.beatmapId);
			current.push(healer);

			evaluate(current);
			if (current.length >= maxPlaylistSize) break;
		}
	}

	// 8. Fallback if no downloaded maps could satisfy <= maxHourlyStrain
	if (bestRotation.length === 0) {
		const fallback = [candidates[0] ?? targetRanked[0]!];
		const fTime = fallback.reduce((acc, m) => acc + m.cycleSec, 0);
		const fXp = fallback.reduce((acc, m) => acc + getMapXp(m), 0);
		const fDelta = fallback.reduce((acc, m) => acc + m.fatigue.deltaMinutes, 0);
		const fallbackStrain = fTime > 0 ? (fDelta / fTime) * 3600 : 0;
		const fallbackRate = fTime > 0 ? fXp / fTime : 0;

		return {
			expectedXpPerSec: fallbackRate,
			projectedXpPerSec: fallbackRate,
			hourlyStrainRate: fallbackStrain,
			rotation: fallback,
			netDeltaMinutes: fDelta,
			cycleDurationSec: fTime,
			summary: `Could not satisfy strain limit (<= ${maxHourlyStrain}m/hr) with available maps.`,
		};
	}

	// 9. Interleave bursts and recovery maps evenly for smooth fatigue curves
	const bursts = bestRotation.filter(m => m.fatigue.deltaMinutes > 0);
	const healers = bestRotation.filter(m => m.fatigue.deltaMinutes <= 0);
	const interleaved: RankedMap[] = [];
	let bIdx = 0;
	let hIdx = 0;

	while (bIdx < bursts.length || hIdx < healers.length) {
		if (bIdx < bursts.length) interleaved.push(bursts[bIdx++]);
		if (hIdx < healers.length) interleaved.push(healers[hIdx++]);
	}

	const burstsCount = interleaved.filter(m => m.fatigue.deltaMinutes > 0).length;
	const healersCount = interleaved.filter(m => m.fatigue.deltaMinutes <= 0).length;

	return {
		expectedXpPerSec: bestXpPerSec,
		projectedXpPerSec: bestXpPerSec,
		hourlyStrainRate: bestHourlyStrain,
		rotation: interleaved,
		netDeltaMinutes: bestNetDelta,
		cycleDurationSec: bestCycleSec,
		summary: `Optimized rotation of ${interleaved.length} map(s) (${burstsCount} burst, ${healersCount} recovery) yielding ${bestXpPerSec.toFixed(1)} XP/s at ${bestHourlyStrain.toFixed(1)}m/hr strain.`,
	};
}