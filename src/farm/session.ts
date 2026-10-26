/**
 * A farming session, play by play.
 *
 * Warm-up and fatigue make a play's worth depend on what came before it: the
 * character tires a minute per strained minute and rests between plays, a cold
 * character plays its physical skills below their level, and a tired one plays
 * them worse still and earns less on them. So a playlist is judged by stepping
 * through a session with the game's own `fatigue.ts`, not by its maps' best
 * plays alone - and the best playlist mixes heavy maps that warm the character
 * with light ones that let it rest, holding it at its peak.
 *
 * A play's worth at a given tiredness comes from the plays simulated at it (see
 * {@link stateMinutes}); between those it is interpolated, and where a play was
 * never simulated tired, it is scaled from its peak by how much the plays that
 * were lost at that tiredness ({@link coldCurve}).
 */

import {
	afterPlay,
	fatigueLevel,
	restedFatigue,
	warmup,
	warmupBar,
	warmupCurve,
	type Fatigue,
} from '@oss-idle/shared/fatigue';
import type { SimResult } from '../engine/protocol.js';
import {
	playKey,
	RECENT_LIMIT,
	serverXp,
	targetValue,
	type FarmTarget,
	type RankedMap,
} from './metrics.js';

/** fatigue.ts's STRAIN_CAP: fatigue stops counting here, every curve ended. */
export const STRAIN_CAP = 7 * 60;

/** The fatigue minutes where a character with `gear` stamina upgrades is at its peak: warm, not tired. */
export const peakMinutes = (gear: number): number => warmupCurve(gear).warm;

const atPeak = (minutes: number, gear: number) => fatigueLevel(minutes) === 0 && warmup(minutes, gear) >= 1;

/**
 * The tiredness plays are simulated at, off the peak: three points warming up,
 * and points along the cool-down and into fatigue.
 */
export const stateMinutes = (gear: number): number[] => {
	const { warm, peakEnd, half, cold } = warmupCurve(gear);
	return [0, warm / 3, (2 * warm) / 3, (peakEnd + half) / 2, half, cold, (cold + STRAIN_CAP) / 2, STRAIN_CAP]
		.filter((m, i, all) => all.indexOf(m) === i && !atPeak(m, gear));
};

/** What a play is worth at some tiredness: the fields a session reads. */
type PlayAt = Pick<SimResult, 'xp' | 'pp' | 'durationSec' | 'lengthMin' | 'strained' | 'failRate'>;

const mix = (a: PlayAt, b: PlayAt, t: number): PlayAt => {
	const xp: Record<string, number> = {};
	for (const skill of new Set([...Object.keys(a.xp), ...Object.keys(b.xp)])) {
		xp[skill] = (a.xp[skill] ?? 0) * (1 - t) + (b.xp[skill] ?? 0) * t;
	}
	const lin = (k: 'pp' | 'durationSec' | 'lengthMin' | 'strained' | 'failRate') => a[k] * (1 - t) + b[k] * t;
	return {
		xp, pp: lin('pp'), durationSec: lin('durationSec'), lengthMin: lin('lengthMin'),
		strained: lin('strained'), failRate: lin('failRate'),
	};
};

/** Piecewise-linear over points sorted by minutes, flat past the ends. */
const along = <T>(points: readonly { minutes: number; at: T }[], minutes: number, lerpAt: (a: T, b: T, t: number) => T): T => {
	const i = points.findIndex(p => p.minutes >= minutes);
	if (i === 0) return points[0]!.at;
	if (i < 0) return points.at(-1)!.at;
	const lo = points[i - 1]!;
	const hi = points[i]!;
	return lerpAt(lo.at, hi.at, (minutes - lo.minutes) / (hi.minutes - lo.minutes || 1));
};

/** How a play's XP scales off its peak at each tiredness: skill by skill, `duration` its wall-clock cost. */
type Ratios = Record<string, number>;

/**
 * How much of their peak XP the simulated plays keep at each tiredness, pooled
 * over every play simulated both at its peak and tired.
 */
