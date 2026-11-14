/**
 * 7K tracker: 7K has no sim API, so maps are measured from real plays.
 *
 * Every 7K play is recorded off the game's socket, from the server's own
 * messages (`shared/play.ts`):
 * - `play:start` names the play's map, rate, mods and ruleset, and how tired
 *   (`fatigue`) and how warmed up (`warmupBar`) the character starts it;
 * - `play:result` says whether it failed, and per skill the XP gained and the
 *   level before the play (`gains[].fromLevel`).
 * The game keeps no failed play locally, so this record is the only one of
 * them.
 *
 * Base XP undoes the server's `applyXpRules` (`server/rulesets/mania/xpRules.ts`):
 * mindblock, fatigue, medals, genetics and mods, and the skill's own multiplier
 * from upgrades, overdrive and prestige (`skillXPMultiplier`). Left in: the
 * accuracy bonus for a first X, and LN genes' bonus on LN maps.
 *
 * Constants are copied from the game's source (Nov 8 2026): the add-on is built
 * against oss!idle 1.3, which has no 7K.
 */

import { gameDb, type CharacterRow } from '@oss-idle/addon-sdk';
import cubic_bezier from '@oss-idle/shared/math/cubic_bezier';
import lerp from '@oss-idle/shared/math/lerp';
import { modsKey, parseMods, type Mod } from '@oss-idle/shared/mods';

export const RULESET_7K = 'mania7k';
export const SKILLS_7K = ['accuracy', 'speed', 'stamina', 'jacks', 'independence', 'ln', 'technical', 'focus', 'sv', 'memory'] as const;
const PHYSICAL = new Set<string>(['speed', 'stamina', 'jacks', 'ln']);
const MINDBLOCK = new Set<string>(SKILLS_7K.filter(s => !PHYSICAL.has(s) && s !== 'memory'));

// ---- the server's multipliers ----

/** `upgrades.ts` */
const overdriveMultiplier = (overdrive: number) => Math.max(1, Math.min(overdrive, 2.5 * overdrive ** Math.log10(2)));
const skillXPMultiplier = (upgrades: number, overdrive: number, prestige: number) =>
	(1 + 0.1 * upgrades * overdriveMultiplier(overdrive)) * 1.1 ** prestige;

/** `mindblock.ts`: a map's plays among the character's last 50 in 24 hours. */
const BLOCK_CB = cubic_bezier(.6, 0, .6, 1);
const mindblockFactor = (recentPlays: number) => lerp(1, 0.25, BLOCK_CB(Math.min(1, recentPlays / 25)));
const RECENT_LIMIT = 50;
const RECENT_MS = 24 * 3600 * 1000;

/** `fatigue.ts` */
const fatigueXp = (level: number) => lerp(1, 0.05, level);

/** `mods.ts` and `7k/modXp.ts`: NF and other unranked mods earn nothing, EZ half, HR ×1.1 accuracy. */
const UNRANKED: Mod[] = ['NF', 'AT' as Mod];
const modXp = (mods: readonly Mod[], skill: string) => {
	if (mods.some(m => UNRANKED.includes(m))) return 0;
	return (mods.includes('EZ') ? 0.5 : 1) * (skill === 'accuracy' && mods.includes('HR') ? 1.1 : 1);
};

