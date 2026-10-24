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
	maxHourlyStrain?: number; // Target limit (e.g. 7.5m/hr)
	maxPlaylistSize?: number;
	overheadSec?: number;
	medalMultiplier?: number;
	maxFailRate?: number;
	maxBurstDurationSec?: number;
};

/**
 * Mathematically finds the playlist combination that maximizes target XP/s
 * subject to: Hourly Strain Accumulation Rate <= maxHourlyStrain (7.5m/hr).
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

	const isPhysical = target.kind === 'skill' && ['speed', 'stamina', 'jackspeed'].includes(target.skill);

	// 1. Rank target skill by XP/s
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

	// 2. Non-physical skills: immune to fatigue penalties in the game engine
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

	// 3. For physical skills: Extract candidate bursts and fastest healers
	const burstsFiltered = targetRanked.filter(m => m.durationSec <= maxBurstDurationSec);
	const candidateBursts = burstsFiltered.length > 0 ? burstsFiltered.slice(0, 8) : targetRanked.slice(0, 8);

	// Search whole library for recovery charts (negative delta, low physical strain)
	const allRankedTotal = rankMaps(allResults, {
		target: { kind: 'total' },
		overheadSec,
		medalMultiplier,
		maxFailRate: 0.1,
	});

	let candidateHealers = allRankedTotal.filter(m => m.physicalShare <= 0.06 && m.fatigue.deltaMinutes < 0);
	if (candidateHealers.length === 0) {
		candidateHealers = allRankedTotal.filter(m => m.fatigue.deltaMinutes < 0);
	}

	candidateHealers.sort((a, b) => {
		const healSpeedA = Math.abs(a.fatigue.deltaMinutes) / (a.cycleSec || 1);
		const healSpeedB = Math.abs(b.fatigue.deltaMinutes) / (b.cycleSec || 1);
		return healSpeedB - healSpeedA;
	});

	// 4. Check if top burst alone already satisfies the constraint
	const topBurst = candidateBursts[0] ?? targetRanked[0]!;
	const soloHourlyStrain = (topBurst.fatigue.deltaMinutes / ((topBurst.cycleSec || 1) / 3600));
	if (soloHourlyStrain <= maxHourlyStrain) {
		return {
			expectedXpPerSec: topBurst.perSecond,
			projectedXpPerSec: topBurst.perSecond,
			hourlyStrainRate: Math.max(0, soloHourlyStrain),
			rotation: [topBurst],
			netDeltaMinutes: topBurst.fatigue.deltaMinutes,
			cycleDurationSec: topBurst.cycleSec,
			summary: `Single top map satisfies <= ${maxHourlyStrain}m/hr strain naturally.`,
		};
	}

	// 5. Pareto Search: Find burst + healer combinations satisfying <= maxHourlyStrain
	let bestRotation: RankedMap[] = [];
	let bestXpPerSec = 0;
	let bestHourlyStrain = Infinity;
	let bestNetDelta = 0;
	let bestCycleSec = 0;

	for (let numBursts = 1; numBursts <= Math.min(2, candidateBursts.length); numBursts++) {
		const bursts = candidateBursts.slice(0, numBursts);
		const seen = new Set(bursts.map(b => b.beatmapId));

		let currentRotation = [...bursts];
		let totalXp = bursts.reduce((acc, b) => acc + b.value, 0);
		let totalTimeSec = bursts.reduce((acc, b) => acc + b.cycleSec, 0);
		let totalDelta = bursts.reduce((acc, b) => acc + b.fatigue.deltaMinutes, 0);

		for (const healer of candidateHealers) {
			if (seen.has(healer.beatmapId)) continue;

			const currentHourlyStrain = totalTimeSec > 0 ? (totalDelta / totalTimeSec) * 3600 : 0;
			if (currentHourlyStrain <= maxHourlyStrain) break;
			if (currentRotation.length >= maxPlaylistSize) break;

			seen.add(healer.beatmapId);
			currentRotation.push(healer);
			totalXp += healer.xp[target.kind === 'skill' ? target.skill : 'speed'] ?? 0;
			totalTimeSec += healer.cycleSec;
			totalDelta += healer.fatigue.deltaMinutes;
		}

		const finalHourlyStrain = totalTimeSec > 0 ? (totalDelta / totalTimeSec) * 3600 : 0;
		const finalRate = totalTimeSec > 0 ? totalXp / totalTimeSec : 0;

		if (finalHourlyStrain <= maxHourlyStrain && finalRate > bestXpPerSec) {
			bestXpPerSec = finalRate;
			bestRotation = currentRotation;
			bestHourlyStrain = finalHourlyStrain;
			bestNetDelta = totalDelta;
			bestCycleSec = totalTimeSec;
		}
	}

	// Fallback if no downloaded maps could bring strain under threshold
	if (bestRotation.length === 0) {
		const fallback = [topBurst, candidateHealers[0]!].filter(Boolean);
		const fTime = fallback.reduce((acc, m) => acc + m.cycleSec, 0);
		const fXp = fallback.reduce((acc, m) => acc + (m.xp[target.kind === 'skill' ? target.skill : 'speed'] ?? 0), 0);
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
			summary: 'Insufficient low-strain maps downloaded to fully reach target strain limit.',
		};
	}

	// Interleave bursts and healers evenly
	const bursts = bestRotation.filter(m => m.fatigue.deltaMinutes > 0);
	const healers = bestRotation.filter(m => m.fatigue.deltaMinutes <= 0);
	const interleaved: RankedMap[] = [];
	let bIdx = 0;
	let hIdx = 0;

	while (bIdx < bursts.length || hIdx < healers.length) {
		if (bIdx < bursts.length) interleaved.push(bursts[bIdx++]);
		if (hIdx < healers.length) interleaved.push(healers[hIdx++]);
	}

	return {
		expectedXpPerSec: bestXpPerSec,
		projectedXpPerSec: bestXpPerSec,
		hourlyStrainRate: bestHourlyStrain,
		rotation: interleaved, // Provided to App.tsx
		netDeltaMinutes: bestNetDelta,
		cycleDurationSec: bestCycleSec,
		summary: `Balanced ${bursts.length} burst + ${healers.length} healer(s) to strictly cap strain at ${bestHourlyStrain.toFixed(1)}m/hr.`,
	};
}