/**
 * The last play of a difficulty at a rate and mods, in base XP per second.
 *
 * The game keeps each play's XP in `score_xp.gains` as awarded: after the
 * skill's own multiplier (upgrades, overdrive, prestige), medals, mods and
 * mindblock. Base XP takes them back out. Mindblock is read off the plays
 * before it, as the server counts them (the last 50 in 24 hours); the
 * multipliers, medals and levels are what this add-on noted when the play came
 * in ({@link notePlays}). A play from before that has no note: its multipliers
 * are taken as they are now, and its level is unknown.
 *
 * Fatigue stays in: the strain it played at is kept on the server.
 */

import { gameDb, type CharacterRow } from '@oss-idle/addon-sdk';
import { parseMods } from '@oss-idle/shared/mods';
import { modXpMultipliers } from '@oss-idle/shared/rulesets/mania/4k/modXp';
import { MINDBLOCK_SKILLS } from '@oss-idle/shared/rulesets/mania/4k/skills';
import { mindblockFactor } from '../farm/metrics.js';
import { medalMultiplier } from './client.js';
import { ownMultipliers, stateOf } from './samples.js';

const MINDBLOCK = new Set<string>(MINDBLOCK_SKILLS);
const NOTES_KEY = 'oss-idle-sim:play-notes';
/** Plays noted at most: the oldest go first. */
const MAX_NOTES = 5000;
/** The server's mindblock window. */
const RECENT_PLAYS = 50;
const RECENT_MS = 24 * 3600 * 1000;

/** What a play was multiplied by, and the levels it was played at, noted when it came in. */
export type PlayNote = { own: Record<string, number>; medals: number; levels: Record<string, number> };

const readNotes = (): Record<string, PlayNote> => {
	try { return JSON.parse(localStorage.getItem(NOTES_KEY) ?? '{}') as Record<string, PlayNote>; } catch { return {}; }
};
const writeNotes = (notes: Record<string, PlayNote>) => {
	const ids = Object.keys(notes).map(Number).sort((a, b) => a - b);
	for (const id of ids.slice(0, Math.max(0, ids.length - MAX_NOTES))) delete notes[id];
	try { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); } catch { /* full or blocked: notes are a convenience */ }
};

const levelsOf = (character: CharacterRow) => {
	const state = stateOf(character as unknown as Record<string, unknown>);
	return Object.fromEntries(Object.entries(state.skills).map(([skill, s]) => [skill, s.level]));
};

let lastSeen: number | undefined;
let medalsCache: { id: number; value: number } | undefined;

/**
 * Note the plays that came in since the last call: the character's multipliers,
 * medals and levels right after them. The first call only marks where it starts.
 */
export const notePlays = async (character: CharacterRow): Promise<void> => {
	const newest = Number(await gameDb.value('SELECT MAX(id) FROM score WHERE characterId = ?', [character.id]) ?? 0);
	if (lastSeen === undefined || newest <= lastSeen) {
		lastSeen = Math.max(lastSeen ?? 0, newest);
		return;
	}
	const fresh = await gameDb.select<{ id: number }>('SELECT id FROM score WHERE characterId = ? AND id > ?', [character.id, lastSeen]);
	lastSeen = newest;
	if (medalsCache?.id !== character.id) {
		const value = await medalMultiplier(character);
		if (value !== undefined) medalsCache = { id: character.id, value };
	}
	const state = stateOf(character as unknown as Record<string, unknown>);
	const note: PlayNote = { own: ownMultipliers(state), medals: medalsCache?.value ?? 1, levels: levelsOf(character) };
	const notes = readNotes();
	for (const { id } of fresh) notes[id] = note;
	writeNotes(notes);
};

export type LastPlay = {
	playedAt: number;
	rate: number;
	mods: string;
	/** Base XP per skill. */
	base: Record<string, number>;
	/** The play's length at its rate, in seconds. */
	seconds: number;
	/** Levels when it was played, when noted. */
	levels?: Record<string, number>;
	/** Plays of the map among the ones before it that mindblock counted. */
	recent: number;
};

/** The character's last play of `beatmapId` at `rate` with `mods` (a `modsKey`), or undefined. */
export const lastPlayOf = async (
	character: CharacterRow,
	beatmapId: number,
	rate: number,
	mods: string,
	lengthSec: number,
): Promise<LastPlay | undefined> => {
	const row = await gameDb.first<{ id: number; playedAt: number; rate: number; mods: string; gains: string | null }>(
		`SELECT s.id, s.playedAt, s.rate, s.mods, x.gains FROM score s LEFT JOIN score_xp x ON x.scoreId = s.id
		 WHERE s.characterId = ? AND s.beatmapId = ? AND ABS(s.rate - ?) < 0.001 AND COALESCE(s.mods, '') = ?
		 ORDER BY s.playedAt DESC LIMIT 1`,
		[character.id, beatmapId, rate, mods],
	);
	if (!row) return undefined;
	const before = await gameDb.select<{ beatmapId: number }>(
		'SELECT beatmapId FROM score WHERE characterId = ? AND playedAt < ? AND playedAt >= ? ORDER BY playedAt DESC LIMIT ?',
		[character.id, row.playedAt, row.playedAt - RECENT_MS, RECENT_PLAYS],
	);
	const recent = before.filter(play => play.beatmapId === beatmapId).length;
	const note = readNotes()[row.id];
	const own = note?.own ?? ownMultipliers(stateOf(character as unknown as Record<string, unknown>));
	const medals = note?.medals ?? (medalsCache?.id === character.id ? medalsCache.value : 1);
	const modded = modXpMultipliers(parseMods(row.mods ?? '')) as Record<string, number>;
	const block = mindblockFactor(recent);
	let gains: Record<string, number> = {};
	try { gains = JSON.parse(row.gains ?? '{}') as Record<string, number>; } catch { /* no xp kept */ }
	const base = Object.fromEntries(Object.entries(gains).map(([skill, xp]) => {
		const by = (own[skill] || 1) * medals * (modded[skill] ?? 1) * (MINDBLOCK.has(skill) ? block : 1);
		return [skill, by > 0 ? xp / by : 0];
	}));
	return { playedAt: row.playedAt, rate: row.rate, mods: row.mods ?? '', base, seconds: lengthSec / row.rate, levels: note?.levels, recent };
};