/** `7k/genes.ts`: the ring, each tree's XP gene, and which skill each gene is on. */
const RING = ['accuracy', 'ln', 'independence', 'speed', 'stamina', 'jacks', 'technical', 'sv', 'memory', 'focus'];
const TREES: Record<string, { xp: string; genes: string[] }> = {
	accuracy: { xp: 'talented', genes: ['talented', 'perfectPitch', 'calibrated', 'cleanStart', 'perfectStart', 'marvelousStart', 'learner', 'busyHands', 'outerFingers', 'chordCohesion'] },
	ln: { xp: 'tailChaser', genes: ['tailChaser', 'holdout', 'lnSpecialist', 'lightTouch', 'shieldBreaker', 'patience', 'letGoTogether', 'cleanLift', 'lnFlow', 'holdOn'] },
	independence: { xp: 'ambidextrous', genes: ['ambidextrous', 'twoMinds', 'splitFocus', 'handsApart', 'fullHands', 'looseFingers', 'firmGrip', 'inversePress', 'composure', 'safeFumble', 'regroup'] },
	speed: { xp: 'adrenaline', genes: ['adrenaline', 'rush', 'quickFingers', 'cleanStreams', 'pacing', 'secondHand', 'ceiling', 'topSpeed', 'comfortZone', 'rollingHands', 'chordPress'] },
	stamina: { xp: 'marathoner', genes: ['marathoner', 'longHaul', 'slowBurn', 'secondBreath', 'chordEndurance', 'deepLungs', 'restStops', 'lowGear', 'ironWrists', 'longSets', 'wellRested', 'quickWarmup', 'stayWarm'] },
	jacks: { xp: 'hammer', genes: ['hammer', 'anvil', 'anchor', 'bounce', 'freshFingers', 'shortRest', 'jackCeiling', 'easyJacks', 'chordjack', 'pump', 'trainedFingers', 'strongMiddle'] },
	technical: { xp: 'sightReader', genes: ['sightReader', 'secondGlance', 'patternSense', 'steadyEyes', 'rhythmSense', 'offBeat', 'twoRhythms', 'shapeReading', 'trillHands', 'settleIn', 'familiarShapes', 'graceNotes'] },
	sv: { xp: 'waveRider', genes: ['waveRider', 'undertow', 'speedReader', 'brake', 'lateLook', 'dejaVu', 'looseMatch', 'oldNews', 'shakeItOff', 'softLanding', 'svSurfer'] },
	memory: { xp: 'thoroughLearner', genes: ['thoroughLearner', 'prodigy', 'beatmapStudy', 'learnFromFailure', 'educatedGuess', 'mapperAdvantage', 'longMemory', 'personalFavorites', 'muscleMemory', 'accurateMemory'] },
	focus: { xp: 'deepFocus', genes: ['deepFocus', 'inTheZone', 'steady', 'smallChokes', 'cleanReleases', 'unshakeable', 'thickSkin', 'flowState', 'clutch', 'attentionSpan', 'slowFade', 'steadyHands', 'anchored', 'secondWind', 'freshStart'] },
};

type Genetics = { picks?: { skill: string }[]; genes?: Record<string, number>; genetic?: string };

/** `genetics.ts` `geneticsXpMultiplier`: the picks' strength, the XP gene at it, and +5% a tier held. */
export const geneticsMultipliers = (json: string): Record<string, number> => {
	let g: Genetics = {};
	try { g = json ? JSON.parse(json) as Genetics : {}; } catch { /* none */ }
	const picked = g.picks?.map(p => p.skill) ?? (g.genetic ? [g.genetic] : []);
	const genes = g.genes ?? {};
	const strength = (skill: string) => {
		const at = RING.indexOf(skill), n = RING.length;
		return picked.reduce((sum, p) => sum + (p === skill ? 1 : p === RING[(at + 1) % n] || p === RING[(at + n - 1) % n] ? 0.5 : 0), 0);
	};
	return Object.fromEntries(Object.entries(TREES).map(([skill, tree]) => {
		const power = strength(skill);
		const tiers = tree.genes.reduce((sum, id) => sum + (genes[id] ?? 0), 0);
		return [skill, 1 + 0.1 * power + 0.05 * (genes[tree.xp] ?? 0) * power + 0.05 * tiers];
	}));
};

// ---- the character ----

export type Progress7k = {
	levels: Record<string, number>;
	own: Record<string, number>;
	genetics: Record<string, number>;
	speedUpgrades: number;
	levelSum: number;
};

/** The character's 7K progress: its own table, `character_mania7k`. */
export const progress7k = async (characterId: number): Promise<Progress7k | undefined> => {
	const row = await gameDb.first<Record<string, number | string>>('SELECT * FROM character_mania7k WHERE characterId = ?', [characterId]).catch(() => undefined);
	if (!row) return undefined;
	const num = (key: string) => Number(row[key]) || 0;
	const levels = Object.fromEntries(SKILLS_7K.map(s => [s, num(s)]));
	return {
		levels,
		own: Object.fromEntries(SKILLS_7K.map(s => [s, skillXPMultiplier(num(`${s}Upgrades`), num(`${s}Overdrive`), num(`${s}Prestige`))])),
		genetics: geneticsMultipliers(String(row.geneticsJson ?? '')),
		speedUpgrades: num('speedUpgrades'),
		levelSum: Object.values(levels).reduce((a, b) => a + b, 0),
	};
};

// ---- the record ----

export type Attempt = {
	token: string;
	characterId: number;
	beatmapId: number;
	rate: number;
	/** `modsKey` */
	mods: string;
	startedAt: number;
	/** 0 rested to 1 exhausted, as the server played it */
	fatigue: number;
	/** the warm-up bar at the start, 0 cold to 1 exhausted */
	bar?: number;
	failed: boolean;
	/** XP given, per skill */
	gains: Record<string, number>;
	/** each skill's level before the play */
	levels: Record<string, number>;
	levelSum: number;
	own: Record<string, number>;
	genetics: Record<string, number>;
};

const STORE_KEY = 'oss-idle-sim:7k-attempts';
const MAX_ATTEMPTS = 6000;

