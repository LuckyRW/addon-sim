/**
 * A farming session, play by play.
 *
 * Warm-up and fatigue make a play's worth depend on what came before it: the
 * character tires on strained plays and rests on light ones and between plays, a cold
 * character plays its physical skills below their level, and a tired one plays
 * them worse still and earns less on them. So a playlist is judged by stepping
 * through a session with the game's own `fatigue.ts`, not by its maps' best
 * plays alone - and the best playlist mixes heavy maps that warm the character
 * with light ones that let it rest, holding it at its peak.
 *
 * Nothing pulls the character back to its peak: a loop that strains a little
 * more than it rests drifts a little further every time round, and past the
 * peak its skills strain more and drift faster. So a playlist is built to hold
 * the middle of the peak for {@link HOLD_HOURS} hours, starting there.
 *
 * A play's worth at a given tiredness comes from the plays simulated at it (see
 * {@link stateMinutes}); between those it is interpolated, and where a play was
 * never simulated tired, it is scaled from its peak by how much the plays that
 * were lost at that tiredness ({@link coldCurve}).
 */

import {
	afterPlay,
	BAR_ZONES,
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
	sessionValue,
	xpValue,
	type FarmTarget,
	type RankedMap,
} from './metrics.js';

/** fatigue.ts's STRAIN_CAP: fatigue stops counting here, every curve ended. */
export const STRAIN_CAP = 7 * 60;

/** The fatigue minutes where a character with `gear` stamina upgrades is at its peak: warm, not tired. */
export const peakMinutes = (gear: number): number => warmupCurve(gear).warm;

/** How long a playlist has to hold the peak, AFK. */
export const HOLD_HOURS = 168;
/** The middle of the warm-up bar's peak zone, where a playlist starts and has to stay. */
export const PEAK_MIDDLE = (BAR_ZONES[0] + BAR_ZONES[1]) / 2;
/** How far off {@link PEAK_MIDDLE} the bar may stray over {@link HOLD_HOURS}: half of the way to the zone's edges. */
export const HOLD_BAND = (BAR_ZONES[1] - BAR_ZONES[0]) / 4;
/** The same for a steady playlist: the bar all but flat. */
export const STEADY_BAND = HOLD_BAND / 4;
/** How long a warm-up playlist is forecast for, from rested. */
export const WARMUP_HOURS = 4;

/** The fatigue minutes at the middle of the peak zone. */
export const midPeakMinutes = (gear: number): number => {
	let lo = 0;
	let hi = STRAIN_CAP;
	for (let i = 0; i < 30; i++) {
		const mid = (lo + hi) / 2;
		if (warmupBar(mid, gear) < PEAK_MIDDLE) lo = mid;
		else hi = mid;
	}
	return hi;
};

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
 *
 * "Peak" is wherever the main plays were simulated - the warm-up peak unless a
 * scan was set to another fatigue - so ratios are 1 there, and anywhere else on
 * the peak a state was simulated at stands for the whole peak.
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
		at: Object.fromEntries(Object.keys(peak).map(k => [k, peak[k]! > 0 ? (tired[k] ?? 0) / peak[k]! : 1])) as Ratios,
	}));
	const base = baseMinutes(peaks.values(), gear);
	if (base === undefined) {
		points.push({ minutes: warm, at: {} }, { minutes: peakEnd, at: {} });
	} else {
		// main plays off the peak: 1 where they were played, the peak as a state simulated on it says
		points.push({ minutes: base, at: {} });
		const onPeak = points.find(point => atPeak(point.minutes, gear));
		if (onPeak) points.push({ minutes: warm, at: onPeak.at }, { minutes: peakEnd, at: onPeak.at });
	}
	points.sort((a, b) => a.minutes - b.minutes);
	return minutes => along(points, minutes, (a, b, t) => {
		const out: Ratios = {};
		for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out[k] = (a[k] ?? 1) * (1 - t) + (b[k] ?? 1) * t;
		return out;
	});
};