export const coldCurve = (
	states: readonly SimResult[],
	peaks: ReadonlyMap<string, SimResult>,
	gear: number,
): ((minutes: number) => Ratios) => {
	const sums = new Map<number, { tired: Ratios; peak: Ratios }>();
	for (const state of states) {
		const peak = peaks.get(playKey(state));
		if (!peak) continue;
		const sum = sums.get(state.minutes) ?? { tired: {}, peak: {} };
		sums.set(state.minutes, sum);
		const add = (into: Ratios, xp: Record<string, number>, duration: number) => {
			for (const [skill, value] of Object.entries(xp)) into[skill] = (into[skill] ?? 0) + value;
			into.duration = (into.duration ?? 0) + duration;
		};
		add(sum.tired, state.xp, state.durationSec);
		add(sum.peak, peak.xp, peak.durationSec);
	}
	const { warm, peakEnd } = warmupCurve(gear);
	const points = [...sums].map(([minutes, { tired, peak }]) => ({
		minutes,
		at: Object.fromEntries(Object.keys(peak).map(k => [k, peak[k]! > 0 ? (tired[k] ?? 0) / peak[k]! : 1])),
	}));
	points.push({ minutes: warm, at: {} }, { minutes: peakEnd, at: {} });
	points.sort((a, b) => a.minutes - b.minutes);
	return minutes => along(points, minutes, (a, b, t) => {
		const out: Ratios = {};
		for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out[k] = (a[k] ?? 1) * (1 - t) + (b[k] ?? 1) * t;
		return out;
	});
};

/** A play's worth at `minutes` of fatigue. */
export type Lookup = (play: SimResult, minutes: number) => PlayAt;

/**
 * Look plays up from what was simulated: their peak results (`play` itself)
 * and `states`, the same plays simulated tired.
 */
export const stateLookup = (states: readonly SimResult[], gear: number, curve: (minutes: number) => Ratios): Lookup => {
	const byPlay = new Map<string, SimResult[]>();
	for (const state of states) {
		const key = playKey(state);
		byPlay.set(key, [...byPlay.get(key) ?? [], state]);
	}
	const { warm, peakEnd } = warmupCurve(gear);
	return (play, minutes) => {
		if (atPeak(minutes, gear)) return play;
		const points = [
			...(byPlay.get(playKey(play)) ?? []).map(state => ({ minutes: state.minutes, at: state as PlayAt })),
			{ minutes: warm, at: play as PlayAt },
			{ minutes: peakEnd, at: play as PlayAt },
		].sort((a, b) => a.minutes - b.minutes);
		// simulated on both sides: interpolate; otherwise scale the peak
		if (points[0]!.minutes <= minutes && points.at(-1)!.minutes >= minutes) return along(points, minutes, mix);
		const ratios = curve(minutes);
		const xp = Object.fromEntries(Object.entries(play.xp).map(([skill, value]) => [skill, value * (ratios[skill] ?? 1)]));
		return { ...play, xp, durationSec: play.durationSec * (ratios.duration ?? 1) };
	};
};

export type SessionOptions = {
	target: FarmTarget;
	lookup: Lookup;
	sessionSec: number;
	/** Fatigue minutes at the start. */
	startMinutes: number;
	delaySec: number;
	/** Stamina upgrades, which warm the character faster and hold its peak longer. */
	gear: number;
	medals: number;
	/** Plays of each map in the last 24h before the session. */
	recentPlays: ReadonlyMap<number, number>;
};

export type Forecast = {
	/** Target value over the session. */
	total: number;
	perHour: number;
	plays: number;
	/** After each play: seconds into the session and the warm-up bar, 0 cold to 1 exhausted. */
	samples: { at: number; bar: number }[];
	/** Seconds into the session the character first plays at its peak, if it does. */
	peakAt?: number;
};

