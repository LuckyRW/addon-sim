import type { SimResult } from '../engine/protocol.js';
import { PHYSICAL_SKILLS, rankMaps, type FarmTarget, type RankedMap } from './metrics.js';

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
	minHourlyStrain?: number; // Lower bound (e.g. -4.5m/hr)
	maxHourlyStrain?: number; // Upper bound (e.g. 7.5m/hr or 11.0m/hr)
	maxPlaylistSize?: number; // Upper bound on playlist entries
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
		minHourlyStrain = -4.5,
		maxHourlyStrain = 11.0,
		maxPlaylistSize = 8,
		overheadSec = 8,
		medalMultiplier = 1,
		maxFailRate = 0.5,
		maxBurstDurationSec = 135,
	} = options;

	// Total XP and all physical skills (speed, stamina, jackspeed, coordination)
	// accumulate fatigue and must be balanced.
	const isPhysical =
		target.kind === 'total' ||
		(target.kind === 'skill' && PHYSICAL_SKILLS.has(target.skill));

	// Helper to extract target XP earned from any map (m.value already accounts for medals and mindblock)
	const getMapXp = (m: RankedMap): number => {
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

	// 2. Non-physical skills (Accuracy, Reading, Memory, etc.):
	// Immune to fatigue penalties in the game engine. Always run the top map solo.
	if (!isPhysical) {
		const bestMap = targetRanked[0]!;
		const fTime = bestMap.cycleSec;
		const fDelta = bestMap.fatigue.deltaMinutes;
		const actualStrain = fTime > 0 ? (fDelta / fTime) * 3600 : 0;

		return {
			expectedXpPerSec: bestMap.perSecond,
			projectedXpPerSec: bestMap.perSecond,
			hourlyStrainRate: actualStrain,
			rotation: [bestMap],
			netDeltaMinutes: fDelta,
			cycleDurationSec: fTime,
			summary: 'Non-physical target skill: rotation selected purely by XP/s.',
		};
	}

	// 3. Separate candidate pool:
	// Bursts: High XP/s short maps (<= maxBurstDurationSec) with positive strain accumulation
	const targetBursts = targetRanked
		.filter(m => m.durationSec <= maxBurstDurationSec && m.fatigue.deltaMinutes > 0)
		.slice(0, 12);

	// Intra-skill healers: Maps in target skill that shed fatigue (deltaMinutes <= 0)
	// Do NOT cap duration here — long LN/light recovery charts often give massive target XP
	const targetHealers = targetRanked
		.filter(m => m.fatigue.deltaMinutes <= 0)
		.slice(0, 10);

	// 4. External healers across the entire library (ranked under the chosen target)
	// This ensures m.value is always measured in target XP with medal multiplier applied
	const allRankedTarget = rankMaps(allResults, {
		target,
		overheadSec,
		medalMultiplier,
		maxFailRate: 0.1,
	});

	const externalHealers = allRankedTarget
		.filter(m => m.fatigue.deltaMinutes < 0)
		.sort((a, b) => {
			const healSpeedA = Math.abs(a.fatigue.deltaMinutes) / (a.cycleSec || 1);
			const healSpeedB = Math.abs(b.fatigue.deltaMinutes) / (b.cycleSec || 1);
			return healSpeedB - healSpeedA;
		})
		.slice(0, 10);

	// Prioritize intra-skill recovery over external charts
	const recoveryPool = [...targetHealers, ...externalHealers];

	// Cap rotation size to keep farming cycles tight (defaulting to max 8)
	const effectiveMaxSize = Math.min(8, Math.max(2, maxPlaylistSize));

	// Primary tracking: rotations inside [minHourlyStrain, maxHourlyStrain]
	let bestRotation: RankedMap[] = [];
	let bestXpPerSec = 0;
	let bestHourlyStrain = Infinity;
	let bestNetDelta = 0;
	let bestCycleSec = 0;

	// Fallback tracking: rotations under maxHourlyStrain but below minHourlyStrain (over-healing)
	let overHealRotation: RankedMap[] = [];
	let overHealXpPerSec = 0;
	let overHealHourlyStrain = -Infinity;
	let overHealNetDelta = 0;
	let overHealCycleSec = 0;

	const evaluate = (rotation: RankedMap[]) => {
		if (rotation.length === 0 || rotation.length > effectiveMaxSize) return;

		const totalTime = rotation.reduce((acc, m) => acc + m.cycleSec, 0);
		if (totalTime <= 0) return;

		const totalXp = rotation.reduce((acc, m) => acc + getMapXp(m), 0);
		const totalDelta = rotation.reduce((acc, m) => acc + m.fatigue.deltaMinutes, 0);
		const rate = totalXp / totalTime;
		const hourlyRate = (totalDelta / totalTime) * 3600;

		// Ideal: inside target strain window
		if (hourlyRate >= minHourlyStrain && hourlyRate <= maxHourlyStrain) {
			if (rate > bestXpPerSec) {
				bestXpPerSec = rate;
				bestRotation = [...rotation];
				bestHourlyStrain = hourlyRate;
				bestNetDelta = totalDelta;
				bestCycleSec = totalTime;
			}
		} else if (hourlyRate <= maxHourlyStrain) {
			// Over-healing fallback (only used if nothing fits inside the window)
			if (rate > overHealXpPerSec) {
				overHealXpPerSec = rate;
				overHealRotation = [...rotation];
				overHealHourlyStrain = hourlyRate;
				overHealNetDelta = totalDelta;
				overHealCycleSec = totalTime;
			}
		}
	};

	// 5. Test individual candidate maps (e.g. low-strain bursts or recovery charts solo)
	for (const map of targetRanked.slice(0, 10)) {
		evaluate([map]);
	}

	// 6. Test Multi-Burst + Recovery combinations (pack 1..5 bursts with 0..2 recovery maps)
	const maxBursts = Math.min(5, targetBursts.length);

	for (let bCount = 1; bCount <= maxBursts; bCount++) {
		const bursts = targetBursts.slice(0, bCount);

		// Test burst subset alone
		evaluate(bursts);

		// Test with 1 recovery map
		for (const h1 of recoveryPool) {
			const r1 = [...bursts, h1];
			evaluate(r1);

			// Test with 2 recovery maps
			if (r1.length < effectiveMaxSize) {
				for (const h2 of recoveryPool) {
					if (h1.beatmapId === h2.beatmapId) continue;
					evaluate([...r1, h2]);
				}
			}
		}
	}

	// 7. Test combinations of top bursts with individual healers
	for (let i = 0; i < Math.min(targetBursts.length, 6); i++) {
		for (let j = i + 1; j < Math.min(targetBursts.length, 8); j++) {
			for (const healer of recoveryPool.slice(0, 6)) {
				evaluate([targetBursts[i]!, targetBursts[j]!, healer]);
			}
		}
	}

	// 8. Select winning rotation
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
		const fallback = [targetBursts[0] ?? targetRanked[0]!];
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