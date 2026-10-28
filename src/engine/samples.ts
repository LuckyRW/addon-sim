/**
 * Where a simulated play comes from, cheapest first: the plays this browser
 * already asked the sim API for (IndexedDB), the oss!idle sim cache (one play
 * per rounded skillset, from everyone's sim API calls), then the sim API itself.
 *
 * Every play is kept as a {@link Sample}: one random play, its XP as the add-on
 * reads it everywhere else - before mindblock, fatigue, medals and mods.
 */

import type { ApiSimulation, ApiSkillState } from '@oss-idle/shared/apiV2';
import { fatigueLevel, fatigueXp, keptShare, warmup } from '@oss-idle/shared/fatigue';
import { modsKey, type Mod } from '@oss-idle/shared/mods';
import { hasUnlock } from '@oss-idle/shared/rebirth';
import { modXpMultipliers } from '@oss-idle/shared/rulesets/mania/4k/modXp';
import { PHYSICAL_SKILLS, Skills, type SkillName } from '@oss-idle/shared/rulesets/mania/4k/skills';
import { skillXPMultiplier } from '@oss-idle/shared/upgrades';
import { playLevelOf, xpGivesLevel, xpToLevel } from '@oss-idle/shared/xp';

/** One simulated play. */
export type Sample = {
	/** Per-skill XP before mindblock, fatigue, medals and mods; 0 for a fail. */
	xp: Record<string, number>;
	pp: number;
	accuracy: number;
	grade: string;
	passed: boolean;
	/** Where it failed, in seconds at its rate. */
	failSeconds?: number;
	/** Minutes it strained the physical skills for: what fatigue counts. */
	strained: number;
};

/** A character as the sim API takes it. */
export type CharacterState = {
	generation: number;
	skills: Record<SkillName, Required<ApiSkillState>>;
};

const num = (value: unknown) => (typeof value === 'number' ? value : 0);

/** The `character` row, as the sim API takes it. */
export const stateOf = (row: Record<string, unknown>): CharacterState => ({
	generation: num(row.generation) || 1,
	skills: Object.fromEntries(Skills.map(name => [name, {
		level: num(row[name]),
		xp: num(row[`${name}XP`]),
		lifetime_xp: num(row[`${name}LifetimeXp`]),
		prestige: num(row[`${name}Prestige`]),
		upgrades: num(row[`${name}Upgrades`]),
		overdrive: num(row[`${name}Overdrive`]),
	}])) as CharacterState['skills'],
});

const PHYSICAL = new Set<string>(PHYSICAL_SKILLS);

/**
 * Each skill's play level `minutes` of fatigue in, as the sim tires it: a
 * physical skill keeps a share of the xp behind its level and of its lifetime
 * xp. The sim cache keys its plays by these (its `currentLevels`).
 */
export const playLevels = (state: CharacterState, minutes: number): Record<SkillName, number> => {
	const fatigue = fatigueLevel(minutes);
	const warm = warmup(minutes, state.skills.stamina.upgrades);
	return Object.fromEntries(Skills.map(name => {
		const s = state.skills[name];
		const rested = playLevelOf(s.level, s.xp, s.lifetime_xp, s.prestige);
		const kept = PHYSICAL.has(name) ? keptShare(rested, fatigue, warm) : 1;
		if (kept >= 1) return [name, rested];
		const tired = xpGivesLevel((xpToLevel(s.level) + s.xp) * kept);
		return [name, playLevelOf(tired.level, tired.xp, s.lifetime_xp * kept, s.prestige)];
	})) as Record<SkillName, number>;
};

/** Rounded as the sim cache keys them: steps of 1 below level 100, of 0.5 from 100. */
const rounded = (level: number) => (level < 100 ? Math.round(level) : Math.round(level * 2) / 2);

/** The skillset a play is kept under: its rounded play levels and whether the generation has DIVINE. */
export const skillsetKey = (state: CharacterState, minutes: number): string => {
	const levels = playLevels(state, minutes);
	return `${Skills.map(name => rounded(levels[name])).join(',')}|${hasUnlock(state.generation, 'DIVINE') ? 1 : 0}`;
};

/** Undo XP's multipliers: `by` maps a skill to what it was multiplied by. */
const divided = (xp: Record<string, number>, by: (skill: string) => number) =>
	Object.fromEntries(Object.entries(xp).map(([skill, value]) => {
		const factor = by(skill);
		return [skill, factor > 0 ? value / factor : 0];
	}));

/** A sim API answer, `minutes` of fatigue in: its XP has fatigue and mods applied. */
export const fromApi = (answer: ApiSimulation, minutes: number): Sample => {
	const tired = fatigueXp(fatigueLevel(minutes));
	const modded = modXpMultipliers(answer.mods) as Record<string, number>;
	return {
		xp: divided(answer.xp, skill => (modded[skill] ?? 1) * (PHYSICAL.has(skill) ? tired : 1)),
		pp: answer.pp,
		accuracy: answer.accuracy,
		grade: answer.rank,
		passed: answer.passed,
		failSeconds: answer.fail_seconds,
		strained: answer.strained_minutes,
	};
};

const CACHE_URL = 'https://cache.oss.idle.rhythmgamers.net';

/** The cache keeps memory's plays only on maps never played or played this often. */
const LEARNED_PLAYS = 68;

/** Whether the cache can answer for a map played `plays` times: undefined when it keeps nothing for it. */
export const learnedOf = (plays: number): boolean | undefined =>
	plays <= 0 ? false : plays >= LEARNED_PLAYS ? true : undefined;

