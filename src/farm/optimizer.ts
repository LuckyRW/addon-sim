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
	minHourlyStrain?: number; // Lower bound (e.g. 0.0m/hr to prevent over-healing)
	maxHourlyStrain?: number; // Upper bound (e.g. 7.5m/hr ceiling)
	maxPlaylistSize?: number; // Maximum maps allowed in the rotation
	overheadSec?: number;
	medalMultiplier?: number;
	maxFailRate?: number;
	maxBurstDurationSec?: number;
};

/**
 * Mathematically finds the playlist combination that maximizes target XP/s
 * subject to: minHourlyStrain <= Hourly Strain Accumulation Rate <= maxHourlyStrain.
 */
export function optimizeSingleSkill(options: OptimizerOptions): OptimizedPlaylist {
	const {
		allResults,
		target,
		minHourlyStrain = 0.0,
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
	// Immune to fatigue penalties in the game engine. Always run the top map solo.
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

	// 3. Filter target candidates by burst length to avoid stamina drag
	const filteredTarget = targetRanked.filter(m => m.durationSec <= maxBurstDurationSec);
	const targetPool = filteredTarget.length > 0 ? filteredTarget : targetRanked;

	const targetBursts = targetPool
		.filter(m => m.fatigue.deltaMinutes > 0)
		.slice(0, 16);

	const targetHealers = targetPool
		.filter(m => m.fatigue.deltaMinutes <= 0)
		.slice(0, 10);

	// 4. External healers across the whole library (capped by duration to avoid marathon drag)
	const allRankedTotal = rankMaps(allResults, {
		target: { kind: 'total' },
		overheadSec,
		medalMultiplier,
		maxFailRate: 0.1,
	});

	const externalHealers = allRankedTotal
		.filter(m => m.durationSec <= maxBurstDurationSec && m.fatigue.deltaMinutes < 0)
		.sort((a, b) => {
			const healSpeedA = Math.abs(a.fatigue.deltaMinutes) / (a.cycleSec || 1);
			const healSpeedB = Math.abs(b.fatigue.deltaMinutes) / (b.cycleSec || 1);
			return healSpeedB - healSpeedA;
		})
		.slice(0, 10);

	// Prioritize intra-skill recovery over external 0-XP charts
	const recoveryPool = [...targetHealers, ...externalHealers];

	// Primary tracking: rotations inside [minHourlyStrain, maxHourlyStrain]
	let bestRotation: RankedMap[] = [];
	let bestXpPerSec = 0;
	let bestHourlyStrain = Infinity;
	let bestNetDelta = 0;
	let bestCycleSec = 0;

	// Sub-optimal fallback: rotations under maxHourlyStrain but below minHourlyStrain (over-healing)
	let overHealRotation: RankedMap[] = [];
	let overHealXpPerSec = 0;
	let overHealHourlyStrain = -Infinity;
	let overHealNetDelta = 0;
	let overHealCycleSec = 0;

	const evaluate = (rotation: RankedMap[]) => {
		if (rotation.length === 0 || rotation.length > maxPlaylistSize) return;

		const totalTime = rotation.reduce((acc, m) => acc + m.cycleSec, 0);
		if (totalTime <= 0) return;

		const totalXp = rotation.reduce((acc, m) => acc + getMapXp(m), 0);
		const totalDelta = rotation.reduce((acc, m) => acc + m.fatigue.deltaMinutes, 0);
		const rate = totalXp / totalTime;
		const hourlyRate = (totalDelta / totalTime) * 3600;

		// Ideal: inside the requested strain window
		if (hourlyRate >= minHourlyStrain && hourlyRate <= maxHourlyStrain) {
			if (rate > bestXpPerSec) {
				bestXpPerSec = rate;
				bestRotation = [...rotation];
				bestHourlyStrain = hourlyRate;
				bestNetDelta = totalDelta;
				bestCycleSec = totalTime;
			}
		} else if (hourlyRate <= maxHourlyStrain) {
			// Below minHourlyStrain: acceptable only if no candidate lands in the target window
			if (rate > overHealXpPerSec) {
				overHealXpPerSec = rate;
				overHealRotation = [...rotation];
				overHealHourlyStrain = hourlyRate;
				overHealNetDelta = totalDelta;
				overHealCycleSec = totalTime;
			}
		}
	};

	// 5. Test candidate maps individually (e.g. low-strain bursts or recovery charts solo)
	for (const map of targetPool.slice(0, 20)) {
		evaluate([map]);
	}

	// 6. Test multi-burst + recovery combinations
	const maxBurstsToTry = Math.min(maxPlaylistSize, targetBursts.length);

	for (let numBursts = 1; numBursts <= maxBurstsToTry; numBursts++) {
		const bursts = targetBursts.slice(0, numBursts);
		const seen = new Set(bursts.map(b => b.beatmapId));

		// Check if bursts alone already satisfy the band
		evaluate(bursts);

		let currentRotation = [...bursts];
		let totalTime = bursts.reduce((acc, m) => acc + m.cycleSec, 0);
		let totalDelta = bursts.reduce((acc, m) => acc + m.fatigue.deltaMinutes, 0);

		for (const healer of recoveryPool) {
			if (seen.has(healer.beatmapId)) continue;
			if (currentRotation.length >= maxPlaylistSize) break;

			seen.add(healer.beatmapId);
			currentRotation.push(healer);
			totalTime += healer.cycleSec;
			totalDelta += healer.fatigue.deltaMinutes;

			evaluate(currentRotation);

			const currentHourlyStrain = totalTime > 0 ? (totalDelta / totalTime) * 3600 : 0;
			// If strain drops below lower bound, adding more healers will only dilute throughput further
			if (currentHourlyStrain < minHourlyStrain) break;
		}
	}

	// 7. Test pairwise combinations of top bursts with individual healers
	for (let i = 0; i < Math.min(targetBursts.length, 6); i++) {
		for (let j = i + 1; j < Math.min(targetBursts.length, 8); j++) {
			for (const healer of recoveryPool.slice(0, 6)) {
				evaluate([targetBursts[i]!, targetBursts[j]!, healer]);
			}
		}
	}

	// 8. Select the winning playlist (prefer target window, then over-heal fallback, then top burst)
	let finalRotation = bestRotation;
	let finalRate = bestXpPerSec;
	let finalHourly = bestHourlyStrain;
	let finalDelta = bestNetDelta;
	let finalCycleSec = bestCycleSec;

	if (finalRotation.length === 0 && overHealRotation.length > 0) {
		finalRotation = overHealRotation;
		finalRate = overHealXpPerSec;
		finalHourly = overHealHourlyStrain;
		finalDelta = overHealNetDelta;
		finalCycleSec = overHealCycleSec;
	}

	if (finalRotation.length === 0) {
		const fallback = [targetPool[0]!];
		const fTime = fallback.reduce((acc, m) => acc + m.cycleSec, 0);
		const fXp = fallback.reduce((acc, m) => acc + getMapXp(m), 0);
		const fDelta = fallback.reduce((acc, m) => acc + m.fatigue.deltaMinutes, 0);

		return {
			expectedXpPerSec: fTime > 0 ? fXp / fTime : 0,
			projectedXpPerSec: fTime > 0 ? fXp / fTime : 0,
			hourlyStrainRate: fTime > 0 ? (fDelta / fTime) * 3600 : 0,
			rotation: fallback,
			netDeltaMinutes: fDelta,
			cycleDurationSec: fTime,
			summary: `Could not satisfy strain window (${minHourlyStrain} to ${maxHourlyStrain}m/hr) with available maps.`,
		};
	}

	// 9. Interleave bursts and healers evenly so strain accumulates and recovers smoothly
	const bursts = finalRotation.filter(m => m.fatigue.deltaMinutes > 0);
	const healers = finalRotation.filter(m => m.fatigue.deltaMinutes <= 0);
	const interleaved: RankedMap[] = [];
	let bIdx = 0;
	let hIdx = 0;

	while (bIdx < bursts.length || hIdx < healers.length) {
		if (bIdx < bursts.length) interleaved.push(bursts[bIdx++]);
		if (hIdx < healers.length) interleaved.push(healers[hIdx++]);
	}

	const burstsCount = interleaved.filter(m => m.fatigue.deltaMinutes > 0).length;
	const healersCount = interleaved.filter(m => m.fatigue.deltaMinutes <= 0).length;
	const strainSign = finalHourly > 0 ? '+' : '';

	return {
		expectedXpPerSec: finalRate,
		projectedXpPerSec: finalRate,
		hourlyStrainRate: finalHourly,
		rotation: interleaved,
		netDeltaMinutes: finalDelta,
		cycleDurationSec: finalCycleSec,
		summary: `Balanced ${burstsCount} burst + ${healersCount} recovery to maintain ${strainSign}${finalHourly.toFixed(1)}m/hr strain (${minHourlyStrain.toFixed(1)} to ${maxHourlyStrain.toFixed(1)}m/hr window).`,
	};
}