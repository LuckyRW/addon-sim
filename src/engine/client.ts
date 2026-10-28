/**
 * The sweep: every play asked of oss!idle's sim API (the server's own
 * simulation, `POST /api/v2/simulate`), or of what is kept of its earlier
 * answers (`samples.ts`). Results arrive a rate at a time, so a sweep of a
 * large library fills the table progressively instead of blocking on the whole
 * run.
 */

import {
	beatmapStore,
	gameCharacter,
	gameDb,
	playCountsSince,
	type CharacterRow,
} from '@oss-idle/addon-sdk';
import compareVersions from '@oss-idle/shared/helpers/compareVersions';
import { medalXPMultiplier, type MedalCatalogue } from '@oss-idle/shared/achievements/catalogue';
import { MEDALS } from '@oss-idle/shared/rulesets/mania/4k/medals';
import type { ApiSimulateRequest, ApiSimulation } from '@oss-idle/shared/apiV2';
import { paced, statusOf } from './pace.js';
import { modsKey, type Mod } from '@oss-idle/shared/mods';
import { LEAD_IN_MS } from '@oss-idle/shared/play';
import { rateSteps } from '@oss-idle/shared/rate';
import type { SimError, SimRequest, SimResult } from './protocol.js';
import {
	cachedPlays,
	cachedSimVersion,
	cacheKey,
	fromApi,
	learnedOf,
	localPlays,
	MAX_SAMPLES,
	skillsetKey,
	stateOf,
	type Sample,
} from './samples.js';

type SweepProgress = {
	done: number;
	total: number;
	results: SimResult[];
	errors: SimError[];
};

export type Sweep = {
	/** Resolves when the sweep finishes or is cancelled. */
	finished: Promise<{ results: SimResult[]; errors: SimError[]; cancelled: boolean }>;
	cancel: () => void;
};

/** Only 4K mania difficulties are playable, so only those are worth simulating. */
const isSimulatable = (version: { mode: number; keys: number }) =>
	version.mode === 3 && version.keys === 4;

/**
 * What the sweep found, and what it discarded.
 *
 * An empty result has several very different causes - nothing downloaded, only
 * non-4K difficulties stored, or charts missing next to their metadata - and
 * they call for different fixes, so the counts are reported rather than
 * collapsed into "no maps found".
 */
type LibrarySurvey = {
	sets: number;
	versions: number;
	/** Difficulties excluded for not being 4K mania. */
	skippedMode: number;
	/** Difficulties already listed by an earlier set - see {@link planSweep}. */
	duplicates: number;
	/** 4K difficulties excluded for not being ranked on the game server. */
	skippedUnranked: number;
	requests: Pick<SimRequest, 'setId' | 'beatmapId'>[];
};

/** The shape {@link planSweep} needs from a stored set. */
type PlannableSet = {
	id: number;
	versions?: { id: number; mode: number; keys: number }[];
};

/**
 * Decide what to simulate from the stored set metadata.
 *
 * **Each difficulty is listed at most once.** A `beatmapId` can appear under
 * more than one stored set - a set re-downloaded after an update can leave the
 * old record behind, and a set's `versions` array is not itself guaranteed
 * distinct. Simulating such a difficulty twice puts two rows with the same
 * identity in the table, which is not merely cosmetic: the results list is keyed
 * by `beatmapId`, and duplicate keys make React reuse the wrong rows when the
 * ranking re-sorts, so stale rows survive at stale positions above the real
 * ordering.
 *
 * With `ranked`, only the difficulties in it are listed.
 *
 * Pure, so this is testable without a beatmap store.
 */
export const planSweep = (sets: readonly PlannableSet[], ranked?: ReadonlySet<number>): LibrarySurvey => {
	const survey: LibrarySurvey = {
		sets: sets.length,
		versions: 0,
		skippedMode: 0,
		duplicates: 0,
		skippedUnranked: 0,
		requests: [],
	};

	const seen = new Set<number>();

	for (const set of sets) {
		const versions = set.versions ?? [];
		survey.versions += versions.length;

		for (const version of versions) {
			if (!isSimulatable(version)) {
				survey.skippedMode++;
				continue;
			}
			if (seen.has(version.id)) {
				survey.duplicates++;
				continue;
			}
			if (ranked && !ranked.has(version.id)) {
				survey.skippedUnranked++;
				continue;
			}
			seen.add(version.id);
			survey.requests.push({ setId: set.id, beatmapId: version.id });
		}
	}

	return survey;
};

/** List every stored 4K difficulty worth simulating: the server plays them from its own charts. */
export const collectCharts = async (ranked?: ReadonlySet<number>): Promise<LibrarySurvey> =>
	planSweep(await beatmapStore.sets(), ranked);

