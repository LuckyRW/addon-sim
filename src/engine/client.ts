/**
 * Main-thread driver for the simulation workers.
 *
 * Workers take whole beatmapsets from one queue, so a set's charts are read
 * once, a worker that finishes early takes more, and one that dies or stalls
 * costs the sweep a single map. Results arrive a rate at a time, so a sweep of
 * a large library fills the table progressively instead of blocking on the
 * whole run.
 */

import {
	beatmapStore,
	gameCharacter,
	playCountsSince,
	type CharacterRow,
} from '@oss-idle/addon-sdk';
import { medalXPMultiplier, type MedalCatalogue } from '@oss-idle/shared/achievements/catalogue';
import { MEDALS } from '@oss-idle/shared/rulesets/mania/4k/medals';
import { hasUnlock } from '@oss-idle/shared/rebirth';
import { rateSteps } from '@oss-idle/shared/rate';
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

/**
 * List every stored 4K difficulty worth simulating.
 *
 * Only metadata is read here. The charts are read a set at a time as each is
 * handed to a worker, so a large library never has to sit in main-thread memory
 * - a difficulty whose chart turns out to be missing is reported as a per-map
 * error instead.
 */
export const collectCharts = async (ranked?: ReadonlySet<number>): Promise<LibrarySurvey> =>
	planSweep(await beatmapStore.sets(), ranked);

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

/**
 * A worker silent this long is stuck on its map. A worker reports every rate,
 * and one rate of a marathon at 10 runs takes seconds, so this is far past any
 * real map.
 */
const STALL_MS = 60_000;

/** The rates to simulate: every one the character's Speed upgrades unlock, but `excluded`. */
export const ratesFor = (speedUpgrades: number, excluded: readonly number[]): number[] =>
	rateSteps(speedUpgrades).filter(rate => !excluded.includes(rate));

type Job = { setId: number; maps: SimRequest[] };