/** A cached play's place in its skillset. */
export const cacheKey = (beatmapId: number, rate: number, mods: readonly Mod[], learned: boolean) =>
	`${beatmapId}@${rate}@${modsKey(mods)}@${learned ? 1 : 0}`;

/** The sim version the cache keeps, or undefined when it can't be reached or keeps none yet. */
export const cachedSimVersion = async (): Promise<string | undefined> => {
	try {
		const res = await fetch(`${CACHE_URL}/healthz`);
		if (!res.ok) return undefined;
		const { sim_version } = await res.json() as { sim_version?: string };
		return sim_version || undefined;
	} catch {
		return undefined;
	}
};

/**
 * Every play the cache keeps of this character `minutes` of fatigue in, on
 * `beatmapIds`, by {@link cacheKey}. Empty when the cache can't be reached: it
 * only saves sim API calls. Its XP is kept at x1, the skill's own multiplier
 * and fatigue taken out, mods left in.
 */
export const cachedPlays = async (
	state: CharacterState,
	minutes: number,
	beatmapIds: readonly number[],
): Promise<Map<string, Sample>> => {
	const plays = new Map<string, Sample>();
	try {
		const res = await fetch(`${CACHE_URL}/lookup`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ generation: state.generation, levels: playLevels(state, minutes), beatmap_ids: beatmapIds }),
		});
		if (!res.ok) return plays;
		const { columns, rows } = await res.json() as { columns: string[]; rows: unknown[][] };
		const at = Object.fromEntries(columns.map((name, i) => [name, i]));
		// a cache that doesn't keep strain can't stand in for a play
		if (at.strained_minutes === undefined) return plays;
		for (const row of rows) {
			const get = <T>(name: string) => row[at[name]!] as T;
			const mods = get<Mod[]>('mods');
			const modded = modXpMultipliers(mods) as Record<string, number>;
			const xp = Object.fromEntries(Object.entries(get<Record<string, number>>('xp')).map(([skill, value]) => {
				const s = state.skills[skill as SkillName];
				const own = s ? skillXPMultiplier(s.upgrades, s.overdrive, s.prestige) : 1;
				return [skill, value * own / (modded[skill] ?? 1)];
			}));
			plays.set(cacheKey(get('beatmap_id'), get('rate'), mods, get('learned')), {
				xp,
				pp: get('pp'),
				accuracy: get('accuracy'),
				grade: get('rank'),
				passed: get('passed'),
				failSeconds: get<number | null>('fail_seconds') ?? undefined,
				strained: get('strained_minutes'),
			});
		}
	} catch {
		// the cache is a shortcut, never a requirement
	}
	return plays;
};

/** How long a play this browser asked for is kept. */
const KEEP_MS = 7 * 24 * 3600_000;
/** The most plays kept of one variant: Settings' most runs. */
export const MAX_SAMPLES = 10;

type Kept = { at: number; samples: Sample[] };

let opened: Promise<IDBDatabase> | undefined;
const database = () => opened ??= new Promise<IDBDatabase>((resolve, reject) => {
	const request = indexedDB.open('oss-idle-sim', 1);
	request.onupgradeneeded = () => request.result.createObjectStore('plays');
	request.onsuccess = () => resolve(request.result);
	request.onerror = () => {
		opened = undefined;
		reject(request.error);
	};
});

const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
	tx.oncomplete = () => resolve();
	tx.onerror = () => reject(tx.error);
	tx.onabort = () => reject(tx.error);
});

/**
 * The plays this browser asked the sim API for, by a key naming the sim
 * version, the skillset, the map, rate, mods and memory's plays of it. A play
 * kept past {@link KEEP_MS} is dropped, as its chart may have changed since.
 */
export const localPlays = {
	async read(keys: readonly string[]): Promise<Map<string, Sample[]>> {
		const found = new Map<string, Sample[]>();
		try {
			const tx = (await database()).transaction('plays');
			const store = tx.objectStore('plays');
			const fresh = Date.now() - KEEP_MS;
			for (const key of new Set(keys)) {
				const request = store.get(key);
				request.onsuccess = () => {
					const kept = request.result as Kept | undefined;
					if (kept && kept.at >= fresh) found.set(key, kept.samples);
				};
			}
			await done(tx);
		} catch {
			// no IndexedDB (a private window): every play comes from the cache or the API
		}
		return found;
	},

	async add(key: string, sample: Sample): Promise<void> {
		try {
			const tx = (await database()).transaction('plays', 'readwrite');
			const store = tx.objectStore('plays');
			const request = store.get(key);
			request.onsuccess = () => {
				const kept = request.result as Kept | undefined;
				const samples = kept && kept.at >= Date.now() - KEEP_MS ? kept.samples : [];
				// the day it was first played stays: a chart that changed since goes with it
				store.put({ at: kept?.at ?? Date.now(), samples: [...samples, sample].slice(-MAX_SAMPLES) }, key);
			};
			await done(tx);
		} catch {
			// as in read
		}
	},

	/** Drop every play past {@link KEEP_MS}. */
	async prune(): Promise<void> {
		try {
			const tx = (await database()).transaction('plays', 'readwrite');
			const fresh = Date.now() - KEEP_MS;
			const cursor = tx.objectStore('plays').openCursor();
			cursor.onsuccess = () => {
				const at = cursor.result;
				if (!at) return;
				if ((at.value as Kept).at < fresh) at.delete();
				at.continue();
			};
			await done(tx);
		} catch {
			// as in read
		}
	},
};