/** The rates to simulate: every one the character's Speed upgrades unlock, but `excluded`. */
export const ratesFor = (speedUpgrades: number, excluded: readonly number[]): number[] =>
	rateSteps(speedUpgrades).filter(rate => !excluded.includes(rate));

/** `POST /api/v2/simulate`, as the signed-in player (the add-on host's `api.simulate`). */
export type Simulate = (body: ApiSimulateRequest) => Promise<ApiSimulation>;

/** Maps simulated at once: each waits on the server most of the time. */
const MAPS_AT_ONCE = 6;
/** Rates that fail every run this many times in a row end a map's sweep: a faster rate is harder still. */
const FAILS_TO_STOP = 2;

/** Why a map could not be simulated, as the table says it. */
const reasonOf = (e: unknown) => {
	switch (statusOf(e)) {
		case 404: return 'not live on the server';
		case 422: return e instanceof Error ? e.message : 'refused';
		default: return e instanceof Error ? e.message : String(e);
	}
};

/** Plays averaged into what the table shows. */
const summarize = (
	map: SimRequest,
	{ rate, mods, minutes }: { rate: number; mods: Mod[]; minutes: number },
	lengthSec: number,
	samples: readonly Sample[],
): SimResult => {
	const runs = samples.length;
	const xp: Record<string, number> = {};
	for (const sample of samples) {
		for (const [skill, value] of Object.entries(sample.xp)) xp[skill] = (xp[skill] ?? 0) + value / runs;
	}
	const totals = samples.map(sample => Object.values(sample.xp).reduce((sum, value) => sum + value, 0));
	const totalXp = totals.reduce((sum, value) => sum + value, 0) / runs;
	const variance = totals.reduce((sum, value) => sum + (value - totalXp) ** 2, 0) / runs;
	const mean = (of: (sample: Sample) => number) => samples.reduce((sum, sample) => sum + of(sample), 0) / runs;
	const grades = samples.map(sample => sample.grade).sort();
	return {
		setId: map.setId,
		beatmapId: map.beatmapId,
		rate,
		mods,
		minutes,
		xp,
		totalXp,
		// a failed play ends where it failed, so it costs less time and earns nothing
		durationSec: LEAD_IN_MS / 1000 + mean(s => (s.passed ? lengthSec / rate : s.failSeconds ?? lengthSec / rate)),
		lengthMin: lengthSec / rate / 60,
		strained: mean(s => s.strained),
		accuracy: mean(s => s.accuracy),
		grade: grades[Math.floor(grades.length / 2)] ?? 'D',
		pp: mean(s => s.pp),
		runs,
		failRate: mean(s => (s.passed ? 0 : 1)),
		variation: totalXp > 0 ? Math.sqrt(variance) / totalXp : 0,
	};
};

/**
 * Simulate the current character against `requests` through the sim API, each
 * variant averaged over `runs` plays.
 *
 * A play this browser already asked for is used again (see {@link localPlays});
 * a variant it has none of may take the sim cache's play instead, which saves
 * one call. Maps go `MAPS_AT_ONCE` at a time, their rates from the slowest up,
 * so a map's sweep stops once its rates fail outright.
 */