/** A character's recorded plays, or every one when none are its: the ids the recorder and the panel read may differ. */
export const attemptsOf = (characterId: number): Attempt[] => {
	const all = readAttempts();
	const own = all.filter(a => a.characterId === characterId);
	return own.length ? own : all;
};

export const readAttempts = (): Attempt[] => {
	try { return JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]') as Attempt[]; } catch { return []; }
};
const writeAttempts = (all: Attempt[]): boolean => {
	try { localStorage.setItem(STORE_KEY, JSON.stringify(all.slice(-MAX_ATTEMPTS))); return true; } catch { return false; }
};

/** The medals' multiplier: the same on every skill, so it changes no ranking; typed in by the player. */
export const MEDALS_KEY = 'oss-idle-sim:7k-medals';
export const medals7k = (): number => {
	try { return Number(localStorage.getItem(MEDALS_KEY)) || 1; } catch { return 1; }
};

type Started = { characterId: number; beatmapId: number; rate: number; mods: string; startedAt: number; fatigue: number; bar?: number; progress?: Progress7k };

/** What the recorder has seen, for the 7K tab to show. */
export const recorderStatus = {
	sockets: 0,
	/** when it last saw a play message, of any ruleset */
	lastMessage: 0,
	/** 7K plays it saw start and is waiting on */
	waiting: 0,
	recorded: 0,
	/** the last thing that stopped a play being recorded */
	problem: '',
};

/**
 * Record 7K plays off the game's socket. `characterId` names whose plays these are.
 * Returns what stops it.
 */
export const recordPlays = (characterId: () => number | undefined, onAttempt: () => void): (() => void) => {
	const started = new Map<string, Started>();
	const done = new Set<string>();
	const hooked = new WeakSet<WebSocket>();

	let lastId: number | undefined;
	const onMessage = (e: MessageEvent) => {
		if (typeof e.data !== 'string' || !e.data.includes('"play:')) return;
		let msg: { type?: string; token?: string; result?: Record<string, unknown> };
		try { msg = JSON.parse(e.data); } catch { return; }
		recorderStatus.lastMessage = Date.now();
		const r = msg.result as { status?: string; ruleset?: string; ok?: boolean; failed?: boolean } | undefined;
		console.info(`[oss!idle sim] socket: ${msg.type}${r?.status ? ` ${r.status}` : ''}${r?.ruleset ? ` ${r.ruleset}` : ''}${r?.ok !== undefined ? ` ok=${r.ok}` : ''}${r?.failed !== undefined ? ` failed=${r.failed}` : ''}${msg.token ? ` token=${String(msg.token).slice(0, 6)}` : ''}`);
		if (msg.type === 'play:start' && msg.result?.status === 'ranked' && msg.result.ruleset === RULESET_7K && !msg.result.joined) {
			const r = msg.result as { token: string; beatmapId: number; rate: number; mods?: Mod[]; fatigue?: number; warmupBar?: number };
			const id = characterId() ?? lastId;
			if (id === undefined) { recorderStatus.problem = 'a 7K play started before the character was known'; console.warn('[oss!idle sim] 7K play not recorded: no character yet'); return; }
			lastId = id;
			const play: Started = { characterId: id, beatmapId: r.beatmapId, rate: r.rate, mods: modsKey(r.mods ?? []), startedAt: Date.now(), fatigue: r.fatigue ?? 0, bar: r.warmupBar };
			started.set(r.token, play);
			recorderStatus.waiting = started.size;
			void progress7k(id).then(p => {
				play.progress = p;
				if (!p) recorderStatus.problem = 'no 7K progress row (character_mania7k) for this character: levels and multipliers come from the result alone';
			});
		} else if (msg.type === 'play:result' && msg.token && msg.result?.ok === true) {
			const play = started.get(msg.token);
			if (!play || done.has(msg.token)) return;
			recorderStatus.waiting = started.size - 1;
			done.add(msg.token);
			started.delete(msg.token);
			const gains = (msg.result.gains ?? []) as { skill: string; gained: number; fromLevel: number }[];
			const levels = { ...play.progress?.levels, ...Object.fromEntries(gains.map(g => [g.skill, g.fromLevel])) };
			const all = readAttempts();
			all.push({
				token: msg.token,
				...play,
				failed: msg.result.failed === true,
				gains: Object.fromEntries(gains.filter(g => g.gained > 0).map(g => [g.skill, g.gained])),
				levels,
				levelSum: Object.values(levels).reduce((a, b) => a + Number(b), 0),
				own: play.progress?.own ?? {},
				genetics: play.progress?.genetics ?? {},
			});
			delete (all[all.length - 1] as Partial<Started>).progress;
			const kept = writeAttempts(all);
			if (!kept) { recorderStatus.problem = 'the browser refused to store more: storage is full'; console.warn('[oss!idle sim] 7K play not stored: localStorage full'); }
			else { recorderStatus.recorded++; recorderStatus.problem = ''; console.info(`[oss!idle sim] 7K play recorded: ${play.beatmapId} x${play.rate}${msg.result.failed ? ' (failed)' : ''}`); }
			onAttempt();
		} else if (msg.type === 'play:aborted' && msg.token) {
			started.delete(msg.token);
		}
	};

	const hook = (ws: WebSocket) => {
		if (hooked.has(ws)) return;
		hooked.add(ws);
		recorderStatus.sockets++;
		console.info(`[oss!idle sim] listening on socket ${ws.url.replace(/\?.*/, '')}`);
		ws.addEventListener('message', onMessage);
	};
	// The game's socket is found the next time it sends; a reconnect's when it sends in turn.
	// Other add-ons wrap `send` too, and one that puts back what it found drops this wrapper:
	// it is checked every few seconds and put on again over whatever is there.
	const proto = WebSocket.prototype;
	const original = proto.send;
	let ours: WebSocket['send'] | undefined;
	const arm = () => {
		if (proto.send === ours) return;
		const under = proto.send;
		ours = function (this: WebSocket, ...args: Parameters<WebSocket['send']>) {
			hook(this);
			return under.apply(this, args);
		};
		proto.send = ours;
	};
	arm();
	const timer = setInterval(arm, 3000);
	(globalThis as { ossSim7k?: unknown }).ossSim7k = recorderStatus;
	return () => {
		clearInterval(timer);
		if (proto.send === ours) proto.send = original;
	};
};

