/**
 * The farm model, off the game's thread: the plays a scan brings in, their
 * ranking, the playlist search and its forecasts.
 *
 * Ranking a library is tens of milliseconds and the playlist search seconds:
 * on the game's thread, that dropped frames at every update. Here the plays are
 * kept as they come in (the overlay sends each batch once), the model updates at
 * most every {@link UPDATE_MS} while they stream in and at once when a setting
 * changes, and only what the overlay shows goes back.
 *
 * The bundler inlines this file into the add-on as a string (`worker:` import),
 * since a Blob-loaded add-on has no URL to load a separate worker file from.
 */

import type { Mod } from '@oss-idle/shared/mods';
import type { SimRequest, SimResult } from '../engine/protocol.js';
import {
	bestPerDifficulty,
	playKey,
	rankMaps,
	refinePlan,
	rowOf,
	withPotential,
	type Fatigued,
	type FarmTarget,
	type MapRow,
	type RankedMap,
	type RankOptions,
} from './metrics.js';
import {
	bestSize,
	buildFresh,
	buildRepeating,
	FRESH_SIZE,
	buildRotation,
	buildWarmup,
	coldCurve,
	driftOf,
	expand,
	forecast,
	HOLD_HOURS,
	midPeakMinutes,
	repeatsOf,
	stateLookup,
	strainRatioOf,
	WARMUP_HOURS,
	type Forecast,
	type SessionOptions,
} from './session.js';

/** How often the model updates while plays stream in. */
const UPDATE_MS = 4000;

/** What the overlay's settings make of the model. */
export type FarmSettings = RankOptions & {
	gear: number;
	warmingUp: boolean;
	size: number;
	/** Find the size that does best instead (`bestSize`); not for a warm-up or manual playlist. */
	autoSize: boolean;
	/** No scan is bringing plays in: an automatic size is worked out again only then. */
	settled: boolean;
	/** How far off the middle of the peak the playlist may stray (`HOLD_BAND`...). */
	band: number;
	pinned: string[];
	excluded: Set<number>;
	oneMapPerSet: boolean;
	/** Only the maps put in by hand, as they are. */
	manualOnly: boolean;
	/** Play each map several times in a row where that earns more: `buildRepeating`. */
	repeat: boolean;
	/** A loop long enough that no map mindblocks: {@link FRESH_SIZE} difficulties, once each. */
	fresh: boolean;
	/** Times in a row set by hand, by `playKey`: kept whatever playlist is built. */
	setRepeats: Record<string, number>;
	/** Whether the Maps tab is open: its list goes back only then. */
	withBest: boolean;
	/** The maps list with every play simulated - each rate and mods of each difficulty - not only each difficulty's best. */
	everyRate: boolean;
};

export type FarmIn =
	/** A new scan: every play goes. */
	| { type: 'reset' }
	/** Plays simulated at their peak, and the same plays tired; a play simulated again replaces its earlier result. */
	| { type: 'plays'; peaks?: SimResult[]; states?: SimResult[] }
	| { type: 'settings'; settings: FarmSettings };

/** Questions a scan asks between its passes, answered at once. */
export type FarmAsk =
	/** What to simulate again, and at which rates: `refinePlan` over the plays so far. */
	| { type: 'refine'; rank: RankOptions; rates: number[]; screened: number[]; maps: number; mods: Mod[][]; minutes: number }
	/** The `count` best difficulties, each at its best play. */
	| { type: 'best'; rank: RankOptions; count: number };

/** What the overlay shows. */
export type FarmView = {
	/** The settings changes and plays taken in, by the overlay's count: anything sent after is not in yet. */
	upTo: number;
	/** The target, with what each skill can earn when several main skills are balanced. */
	farm: FarmTarget;
	rotation: (RankedMap & Fatigued)[];
	/** How many times in a row each playlist map plays, by its place in `rotation`. */
	repeats: number[];
	/** The playlist's size: the one asked for, or the one an automatic size found. */
	size: number;
	outlook: Forecast;
	/** The best plays alone, for comparison. */
	baseline: Forecast;
	/** Every difficulty at its best play, when the Maps tab asked for it: as its table row shows it. */
	best?: MapRow[];
	plays: number;
	maps: number;
};

export type FarmOut =
	| ({ type: 'view' } & FarmView)
	| { type: 'answer'; id: number; value: unknown };

const post = (message: FarmOut) => (self as unknown as Worker).postMessage(message);

/** Plays at their peak and tired, by play and tiredness: a refined play replaces its screening one. */
const peaks = new Map<string, SimResult>();
const states = new Map<string, SimResult>();
const idOf = (play: SimResult) => `${playKey(play)}~${play.minutes}`;

let settings: FarmSettings | undefined;
/** The overlay's count of what it sent, as far as it is taken in. */
let seen = 0;
let playsVersion = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
/** When the last update finished: streaming plays wait {@link UPDATE_MS} from there, so a slow search still leaves the worker a rest. */
let lastRun = 0;

/** Sets and maps as arrays, so settings compare as JSON. */
const keyOf = (value: unknown) => JSON.stringify(value, (_, v) => (v instanceof Map || v instanceof Set ? [...v] : v));

/** The ranking and the search, kept until what they read changes. */
let ranking: { key: string; ranked: RankedMap[]; farm: FarmTarget; session: SessionOptions } | undefined;
let search: { key: string; rotation: (RankedMap & Fatigued)[]; repeats: number[]; outlook: Forecast; baseline: Forecast } | undefined;
/** The size an automatic size found, kept while a scan brings plays in: finding it is a few searches. */
let sizing: { key: string; size: number } | undefined;
/** An automatic size before the first one is found. */
const FIRST_SIZE = 10;

