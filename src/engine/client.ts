/**
 * What the overlay asks of the game: the library to sweep, the character, the
 * catalog and medals, and the sweep itself (`sweep.ts`, run in a worker).
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
import { rateSteps } from '@oss-idle/shared/rate';
import type { SimError, SimRequest, SimResult } from './protocol.js';
import { paced, statusOf, type Simulate, type Sweep, type SweepProgress } from './sweep.js';
import type { SweepIn, SweepOut } from './sweep.worker.js';
import createSweepWorker from 'worker:./sweep.worker';

export type { Simulate, Sweep } from './sweep.js';

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

/**
 * Simulate the current character against `requests`: the sweep runs in a worker
 * (`sweep.ts`), and the game's thread reads the character for it, makes its sim
 * API calls (spaced under the rate limit) and hands its progress on.
 */
export const runSweep = async (
	requests: SimRequest[],
	{ runs = 3, characterId, memoryAhead = 0, simulate, lengthOf }: {
		runs?: number;
		characterId?: number;
		/** Plays added to each map's count before seeding memory - see `MEMORY_AHEAD`. */
		memoryAhead?: number;
		simulate: Simulate;
		/** A map's length in seconds, at x1. */
		lengthOf: (beatmapId: number) => number | undefined;
	},
	onProgress?: (progress: SweepProgress) => void,
): Promise<Sweep> => {
	// Which character to simulate is the player's choice when they have made
	// one, because the client's own answer lives in module state we cannot read.
	const character = characterId !== undefined
		? await gameCharacter.byId(characterId)
		: await gameCharacter.live();
	if (!character) throw new Error('No character found in the game database.');
	// Memory trains per map, from how often this character has played it since
	// memory was last prestiged.
	const playCounts = await playCountsSince(
		Number(character.id),
		Number(character.memoryResetAt) || 0,
	);

	const results: SimResult[] = [];
	const errors: SimError[] = [];
	let over = false;
	let settle: (value: { results: SimResult[]; errors: SimError[]; cancelled: boolean }) => void;
	let fail: (reason: unknown) => void;
	const finished = new Promise<{ results: SimResult[]; errors: SimError[]; cancelled: boolean }>(
		(resolve, reject) => { settle = resolve; fail = reject; },
	);

	const worker = createSweepWorker();
	const end = () => {
		over = true;
		worker.terminate();
	};
	worker.onmessage = ({ data }: MessageEvent<SweepOut>) => {
		if (over) return;
		switch (data.type) {
			case 'simulate':
				paced(() => simulate(data.body)).then(
					answer => !over && worker.postMessage({ type: 'answer', id: data.id, answer } satisfies SweepIn),
					(e: unknown) => !over && worker.postMessage({
						type: 'answer', id: data.id, error: e instanceof Error ? e.message : String(e), status: statusOf(e),
					} satisfies SweepIn),
				);
				break;
			case 'progress':
				results.push(...data.progress.results);
				errors.push(...data.progress.errors);
				onProgress?.(data.progress);
				break;
			case 'done':
				end();
				settle({ results, errors, cancelled: false });
				break;
			case 'failed':
				end();
				fail(Object.assign(new Error(data.message), data.status === undefined ? {} : { status: data.status }));
				break;
		}
	};
	worker.onerror = event => {
		event.preventDefault();
		if (over) return;
		end();
		fail(new Error(`the sweep stopped${event.message ? `: ${event.message}` : ''}`));
	};
	worker.postMessage({
		type: 'job',
		job: {
			requests,
			runs,
			memoryAhead,
			character: character as unknown as Record<string, unknown>,
			playCounts,
			lengths: Object.fromEntries(requests.map(({ beatmapId }) => [beatmapId, lengthOf(beatmapId) ?? 0])),
		},
	} satisfies SweepIn);

	return {
		finished,
		cancel: () => {
			if (over) return;
			end();
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