// ---- what an attempt was worth ----

/** Base XP per skill: the server's multipliers taken back out. Mindblock is counted off the passes before it. */
export const baseOf = (attempt: Attempt, before: readonly Attempt[]): Record<string, number> => {
	const recent = before
		.filter(a => !a.failed && a.characterId === attempt.characterId && a.startedAt < attempt.startedAt && a.startedAt >= attempt.startedAt - RECENT_MS)
		.slice(-RECENT_LIMIT)
		.filter(a => a.beatmapId === attempt.beatmapId).length;
	const block = mindblockFactor(recent);
	const tired = fatigueXp(attempt.fatigue);
	const mods = parseMods(attempt.mods);
	const medals = medals7k();
	return Object.fromEntries(Object.entries(attempt.gains).map(([skill, xp]) => {
		const by = (attempt.own[skill] || 1) * (attempt.genetics[skill] || 1) * medals * modXp(mods, skill)
			* (MINDBLOCK.has(skill) ? block : 1) * (PHYSICAL.has(skill) ? tired : 1);
		return [skill, by > 0 ? xp / by : 0];
	}));
};

export const totalOf = (xp: Record<string, number>) => Object.values(xp).reduce((a, b) => a + b, 0);

// ---- what is left to test ----

export type RateStatus = 'tested' | 'failed' | 'too easy' | 'too hard' | 'untested';

/** Where a map with these mods stands: the rule-outs, and its attempts by rate. */
export type MapTests = {
	byRate: Map<number, Attempt[]>;
	/** Rates below this gave 0 XP once: slower is only easier. */
	easyAt?: number;
	/** Rates above this failed since the last level-up. */
	hardAt?: number;
};

export const testsOf = (attempts: readonly Attempt[], levelSum: number): Map<string, MapTests> => {
	const out = new Map<string, MapTests>();
	for (const a of attempts) {
		const key = `${a.beatmapId}|${a.mods}`;
		let t = out.get(key);
		if (!t) out.set(key, t = { byRate: new Map() });
		const list = t.byRate.get(a.rate) ?? [];
		list.push(a);
		t.byRate.set(a.rate, list);
		if (!a.failed && totalOf(a.gains) <= 0) t.easyAt = Math.max(t.easyAt ?? -Infinity, a.rate);
		// a fail rules out the faster rates until a skill levels up
		if (a.failed && a.levelSum >= levelSum) t.hardAt = Math.min(t.hardAt ?? Infinity, a.rate);
	}
	return out;
};

export const statusOf = (t: MapTests | undefined, rate: number): RateStatus => {
	const here = t?.byRate.get(rate);
	if (here?.some(a => !a.failed)) return 'tested';
	if (t?.easyAt !== undefined && rate < t.easyAt) return 'too easy';
	if (t?.hardAt !== undefined && rate > t.hardAt) return 'too hard';
	if (here?.length) return 'failed';
	return 'untested';
};

/** Every third rate, x1 and the fastest: addon-sim's screening grid (`screenRates`). */
export const screenRates = (rates: readonly number[]): number[] =>
	rates.length <= 5 ? [...rates] : rates.filter((rate, i) => i % 3 === 0 || i === rates.length - 1 || rate === 1);

export { modsKey, parseMods };