/** Simulate the current character against `requests`, a set at a time per worker. */
export const runSweep = async (
	requests: SimRequest[],
	{ runs = 3, characterId, memoryAhead = 0 }: {
		runs?: number;
		characterId?: number;
		/** Plays added to each map's count before seeding memory - see `PLAYS_PER_MAP`. */
		memoryAhead?: number;
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
	const divine = hasUnlock(Number(character.generation) || 1, 'DIVINE');

	const queue: Job[] = [];
	const bySet = new Map<number, Job>();
	for (const request of requests) {
		const job = bySet.get(request.setId);
		if (job) job.maps.push(request);
		else {
			const fresh = { setId: request.setId, maps: [request] };
			bySet.set(request.setId, fresh);
			queue.push(fresh);
		}
	}

	const results: SimResult[] = [];
	const errors: SimError[] = [];
	let done = 0;
	/** Whether any worker has said anything - if none ever does, the bundle itself is broken. */
	let anyHeard = false;
	let over = false;

	let settle: (value: { results: SimResult[]; errors: SimError[]; cancelled: boolean }) => void;
	let fail: (reason: unknown) => void;
	const finished = new Promise<{ results: SimResult[]; errors: SimError[]; cancelled: boolean }>(
		(resolve, reject) => { settle = resolve; fail = reject; },
	);

	type Slot = { worker: Worker; pending: SimRequest[]; heardAt: number };
	const slots = new Set<Slot>();

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

	const finishMap = (slot: Slot, beatmapId: number, message?: string) => {
		const index = slot.pending.findIndex(map => map.beatmapId === beatmapId);
		if (index < 0) return;
		const [map] = slot.pending.splice(index, 1);
		done++;
		report(undefined, message === undefined ? undefined : { setId: map!.setId, beatmapId, message });
	};

	const end = (cancelled: boolean) => {
		over = true;
		clearInterval(watchdog);
		for (const slot of slots) slot.worker.terminate();
		slots.clear();
		settle({ results, errors, cancelled });
	};

	const next = async (slot: Slot): Promise<void> => {
		const job = queue.shift();
		if (!job) {
			slot.worker.terminate();
			slots.delete(slot);
			if (!slots.size && !over) end(false);
			return;
		}
		slot.pending = [...job.maps];
		slot.heardAt = Date.now();
		let charts: Record<number, string> | undefined;
		let unreadable: unknown;
		try {
			charts = await beatmapStore.charts(job.setId);
		} catch (e) {
			unreadable = e;
		}
		if (over || !slots.has(slot)) return;
		if (!charts) {
			// The whole set is unreadable - report each difficulty and move on.
			const reason = unreadable instanceof Error ? unreadable.message : String(unreadable);
			for (const { beatmapId } of job.maps) finishMap(slot, beatmapId, reason);
			return next(slot);
		}
		slot.worker.postMessage({
			type: 'job',
			setId: job.setId,
			charts,
			character: character as unknown as Record<string, unknown>,
			divine,
			runs,
			maps: job.maps.map(({ beatmapId, rates, mods, minutes }) => ({
				beatmapId, rates, mods, minutes, timesPlayed: (playCounts[beatmapId] ?? 0) + memoryAhead,
			})),
		} satisfies WorkerRequest);
	};

	/**
	 * A worker crashed or stalled. The map it was on is the culprit and is
	 * skipped; the rest of its set goes back on the queue for a fresh worker.
	 */
	const lose = (slot: Slot, reason: string) => {
		slot.worker.terminate();
		slots.delete(slot);
		if (over) return;
		if (!anyHeard) {
			over = true;
			clearInterval(watchdog);
			for (const other of slots) other.worker.terminate();
			fail(new Error(reason));
			return;
		}
		const [culprit, ...rest] = slot.pending;
		if (culprit) finishMap(slot, culprit.beatmapId, reason);
		if (rest.length) queue.unshift({ setId: rest[0]!.setId, maps: rest });
		spawn();
	};

	const spawn = () => {
		const slot: Slot = { worker: createSimWorker(), pending: [], heardAt: Date.now() };
		slots.add(slot);
		slot.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
			if (over) return;
			const message = event.data;
			anyHeard = true;
			slot.heardAt = Date.now();
			switch (message.type) {
				case 'result':
					report(message.result);
					break;
				case 'map':
					finishMap(slot, message.beatmapId, message.error);
					break;
				case 'idle':
					for (const map of [...slot.pending]) finishMap(slot, map.beatmapId, 'not simulated');
					void next(slot);
					break;
			}
		};
		slot.worker.onerror = (event) => {
			event.preventDefault();
			lose(slot, `simulation worker crashed${event.message ? `: ${event.message}` : ''}`);
		};
		void next(slot);
	};

	const watchdog = setInterval(() => {
		const now = Date.now();
		for (const slot of [...slots]) {
			if (now - slot.heardAt > STALL_MS) lose(slot, `no progress for ${STALL_MS / 1000}s`);
		}
	}, 5000);

	const count = Math.min(workerCount(), queue.length);
	if (!count) end(false);
	for (let i = 0; i < count; i++) spawn();

	return {
		finished,
		cancel: () => { if (!over) end(true); },
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
 * Ids of the difficulties ranked on the game server, or `undefined` when the
 * server cannot be reached.
 *
 * Only these pay an account character XP: the server simulates a play on a
 * live difficulty and answers any other as unranked, which the client plays
 * locally for no XP. The intro set is in the catalog but is not live.
 */
export const rankedDifficulties = async (): Promise<Set<number> | undefined> => {
	try {
		const res = await fetch(`${API_URL}/v1/beatmap/catalog`);
		if (!res.ok) return undefined;
		const { intro, beatmaps } = await res.json() as {
			intro?: { id: number };
			beatmaps: { id: number; versions: { id: number }[] }[];
		};
		return new Set(beatmaps
			.filter(set => set.id !== intro?.id)
			.flatMap(set => set.versions.map(version => version.id)));
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
