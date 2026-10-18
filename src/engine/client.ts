/**
 * Main-thread driver for the simulation worker.
 *
 * Charts are read here rather than in the worker so a single IndexedDB read
 * serves a whole set, and are streamed over in batches. Results arrive in
 * chunks, so a sweep of a large library fills the table progressively instead
 * of blocking on the whole run.
 */

import {
	beatmapStore,
	gameCharacter,
	playCountsSince,
	type CharacterRow,
} from '@osu-idle/addon-sdk';
import { medalXPMultiplier } from '@osu-idle/shared/achievements/catalogue';
import { hasUnlock } from '@osu-idle/shared/rebirth';
import { rateSteps } from '@osu-idle/shared/rate';
import createSimWorker from 'worker:./sim.worker';
import type {
	SimError,
	SimRequest,
	SimResult,
	WorkerRequest,
	WorkerResponse,
} from './protocol.js';

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
	requests: SimRequest[];
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
 * Pure, so this is testable without a beatmap store.
 */
export const planSweep = (sets: readonly PlannableSet[]): LibrarySurvey => {
	const survey: LibrarySurvey = {
		sets: sets.length,
		versions: 0,
		skippedMode: 0,
		duplicates: 0,
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
			seen.add(version.id);
			survey.requests.push({ setId: set.id, beatmapId: version.id });
		}
	}

	return survey;
};

/**
 * List every stored 4K difficulty worth simulating.
 *
 * Only metadata is read here. The charts themselves are loaded by the workers,
 * so a large library never has to sit in main-thread memory - a difficulty whose
 * chart turns out to be missing is reported as a per-map error instead.
 */
export const collectCharts = async (): Promise<LibrarySurvey> =>
	planSweep(await beatmapStore.sets());

/**
 * How many workers to run.
 *
 * The strain analysis is the sweep's real cost and is inherently per-attempt, so
 * the way to make a sweep faster is to run several at once. One core is left to
 * the game: it is still rendering and playing audio while this runs, and taking
 * every core makes the sweep marginally faster at the cost of the thing the
 * player is actually doing.
 */
const workerCount = (): number => {
	const cores = navigator.hardwareConcurrency || 2;
	return Math.max(1, Math.min(cores - 1, 8));
};

/** Deal jobs round-robin, so no worker gets all the marathon maps. */
const partition = <T>(items: readonly T[], parts: number): T[][] => {
	const slices: T[][] = Array.from({ length: parts }, () => []);
	items.forEach((item, i) => slices[i % parts]!.push(item));
	return slices;
};

/** The rates to simulate: every one the character's Speed upgrades unlock, but `excluded`. */
export const ratesFor = (speedUpgrades: number, excluded: readonly number[]): number[] =>
	rateSteps(speedUpgrades).filter(rate => !excluded.includes(rate));

/** Simulate the current character against every stored 4K chart. */
export const runSweep = async (
	batch: SimRequest[],
	{ runs = 3, characterId, excludedRates = [] }: {
		runs?: number; characterId?: number; excludedRates?: readonly number[];
	} = {},
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

	const slices = partition(batch, Math.min(workerCount(), batch.length || 1))
		.filter(slice => slice.length);
	const workers = slices.map(() => createSimWorker());

	const results: SimResult[] = [];
	const errors: SimError[] = [];
	// Progress is the sum across workers, each of which counts only its own slice.
	const doneByWorker = new Array<number>(workers.length).fill(0);
	let cancelled = false;
	let live = workers.length;

	let settle: (value: { results: SimResult[]; errors: SimError[]; cancelled: boolean }) => void;
	let fail: (reason: unknown) => void;
	const finished = new Promise<{ results: SimResult[]; errors: SimError[]; cancelled: boolean }>(
		(resolve, reject) => { settle = resolve; fail = reject; },
	);

	const retire = (worker: Worker) => {
		worker.terminate();
		if (--live === 0) settle({ results, errors, cancelled });
	};

	const abort = (reason: unknown) => {
		for (const worker of workers) worker.terminate();
		live = 0;
		fail(reason);
	};

	workers.forEach((worker, index) => {
		worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
			const message = event.data;
			switch (message.type) {
				case 'progress':
					results.push(...message.results);
					errors.push(...message.errors);
					doneByWorker[index] = message.done;
					onProgress?.({
						done: doneByWorker.reduce((sum, n) => sum + n, 0),
						total: batch.length,
						results: message.results,
						errors: message.errors,
					});
					break;
				case 'cancelled':
					cancelled = true;
					retire(worker);
					break;
				case 'done':
					retire(worker);
					break;
				case 'fatal':
					abort(new Error(message.message));
					break;
			}
		};

		worker.onerror = (event) => abort(new Error(event.message || 'simulation worker crashed'));

		worker.postMessage({
			type: 'run',
			character: character as unknown as Record<string, unknown>,
			divine: hasUnlock(Number(character.generation) || 1, 'DIVINE'),
			runs,
			rates: ratesFor(Number(character.speedUpgrades) || 0, excludedRates),
			playCounts,
			batch: slices[index]!,
			workerId: index,
		} satisfies WorkerRequest);
	});

	return {
		finished,
		cancel: () => {
			for (const worker of workers) {
				worker.postMessage({ type: 'cancel' } satisfies WorkerRequest);
			}
		},
	};
};

/** The game's production API, as baked into its client build. */
const API_URL = 'https://api.osu.idle.rhythmgamers.net';

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
		return medalXPMultiplier(held.map(medal => medal.id));
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
			lengthSec: version.total_length,
			bpm: version.bpm,
			objects: version.objects,
		});
	}
	return index;
};