/** Where the main plays were simulated, when that is not the warm-up peak: a scan set to another fatigue. */
const baseMinutes = (plays: Iterable<SimResult>, gear: number): number | undefined => {
	for (const play of plays) return atPeak(play.minutes, gear) ? undefined : play.minutes;
	return undefined;
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
	const pointsOf = new Map<SimResult, { minutes: number; at: PlayAt }[]>();
	return (play, minutes) => {
		const onPeak = atPeak(play.minutes, gear);
		if (onPeak ? atPeak(minutes, gear) : minutes === play.minutes) return play;
		let points = pointsOf.get(play);
		if (!points) {
			points = [
				...(byPlay.get(playKey(play)) ?? []).map(state => ({ minutes: state.minutes, at: state as PlayAt })),
				// a play simulated off the peak stands at its own fatigue
				...(onPeak
					? [{ minutes: warm, at: play as PlayAt }, { minutes: peakEnd, at: play as PlayAt }]
					: [{ minutes: play.minutes, at: play as PlayAt }]),
			].sort((a, b) => a.minutes - b.minutes);
			pointsOf.set(play, points);
		}
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
	/** Target value over the session (using weighted multipliers when target is 'skills'). */
	total: number;
	perHour: number;
	/** Weighted XP per hour, balanced or not: what the playlist shows. */
	xpPerHour?: number;
	plays: number;
	/** After each play: seconds into the session and the warm-up bar, 0 cold to 1 exhausted. */
	samples: { at: number; bar: number }[];
	/** The furthest the bar strays from {@link PEAK_MIDDLE}. */
	drift: number;
	/** How far the bar is from {@link PEAK_MIDDLE} on average. */
	stray: number;
	/** Seconds into the session the bar first leaves the peak zone, if it does. */
	leavesAt?: number;
	/** Seconds into the session the bar first reaches {@link PEAK_MIDDLE}, if it does. */
	warmAt?: number;
	/** XP earned over the session by skill, when asked for. */
	bySkill?: Record<string, number>;
	/** Net fatigue drift in minutes generated per one complete loop. */
	netLoopDriftMin?: number;
	/** Exact wall-clock seconds for one complete loop. */
	loopDurationSec?: number;
};

/** A play at some tiredness and mindblock: what it earns and how it moves fatigue. */
type Step = { xp: Record<string, number>; durationSec: number; lengthMin: number; strained: number; pp: number };
const steps = new WeakMap<SessionOptions, Map<SimResult, Map<number, Step>>>();
const bars = new Map<number, Map<number, number>>();
const barAt = (minutes: number, gear: number): number => {
	let byMinutes = bars.get(gear);
	if (!byMinutes) bars.set(gear, byMinutes = new Map());
	const key = Math.round(minutes * 100);
	let bar = byMinutes.get(key);
	if (bar === undefined) byMinutes.set(key, bar = warmupBar(key / 100, gear));
	return bar;
};

/**
 * Calculates the percentage of drain time spent in strain (strained / lengthMin).
 * Over 40% (0.40) receives full strain credit in game fatigue mechanics.
 */
export const strainRatioOf = (
	map: RankedMap,
	o: SessionOptions,
	minutes = o.startMinutes,
): number => {
	const at = o.lookup(map, minutes);
	if (!at.lengthMin || at.lengthMin <= 0) return 0;
	return Math.min(1, Math.max(0, at.strained / at.lengthMin));
};

/**
 * Accurately steps one play and its autopilot delay through the game's actual fatigue engine
 * (afterPlay + restedFatigue decay), returning the exact net change in fatigue minutes.
 */
export const driftOf = (map: RankedMap, o: SessionOptions, minutes = o.startMinutes): number => {
	const at = o.lookup(map, minutes);
	let f: Fatigue = { at: 0, minutes };
	// 1. Accumulate fatigue from strained play and rest unstrained parts
	f = afterPlay(f, at.lengthMin, at.strained, at.durationSec * 1000);
	// 2. Rest through autopilot delay using actual game decay curve
	const endMinutes = restedFatigue(f, (at.durationSec + o.delaySec) * 1000);
	return endMinutes - minutes;
};

/** Calculate the exact wall-clock seconds before the rotation leaves the warm-up peak without a 24h clamp. */
export const exactDepartureTime = (
	rotation: readonly RankedMap[],
	o: SessionOptions,
): number | undefined => {
	if (!rotation.length) return undefined;

	const loopSec = rotation.reduce((sum, map) => sum + map.durationSec + o.delaySec, 0);
	const loopDrift = rotation.reduce((sum, map) => sum + driftOf(map, o), 0);

	if (Math.abs(loopDrift) < 1e-5) return Infinity; // Perfectly balanced loop

	const currentBar = barAt(o.startMinutes, o.gear);
	const targetBar = loopDrift > 0 ? BAR_ZONES[1] : BAR_ZONES[0];

	// Find the fatigue minute threshold that crosses targetBar
	let targetMinute = o.startMinutes;
	for (let m = 0; m <= STRAIN_CAP; m += 0.05) {
		const b = barAt(m, o.gear);
		if ((loopDrift > 0 && b >= targetBar) || (loopDrift < 0 && b <= targetBar)) {
			targetMinute = m;
			break;
		}
	}

	const deltaMin = Math.abs(targetMinute - o.startMinutes);
	const loops = deltaMin / Math.abs(loopDrift);
	return Math.round(loops * loopSec);
};

/** Step through a session looping `rotation`, as the server would play it; `bySkill` also totals each skill's XP. */
export const forecast = (rotation: readonly RankedMap[], o: SessionOptions, bySkill = false): Forecast => {
	const out: Forecast = { total: 0, perHour: 0, plays: 0, samples: [], drift: 0, stray: 0 };
	if (bySkill) out.bySkill = {};
	if (!rotation.length || o.target.kind === 'pp') return out;

	// a balanced target is worth its skills' totals together, not a sum over plays
	const earned: Record<string, number> = {};
	const recent: number[] = [...o.recentPlays].flatMap(([id, n]) => Array<number>(n).fill(id)).slice(-RECENT_LIMIT);
	const counts = new Map<number, number>();
	const count = (id: number, by: number) => counts.set(id, (counts.get(id) ?? 0) + by);
	for (const id of recent) count(id, 1);
	let fatigue: Fatigue = { at: 0, minutes: o.startMinutes };
	let t = 0;
	out.samples.push({ at: 0, bar: barAt(o.startMinutes, o.gear) });
	let byPlay = steps.get(o);
	if (!byPlay) steps.set(o, byPlay = new Map());

	out.loopDurationSec = rotation.reduce((sum, m) => sum + m.durationSec + o.delaySec, 0);
	out.netLoopDriftMin = rotation.reduce((sum, m) => sum + driftOf(m, o), 0);

	for (let i = 0; t < o.sessionSec; i++) {
		const play = rotation[i % rotation.length]!;
		const minutes = restedFatigue(fatigue, t * 1000);
		const recentPlays = counts.get(play.beatmapId) ?? 0;
		let cached = byPlay.get(play);
		if (!cached) byPlay.set(play, cached = new Map());
		const key = Math.round(minutes * 10) * (RECENT_LIMIT + 1) + recentPlays;
		let at = cached.get(key);
		if (!at) {
			const tired = o.lookup(play, minutes);
			const xp = serverXp(tired.xp, { recentPlays, fatigue: fatigueLevel(minutes), medals: o.medals, mods: play.mods });
			at = { xp, durationSec: tired.durationSec, lengthMin: tired.lengthMin, strained: tired.strained, pp: tired.pp };
			cached.set(key, at);
		}
		for (const skill in at.xp) earned[skill] = (earned[skill] ?? 0) + at.xp[skill]!;
		out.plays++;
		t += at.durationSec;
		fatigue = afterPlay(fatigue, at.lengthMin, at.strained, t * 1000);
		const bar = barAt(fatigue.minutes, o.gear);
		out.samples.push({ at: t, bar });
		out.drift = Math.max(out.drift, Math.abs(bar - PEAK_MIDDLE));
		out.stray += Math.abs(bar - PEAK_MIDDLE);
		if (out.leavesAt === undefined && (bar < BAR_ZONES[0] || bar > BAR_ZONES[1])) out.leavesAt = t;
		if (out.warmAt === undefined && bar >= PEAK_MIDDLE) out.warmAt = t;
		recent.push(play.beatmapId);
		count(play.beatmapId, 1);
		if (recent.length > RECENT_LIMIT) count(recent.shift()!, -1);
		t += o.delaySec;
	}

	// If it didn't leave within the simulated horizon, calculate the exact departure time analytically
	if (out.leavesAt === undefined) {
		out.leavesAt = exactDepartureTime(rotation, o);
	}

	out.total = sessionValue(earned, o.target);
	if (out.bySkill) out.bySkill = earned;
	out.perHour = out.total / (o.sessionSec / 3600);
	out.xpPerHour = xpValue(earned, o.target) / (o.sessionSec / 3600);
	out.stray /= out.plays;
	return out;
};

export type RotationOptions = SessionOptions & {
	size: number;
	/** Plays the player put in by hand: kept whatever the search finds. */
	pinned?: readonly string[];
	/** Difficulties the player took out. */
	excluded?: ReadonlySet<number>;
	oneMapPerSet?: boolean;
	/** How far off {@link PEAK_MIDDLE} the bar may stray: {@link HOLD_BAND} unless set, `Infinity` to earn the most wherever it goes. */
	band?: number;
	/** When true, skips auto-fill and auto-balancing; uses strictly user-pinned plays. */
	manualOnly?: boolean;
	/** Times in a row set by hand, by `playKey`: kept as they are, whatever playlist is built. */
	repeats?: Readonly<Record<string, number>>;
};

/** How many plays the swaps after the price sweep consider. */
const CANDIDATES = 60;
/** How many of the best plays the price sweep sorts at each price: it fills the playlist and the swap candidates from the top. */
const PREFIX = 512;
/**
 * The prices the search tries on a minute of drift, in minutes of the loop's
 * earnings: positive to bring resting plays in, negative warming ones.
 */
const PRICES = [0, ...Array.from({ length: 49 }, (_, i) => 2 ** (i / 4 - 4)).flatMap(p => [p, -p])];

/** Whether `trial` beats `best`: strays less while `best` strays past `band`, earns more while both hold. */
const better = (trial: Forecast, best: Forecast, band: number) => {
	const holds = (f: Forecast) => f.drift <= band;
	return holds(best)
		? holds(trial) && trial.total > best.total * 1.001
		: holds(trial) || trial.stray < best.stray - 1e-6;
};

/**
 * Pick the playlist that earns the most over the session while holding the
 * bar within `band` of the middle of the peak - or, where no loop can, the
 * one that strays least.
 *
 * Modified to allow different rates of the same beatmap to be chosen, and supports manualOnly.
 */
export const buildRotation = (ranked: readonly RankedMap[], o: RotationOptions): RankedMap[] => {
	const pinned = ranked.filter(map => o.pinned?.includes(playKey(map)));

	// Manual playlist mode: return exclusively the maps pinned by the user
	if (o.manualOnly) {
		return pinned;
	}

	const allowed = ranked.filter(map => !o.excluded?.has(map.beatmapId));

	// Allows multiple rates per map while avoiding duplicate plays of the identical (beatmapId + rate)
	const fits = (map: RankedMap, rotation: readonly RankedMap[]) =>
		!rotation.some(
			other =>
				(other.beatmapId === map.beatmapId && other.rate === map.rate) ||
				(o.oneMapPerSet && other.setId === map.setId && other.beatmapId !== map.beatmapId),
		);

	const fill = (order: readonly RankedMap[]) => {
		const rotation = [...pinned];
		for (const map of order) {
			if (rotation.length >= o.size) break;
			if (fits(map, rotation)) rotation.push(map);
		}
		return rotation;
	};

	const top = fill(allowed);
	if (o.target.kind === 'pp' || top.length === pinned.length) return top;
	const band = o.band ?? HOLD_BAND;

	const cycle = (map: RankedMap) => map.durationSec + o.delaySec;
	const rate = top.reduce((sum, map) => sum + map.value, 0) / top.reduce((sum, map) => sum + cycle(map), 0);
	const base = allowed.map(map => map.value - rate * cycle(map));
	const drift = allowed.map(map => rate * 60 * driftOf(map, o));
	/** The `limit` best plays at `price`, best first: the sweep runs on every render that changes its inputs, on the game's thread. */
	const byPrice = (price: number, limit: number) => {
		const scores = allowed.map((_, i) => base[i]! - price * drift[i]!);
		const cut = allowed.length > limit ? Float64Array.from(scores).sort()[allowed.length - limit]! : -Infinity;
		return allowed
			.map((map, i) => ({ map, score: scores[i]! }))
			.filter(({ score }) => score >= cut)
			.sort((a, b) => b.score - a.score)
			.map(({ map }) => map);
	};

	let rotation = top;
	let best = forecast(top, o);
	let order: RankedMap[] = allowed;
	for (const price of PRICES) {
		let sorted = byPrice(price, PREFIX);
		let trial = fill(sorted);
		// a prefix of one map's rates and mods may not hold enough maps to fill the playlist
		if (trial.length < top.length) trial = fill(sorted = byPrice(price, Infinity));
		const outcome = forecast(trial, o);
		if (better(outcome, best, band)) {
			best = outcome;
			rotation = trial;
			order = sorted;
		}
	}

	const candidates = order.slice(0, CANDIDATES);
	for (let pass = 0, improved = true; pass < 4 && improved; pass++) {
		improved = false;
		for (let slot = pinned.length; slot < rotation.length; slot++) {
			for (const candidate of candidates) {
				const others = rotation.filter((_, i) => i !== slot);
				if (!fits(candidate, others)) continue;
				const trial = [...rotation];
				trial[slot] = candidate;
				const outcome = forecast(trial, o);
				if (better(outcome, best, band)) {
					best = outcome;
					rotation = trial;
					improved = true;
				}
			}
		}
	}
	return rotation;
};

/** A loop this long never mindblocks: each map is back only once it has left the server's last RECENT_LIMIT plays. */
export const FRESH_SIZE = RECENT_LIMIT + 1;

/** Rounds of working out what a second of the loop earns, and of narrowing the fatigue price at each. */
const FRESH_ROUNDS = 6;
const PRICE_ROUNDS = 40;
/** Swaps at most that even out what the price leaves of the loop's drift. */
const FRESH_SWAPS = 30;
/** Fatigue minutes a loop may add or rest: at 95 minutes a loop, about half an hour over a week. */
const FRESH_DRIFT = 0.25;

/**
 * The playlist that never mindblocks: {@link FRESH_SIZE} difficulties (each once,
 * since mindblock counts every rate of one), earning the most per second while
 * the loop rests as much as it tires. Once each, nothing depends on what came
 * before, so a loop's XP, time and drift are sums and no forecast is needed.
 *
 * Plays that fail are left out whatever the settings: a failed play earns nothing
 * and costs next to no time, so it looks cheap, yet fatigue counts its whole length.
 */
export const buildFresh = (ranked: readonly RankedMap[], o: RotationOptions): RankedMap[] => {
	const pinned = ranked.filter(map => o.pinned?.includes(playKey(map)));
	if (o.manualOnly) return pinned;
	const size = o.size || FRESH_SIZE;
	const usable = ranked.filter(map => !o.excluded?.has(map.beatmapId) && map.failRate < 0.5 && map.value > 0
		&& !pinned.some(other => other.beatmapId === map.beatmapId));
	const plays = usable.map(map => ({ map, cycle: map.durationSec + o.delaySec, drift: driftOf(map, o) }));
	const pinnedPlays = pinned.map(map => ({ map, cycle: map.durationSec + o.delaySec, drift: driftOf(map, o) }));
	type Play = (typeof plays)[number];
	const driftSum = (loop: readonly Play[]) => loop.reduce((sum, play) => sum + play.drift, 0);

	/** The best loop at a price on time and on fatigue: each difficulty (and set, if asked) at its best. */
	const loopAt = (rate: number, price: number): Play[] => {
		const scored = plays
			.map(play => ({ play, score: play.map.value - rate * play.cycle - price * play.drift }))
			.sort((a, b) => b.score - a.score);
		const loop = [...pinnedPlays];
		const maps = new Set(loop.map(play => play.map.beatmapId));
		const sets = new Set(loop.map(play => play.map.setId));
		for (const { play } of scored) {
			if (loop.length >= size) break;
			if (maps.has(play.map.beatmapId) || (o.oneMapPerSet && sets.has(play.map.setId))) continue;
			maps.add(play.map.beatmapId);
			sets.add(play.map.setId);
			loop.push(play);
		}
		return loop;
	};

	const largest = Math.max(1, ...plays.map(play => play.map.value));
	let rate = 0;
	let loop = loopAt(0, 0);
	for (let round = 0; round < FRESH_ROUNDS; round++) {
		rate = loop.reduce((sum, play) => sum + play.map.value, 0) / Math.max(1, loop.reduce((sum, play) => sum + play.cycle, 0));
		// a higher price rests more: narrow to where the loop's drift crosses nothing
		let lo = 0;
		let hi = largest * 100;
		if (driftSum(loopAt(rate, 0)) < 0) { lo = -hi; hi = 0; }
		for (let i = 0; i < PRICE_ROUNDS; i++) {
			const mid = (lo + hi) / 2;
			if (driftSum(loopAt(rate, mid)) > 0) lo = mid;
			else hi = mid;
		}
		const under = loopAt(rate, hi);
		const over = loopAt(rate, lo);
		loop = Math.abs(driftSum(under)) <= Math.abs(driftSum(over)) ? under : over;
	}

	// even out what is left, one swap at a time, for the least XP
	for (let swap = 0; swap < FRESH_SWAPS && Math.abs(driftSum(loop)) > FRESH_DRIFT; swap++) {
		const off = driftSum(loop);
		let best: { out: number; play: Play; loss: number } | undefined;
		const maps = new Set(loop.map(play => play.map.beatmapId));
		for (let i = pinnedPlays.length; i < loop.length; i++) {
			const out = loop[i]!;
			const worth = (play: Play) => play.map.value - rate * play.cycle;
			for (const play of plays) {
				if (maps.has(play.map.beatmapId)) continue;
				if (o.oneMapPerSet && play.map.setId !== out.map.setId && loop.some(other => other.map.setId === play.map.setId)) continue;
				if (Math.abs(off + play.drift - out.drift) >= Math.abs(off)) continue;
				const loss = worth(out) - worth(play);
				// the XP given up per minute of drift mended
				const cost = loss / (Math.abs(off) - Math.abs(off + play.drift - out.drift));
				if (!best || cost < best.loss) best = { out: i, play, loss: cost };
			}
		}
		if (!best) break;
		loop = loop.map((play, i) => (i === best!.out ? best!.play : play));
	}
	return loop.map(play => play.map);
};

/** The playlist sizes {@link bestSize} tries. */
export const AUTO_SIZES = [5, 8, 10, 15, 20, 30];
/** How long the forecasts that compare sizes run: a day ranks sizes as a week does, seven times faster. */
const SIZING_SEC = 24 * 3600;

/**
 * The playlist size that does best, so nobody has to find it: the search's
 * playlist at each of {@link AUTO_SIZES}, forecast over a day, ranked as the
 * search ranks playlists - holding `band` first, then earning most. Sizes past
 * what the library can fill are not tried.
 */
export const bestSize = (ranked: readonly RankedMap[], o: RotationOptions): number => {
	const short = { ...o, sessionSec: Math.min(o.sessionSec, SIZING_SEC) };
	const band = o.band ?? HOLD_BAND;
	let best: { size: number; outcome: Forecast } | undefined;
	let tried = 0;
	let filled = 0;
	for (const size of AUTO_SIZES) {
		if (filled < tried) break; // the last size already took every map there is
		const rotation = buildRotation(ranked, { ...short, size });
		tried = size;
		filled = rotation.length;
		const outcome = forecast(rotation, short);
		if (!best || better(outcome, best.outcome, band)) best = { size, outcome };
	}
	return best?.size ?? AUTO_SIZES[0]!;
};

/** The most times in a row the repeat search plays one map. */
export const MAX_REPEAT = 10;
/** How many rounds of single repeat changes the search tries at most. */
const REPEAT_ROUNDS = 60;

/** How many times in a row each of `rotation` plays: as set by hand in `fixed`, else once. */
export const repeatsOf = (rotation: readonly RankedMap[], fixed: Readonly<Record<string, number>> = {}): number[] =>
	rotation.map(map => Math.min(MAX_REPEAT, Math.max(1, Math.round(fixed[playKey(map)] ?? 1))));

/** The plays a playlist makes in one loop: each map `repeats[i]` times in a row, as the game's queue plays it. */
export const expand = (rotation: readonly RankedMap[], repeats: readonly number[]): RankedMap[] =>
	rotation.flatMap((map, i) => Array<RankedMap>(Math.max(1, repeats[i] ?? 1)).fill(map));

/**
 * The playlist that earns the most over the session, each map played several
 * times in a row: replaying the best maps beats moving on to worse ones until
 * mindblock dulls them or the fatigue they build costs more. Starts from the
 * search's playlist with nothing held (`band: Infinity`), then changes one map's
 * repeat count at a time - dropping a map at none - while the forecast says it
 * earns more. Pinned maps stay, and so does a count set by hand (`o.repeats`).
 */
export const buildRepeating = (
	ranked: readonly RankedMap[],
	o: RotationOptions,
): { rotation: RankedMap[]; repeats: number[] } => {
	let rotation = buildRotation(ranked, { ...o, band: Infinity });
	let repeats = repeatsOf(rotation, o.repeats);
	if (o.manualOnly || o.target.kind === 'pp' || !rotation.length) return { rotation, repeats };

	const pinned = new Set(o.pinned ?? []);
	const fixed = o.repeats ?? {};
	const worth = (r: readonly RankedMap[], n: readonly number[]) => forecast(expand(r, n), o).total;
	let best = worth(rotation, repeats);
	for (let round = 0; round < REPEAT_ROUNDS; round++) {
		let next: { rotation: RankedMap[]; repeats: number[]; total: number } | undefined;
		for (let i = 0; i < rotation.length; i++) {
			if (playKey(rotation[i]!) in fixed) continue;
			for (const step of [1, -1]) {
				const count = repeats[i]! + step;
				if (count > MAX_REPEAT) continue;
				let trial: RankedMap[] = rotation;
				let counts: number[];
				if (count < 1) {
					if (rotation.length === 1 || pinned.has(playKey(rotation[i]!))) continue;
					trial = rotation.filter((_, j) => j !== i);
					counts = repeats.filter((_, j) => j !== i);
				} else {
					counts = repeats.map((n, j) => (j === i ? count : n));
				}
				const total = worth(trial, counts);
				if (total > best * 1.0005 && total > (next?.total ?? -Infinity)) next = { rotation: trial, repeats: counts, total };
			}
		}
		if (!next) break;
		({ rotation, repeats } = next);
		best = next.total;
	}
	return { rotation, repeats };
};

/**
 * The playlist that warms a rested character to the middle of its peak the
 * fastest: the plays that add the most fatigue per second of the loop, gaps
 * included, while it warms up.
 */
export const buildWarmup = (ranked: readonly RankedMap[], o: RotationOptions): RankedMap[] => {
	const pinned = ranked.filter(map => o.pinned?.includes(playKey(map)));
	if (o.manualOnly) {
		return pinned;
	}

	const halfway = midPeakMinutes(o.gear) / 2;
	const warmth = new Map(ranked.map(map => [map, driftOf(map, o, halfway) / (map.durationSec + o.delaySec)]));
	const rotation: RankedMap[] = [];
	for (const map of [...ranked].sort((a, b) => warmth.get(b)! - warmth.get(a)! || b.value - a.value)) {
		if (rotation.length >= o.size) break;
		if (o.excluded?.has(map.beatmapId) || warmth.get(map)! <= 0) continue;
		if (
			!rotation.some(
				other =>
					(other.beatmapId === map.beatmapId && other.rate === map.rate) ||
					(o.oneMapPerSet && other.setId === map.setId && other.beatmapId !== map.beatmapId),
			)
		) {
			rotation.push(map);
		}
	}
	return rotation;
};