/** Step through a session looping `rotation`, as the server would play it. */
export const forecast = (rotation: readonly RankedMap[], o: SessionOptions): Forecast => {
	const out: Forecast = { total: 0, perHour: 0, plays: 0, samples: [] };
	if (!rotation.length || o.target.kind === 'pp') return out;
	// the server counts a map's plays among the character's last RECENT_LIMIT
	const recent: number[] = [...o.recentPlays].flatMap(([id, n]) => Array<number>(n).fill(id)).slice(-RECENT_LIMIT);
	let fatigue: Fatigue = { at: 0, minutes: o.startMinutes };
	let t = 0;
	out.samples.push({ at: 0, bar: warmupBar(o.startMinutes, o.gear) });
	for (let i = 0; t < o.sessionSec; i++) {
		const play = rotation[i % rotation.length]!;
		const minutes = restedFatigue(fatigue, t * 1000);
		if (out.peakAt === undefined && atPeak(minutes, o.gear)) out.peakAt = t;
		const at = o.lookup(play, minutes);
		const xp = serverXp(at.xp, {
			recentPlays: recent.filter(id => id === play.beatmapId).length,
			fatigue: fatigueLevel(minutes),
			medals: o.medals,
			mods: play.mods,
		});
		out.total += targetValue(xp, o.target, at.pp);
		out.plays++;
		t += at.durationSec;
		fatigue = afterPlay(fatigue, at.lengthMin, at.strained, t * 1000);
		out.samples.push({ at: t, bar: warmupBar(fatigue.minutes, o.gear) });
		recent.push(play.beatmapId);
		if (recent.length > RECENT_LIMIT) recent.shift();
		t += o.delaySec;
	}
	out.perHour = out.total / (o.sessionSec / 3600);
	return out;
};

export type RotationOptions = SessionOptions & {
	size: number;
	/** Plays the player put in by hand: kept whatever the search finds. */
	pinned?: readonly string[];
	/** Difficulties the player took out. */
	excluded?: ReadonlySet<number>;
	oneMapPerSet?: boolean;
};

/** How many of the ranking's best plays the search considers, and how many light ones besides. */
const CANDIDATES = 40;
const LIGHT_CANDIDATES = 15;
/** A play that strains under this share of its length lets the character rest. */
const LIGHT = 0.5;

/**
 * Pick the playlist that earns the most over the session.
 *
 * Starts from the best plays at peak, then swaps entries for candidates while
 * the session's forecast improves - which is what brings light maps in to hold
 * the character at its peak. For a pp target, simply the best pp plays.
 * Each difficulty at most once: mindblock counts its plays at every rate.
 */
export const buildRotation = (ranked: readonly RankedMap[], o: RotationOptions): RankedMap[] => {
	const pinned = ranked.filter(map => o.pinned?.includes(playKey(map)));
	const allowed = ranked.filter(map => !o.excluded?.has(map.beatmapId));
	const fits = (map: RankedMap, rotation: readonly RankedMap[]) =>
		!rotation.some(other => other.beatmapId === map.beatmapId || (o.oneMapPerSet && other.setId === map.setId));

	const rotation = [...pinned];
	for (const map of allowed) {
		if (rotation.length >= o.size) break;
		if (fits(map, rotation)) rotation.push(map);
	}
	if (o.target.kind === 'pp' || rotation.length === pinned.length) return rotation;

	const candidates = [
		...allowed.slice(0, CANDIDATES),
		...allowed.filter(map => map.strained < LIGHT * map.lengthMin).slice(0, LIGHT_CANDIDATES),
	];
	let best = forecast(rotation, o).total;
	for (let pass = 0, improved = true; pass < 4 && improved; pass++) {
		improved = false;
		for (let slot = pinned.length; slot < rotation.length; slot++) {
			for (const candidate of candidates) {
				const others = rotation.filter((_, i) => i !== slot);
				if (!fits(candidate, others)) continue;
				const trial = [...rotation];
				trial[slot] = candidate;
				const total = forecast(trial, o).total;
				if (total > best * 1.001) {
					best = total;
					rotation[slot] = candidate;
					improved = true;
				}
			}
		}
	}
	return rotation;
};