export const runSweep = async (
	requests: SimRequest[],
	{ runs = 3, characterId, memoryAhead = 0, simulate }: {
		runs?: number;
		characterId?: number;
		/** Plays added to each map's count before seeding memory - see `PLAYS_PER_MAP`. */
		memoryAhead?: number;
		simulate: Simulate;
	},
	onProgress?: (progress: SweepProgress) => void,
): Promise<Sweep> => {
	// Which character to simulate is the player's choice when they have made
	// one, because the client's own answer lives in module state we cannot read.
	const character = characterId !== undefined
		? await gameCharacter.byId(characterId)
		: await gameCharacter.live();
	if (!character) throw new Error('No character found in the game database.');
	const state = stateOf(character as unknown as Record<string, unknown>);

	// Memory trains per map, from how often this character has played it since
	// memory was last prestiged.
	const playCounts = await playCountsSince(
		Number(character.id),
		Number(character.memoryResetAt) || 0,
	);
	const plays = (beatmapId: number) => (playCounts[beatmapId] ?? 0) + memoryAhead;
	// the chart's length in ms, as the game reads it off the chart (`totalLength`)
	const lengths = new Map((await beatmapStore.difficulties()).map(({ version }) => [version.id, version.total_length / 1000]));
	runs = Math.max(1, Math.min(MAX_SAMPLES, runs));

	// This browser's plays are kept by sim version: without one, none are.
	const version = await cachedSimVersion();
	void localPlays.prune();
	const skillsets = new Map<number, string>();
	const localKey = (beatmapId: number, rate: number, mods: readonly Mod[], minutes: number) => {
		let skillset = skillsets.get(minutes);
		if (skillset === undefined) skillsets.set(minutes, skillset = skillsetKey(state, minutes));
		return `${version}|${skillset}|${beatmapId}@${rate}@${modsKey(mods)}|${plays(beatmapId)}`;
	};
	const variants = requests.flatMap(map => map.rates.flatMap(rate => map.mods.flatMap(mods =>
		map.minutes.map(minutes => ({ map, rate, mods, minutes, key: version && localKey(map.beatmapId, rate, mods, minutes) })))));
	const local = version ? await localPlays.read(variants.map(v => v.key as string)) : new Map<string, Sample[]>();

	// The cache answers for the variants this browser has no play of, on maps memory is new to or has learned.
	const short = variants.filter(v => !local.get(v.key as string)?.length && learnedOf(plays(v.map.beatmapId)) !== undefined);
	const cached = new Map<number, Map<string, Sample>>();
	await Promise.all([...new Set(short.map(v => v.minutes))].map(async minutes => {
		const ids = [...new Set(short.filter(v => v.minutes === minutes).map(v => v.map.beatmapId))];
		cached.set(minutes, await cachedPlays(state, minutes, ids));
	}));

	const results: SimResult[] = [];
	const errors: SimError[] = [];
	let done = 0;
	let over = false;
	let settle: (value: { results: SimResult[]; errors: SimError[]; cancelled: boolean }) => void;
	let fail: (reason: unknown) => void;
	const finished = new Promise<{ results: SimResult[]; errors: SimError[]; cancelled: boolean }>(
		(resolve, reject) => { settle = resolve; fail = reject; },
	);

	const report = (result?: SimResult, error?: SimError) => {
		if (result) results.push(result);
		if (error) errors.push(error);
		onProgress?.({
			done,
			total: requests.length,
			results: result ? [result] : [],
			errors: error ? [error] : [],
		});
	};

	/** One rate × mods × tiredness of a map, from what is kept first and the sim API for the rest. */
	const variant = async (map: SimRequest, rate: number, mods: Mod[], minutes: number): Promise<SimResult> => {
		const key = version && localKey(map.beatmapId, rate, mods, minutes);
		const samples = [...(key && local.get(key) || [])].slice(0, runs);
		const learned = learnedOf(plays(map.beatmapId));
		const stand = learned === undefined ? undefined : cached.get(minutes)?.get(cacheKey(map.beatmapId, rate, mods, learned));
		// what the cache keeps may be this browser's own play: only one with nothing of its own takes it
		if (!samples.length && stand) samples.push(stand);
		while (samples.length < runs) {
			if (over) throw new Error('cancelled');
			const answer = await paced(() => simulate({
				beatmap_id: map.beatmapId,
				rate,
				mods,
				generation: state.generation,
				strain_minutes: minutes,
				map_plays: plays(map.beatmapId),
				skills: state.skills,
			}));
			const sample = fromApi(answer, minutes);
			samples.push(sample);
			if (key) void localPlays.add(key, sample);
		}
		return summarize(map, { rate, mods, minutes }, lengths.get(map.beatmapId) ?? 0, samples);
	};

	const sweepMap = async (map: SimRequest) => {
		let failStreak = 0;
		try {
			for (const rate of [...map.rates].sort((a, b) => a - b)) {
				let allFailed = true;
				for (const mods of map.mods) {
					for (const minutes of map.minutes) {
						const result = await variant(map, rate, mods, minutes);
						if (over) return;
						report(result);
						if (result.failRate < 1) allFailed = false;
					}
				}
				failStreak = allFailed ? failStreak + 1 : 0;
				if (failStreak >= FAILS_TO_STOP) break;
			}
			done++;
			report();
		} catch (e) {
			if (over) return;
			// a guest has no API, and a request the API calls bad is bad on every map: stop
			if (statusOf(e) === 401 || statusOf(e) === 400) {
				over = true;
				fail(statusOf(e) === 401
					? new Error('Sign in to simulate: the sim API plays for signed-in players only.')
					: Object.assign(new Error(`The sim API refuses this version's requests (${reasonOf(e)}).`), { status: 400 }));
				return;
			}
			done++;
			report(undefined, { setId: map.setId, beatmapId: map.beatmapId, message: reasonOf(e) });
		}
	};

	const queue = [...requests];
	void Promise.all(Array.from({ length: Math.min(MAPS_AT_ONCE, queue.length) }, async () => {
		for (let map = queue.shift(); map && !over; map = queue.shift()) await sweepMap(map);
	})).then(() => {
		if (over) return;
		over = true;
		settle({ results, errors, cancelled: false });
	});

	return {
		finished,
		cancel: () => {
			if (over) return;
			over = true;
			settle({ results, errors, cancelled: true });
		},
	};
};