/** `map` with how it moves fatigue in `session`, as the tables show it. */
const fatigued = <M extends RankedMap>(map: M, session: SessionOptions): M & Fatigued => {
	const drift = driftOf(map, session);
	const cycle = map.durationSec + session.delaySec;
	return { ...map, drift, driftPerSec: cycle > 0 ? (drift * 60) / cycle : 0, strainShare: strainRatioOf(map, session) };
};

const update = () => {
	timer = undefined;
	if (!settings) return;
	const upTo = seen;
	const { gear, warmingUp, size: asked, autoSize, settled, band, pinned, excluded, oneMapPerSet, manualOnly, repeat, fresh, setRepeats, withBest, everyRate, ...rank } = settings;

	const rankKey = `${playsVersion}|${keyOf(rank)}|${gear}`;
	if (ranking?.key !== rankKey) {
		const results = [...peaks.values()];
		const ranked = rankMaps(results, rank);
		const farm = withPotential(rank.target, ranked, rank.delaySec ?? 30);
		const tired = [...states.values()];
		const byPlay = new Map(results.map(result => [playKey(result), result]));
		ranking = {
			key: rankKey,
			ranked,
			farm,
			session: {
				target: farm,
				lookup: stateLookup(tired, gear, coldCurve(tired, byPlay, gear)),
				sessionSec: HOLD_HOURS * 3600,
				startMinutes: midPeakMinutes(gear),
				delaySec: rank.delaySec ?? 30,
				gear,
				medals: rank.medals ?? 1,
				recentPlays: rank.recentPlays ?? new Map(),
			},
		};
	}
	const { ranked, farm, session } = ranking;

	let size = asked;
	if (fresh && !warmingUp && !manualOnly) {
		size = FRESH_SIZE;
	} else if (autoSize && !warmingUp && !manualOnly) {
		const key = `${rankKey}|${keyOf({ band, pinned, excluded, oneMapPerSet })}`;
		if (settled && sizing?.key !== key) {
			sizing = { key, size: bestSize(ranked, { ...session, size: 0, pinned, excluded, oneMapPerSet, band }) };
		}
		size = sizing?.size ?? FIRST_SIZE;
	}

	const searchKey = `${rankKey}|${keyOf({ warmingUp, size, band, pinned, excluded, oneMapPerSet, manualOnly, repeat, fresh, setRepeats })}`;
	if (search?.key !== searchKey) {
		const warm = { ...session, startMinutes: 0, sessionSec: WARMUP_HOURS * 3600 };
		const options = { size, pinned, excluded, oneMapPerSet, manualOnly, repeats: setRepeats };
		const { rotation, repeats } = warmingUp
			? { rotation: buildWarmup(ranked, { ...warm, ...options }), repeats: undefined }
			: repeat
				? buildRepeating(ranked, { ...session, ...options, band })
				: fresh
					? { rotation: buildFresh(ranked, { ...session, ...options, band }), repeats: undefined }
					: { rotation: buildRotation(ranked, { ...session, ...options, band }), repeats: undefined };
		const counts = repeats ?? (fresh ? rotation.map(() => 1) : repeatsOf(rotation, setRepeats));
		const best: RankedMap[] = [];
		for (const map of ranked) {
			if (best.length >= size) break;
			if (!best.some(other => other.beatmapId === map.beatmapId)) best.push(map);
		}
		search = {
			key: searchKey,
			rotation: rotation.map(map => fatigued(map, session)),
			repeats: counts,
			outlook: forecast(expand(rotation, counts), warmingUp ? warm : session, true),
			baseline: forecast(best, session),
		};
	}

	post({
		type: 'view',
		upTo,
		farm,
		rotation: search.rotation,
		repeats: search.repeats,
		size,
		outlook: search.outlook,
		baseline: search.baseline,
		best: withBest
			? (everyRate ? ranked : bestPerDifficulty(ranked)).map(map => rowOf(fatigued(map, session)))
			: undefined,
		plays: peaks.size,
		maps: new Set([...peaks.values()].map(play => play.beatmapId)).size,
	});
	lastRun = Date.now();
};

/** Update now, or once {@link UPDATE_MS} have passed since the last update finished. */
const schedule = (now: boolean) => {
	if (timer !== undefined) {
		if (!now) return;
		clearTimeout(timer);
	}
	timer = setTimeout(update, now ? 0 : Math.max(0, lastRun + UPDATE_MS - Date.now()));
};

const answer = (ask: FarmAsk) => {
	const ranked = rankMaps([...peaks.values()], ask.rank);
	return ask.type === 'refine'
		? refinePlan(ranked, ask.rates, ask.screened, ask.maps, ask.mods, ask.minutes) satisfies SimRequest[]
		: bestPerDifficulty(ranked).slice(0, ask.count);
};

self.onmessage = ({ data }: MessageEvent<(FarmIn & { seq: number }) | (FarmAsk & { id: number })>) => {
	if ('id' in data) {
		post({ type: 'answer', id: data.id, value: answer(data) });
		return;
	}
	seen = data.seq;
	switch (data.type) {
		case 'reset':
			peaks.clear();
			states.clear();
			playsVersion++;
			return schedule(true);
		case 'plays':
			for (const play of data.peaks ?? []) peaks.set(idOf(play), play);
			for (const play of data.states ?? []) states.set(idOf(play), play);
			playsVersion++;
			return schedule(false);
		case 'settings':
			settings = data.settings;
			return schedule(true);
	}
};