/** The seconds autopilot waits between plays, from the game's own setting. */
export const autopilotDelay = (): number => {
	try {
		// the game stores a setting only once it is changed: 30 is its default
		const stored: unknown = JSON.parse(localStorage.getItem('autopilotDelay') ?? 'null');
		return typeof stored === 'number' && stored >= 0 ? stored : 30;
	} catch {
		return 30;
	}
};

/** The game's production API, as baked into its client build. */
const API_URL = 'https://api.oss.idle.rhythmgamers.net';

/** This add-on's name, as the game keeps it (`addon.config.json`). */
const ADDON_NAME = 'oss!idle sim';

/**
 * What to tell a player whose add-on the sim API refuses: whether a newer
 * version is out, and whether the game installs it by itself (it checks every
 * minute for the add-ons set to update automatically).
 */
export const updateHint = async (version: string): Promise<string> => {
	const fallback = ' Update the add-on in Options → Add-ons.';
	try {
		const row = await gameDb.first<{ id: number; autoUpdate: number }>(
			'SELECT id, autoUpdate FROM addon WHERE name = ?', [ADDON_NAME],
		);
		if (!row) return fallback;
		const res = await fetch(`${API_URL}/v1/addons/versions?ids=${row.id}`);
		const latest = res.ok ? (await res.json() as Record<number, string>)[row.id] : undefined;
		if (!latest || compareVersions(latest, version) <= 0) return ' No newer version is out yet: try again later.';
		return row.autoUpdate
			? ` Version ${latest} is out: the game installs it within a minute.`
			: ` Version ${latest} is out: update it in Options → Add-ons.`;
	} catch {
		return fallback;
	}
};

/**
 * XP multiplier from the medals a character holds, or `undefined` when the
 * server cannot be reached.
 *
 * Medals are awarded and stored by the server only, so a guest character holds
 * none, and an account character's set is read from its public profile.
 */
export const medalMultiplier = async (character: CharacterRow): Promise<number | undefined> => {
	if (character.local) return 1;
	try {
		const res = await fetch(`${API_URL}/v1/characters/${character.id}/medals`);
		if (!res.ok) return undefined;
		const { held } = await res.json() as { held: { id: string }[] };
		// the multiplier reads the catalogue's medals alone
		return medalXPMultiplier({ medals: MEDALS } as unknown as MedalCatalogue, held.map(medal => medal.id));
	} catch {
		return undefined;
	}
};

/**
 * Ids of the difficulties live on the game server, and of the loved ones among
 * them, or `undefined` when the server cannot be reached.
 *
 * Only live ones pay an account character XP: the server simulates a play on a
 * live difficulty and answers any other as unranked, which the client plays
 * locally for no XP. Loved ones pay XP but no pp. The intro set is in the
 * catalog but is not live.
 */
export const liveDifficulties = async (): Promise<{ live: Set<number>; loved: Set<number> } | undefined> => {
	try {
		const res = await fetch(`${API_URL}/v1/beatmap/catalog`);
		if (!res.ok) return undefined;
		const { intro, beatmaps } = await res.json() as {
			intro?: { id: number };
			beatmaps: { id: number; loved?: boolean; versions: { id: number }[] }[];
		};
		const sets = beatmaps.filter(set => set.id !== intro?.id);
		const ids = (list: typeof sets) => new Set(list.flatMap(set => set.versions.map(version => version.id)));
		return { live: ids(sets), loved: ids(sets.filter(set => set.loved)) };
	} catch {
		return undefined;
	}
};

export type MapInfo = {
	setId: number;
	beatmapId: number;
	title: string;
	artist: string;
	creator: string;
	version: string;
	difficulty: number;
	lengthSec: number;
	bpm: number;
	objects: number;
};

/**
 * Display metadata for every stored 4K difficulty, by beatmap id.
 *
 * Kept apart from {@link collectCharts} so the table can label rows without
 * holding every chart's text in memory alongside the results.
 */
export const libraryIndex = async (): Promise<Map<number, MapInfo>> => {
	const index = new Map<number, MapInfo>();
	for (const { set, version } of await beatmapStore.difficulties()) {
		if (!isSimulatable(version)) continue;
		index.set(version.id, {
			setId: set.id,
			beatmapId: version.id,
			title: set.title,
			artist: set.artist,
			creator: set.creator,
			version: version.version,
			difficulty: version.difficulty,
			lengthSec: version.total_length / 1000,
			bpm: version.bpm,
			objects: version.objects,
		});
	}
	return index;
};
