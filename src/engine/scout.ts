/**
 * Scouting: which maps players near your level farm lately.
 *
 * Players grinding for the top already pick their farm maps with care, so the
 * maps and rates those near your level played recently are the likeliest good
 * ones for you too. A fast scan simulates those first (plus a share of the rest,
 * so a good map nobody plays yet still turns up) instead of every map in the
 * library: a few dozen API calls to save thousands of sim calls.
 *
 * Only recent plays count: best scores are pp attempts, not what people farm.
 */

import type { ApiRanking, ApiScoreOnMap, ApiSkillRanking, RankingOption, ListOption } from '@oss-idle/shared/apiV2';
import { PHYSICAL_SKILLS } from '@oss-idle/shared/rulesets/mania/4k/skills';
import { playLevelOf } from '@oss-idle/shared/xp';
import type { FarmTarget } from '../farm/metrics.js';
import { paced } from './pace.js';
import type { SimRequest } from './protocol.js';

/** Share of the maps nobody near you played that a fast scan still screens, picked at random each scan. */
export const EXPLORE_SHARE = 0.15;

/** A skill's play level off the game's `character` row: what all its XP bought, plus prestige, as profiles show. */
const levelOf = (row: Record<string, unknown>, skill: string) => playLevelOf(
	Number(row[skill]) || 0, Number(row[`${skill}XP`]) || 0,
	Number(row[`${skill}LifetimeXp`]) || 0, Number(row[`${skill}Prestige`]) || 0,
);

/** Your play level in each skill `target` farms; for a total or pp target, your two physical skills highest up. */
export const farmLevels = (row: Record<string, unknown>, target: FarmTarget): Record<string, number> => {
	const skills = target.kind === 'skills'
		? (target.weights
			? Object.entries(target.weights).filter(([, weight]) => weight > 0).map(([skill]) => skill)
			: [...(target.skills ?? [])])
		: [...PHYSICAL_SKILLS].sort((a, b) => levelOf(row, b) - levelOf(row, a)).slice(0, 2);
	return Object.fromEntries(skills.map(skill => [skill, levelOf(row, skill)]));
};

/**
 * What a fast scan simulates: the maps players near you played, at the screened
 * rates and at the ones they played among `rates`, and `explore` of the rest at
 * the screened rates. `random` picks the rest (Math.random unless a test fixes it).
 */
export const scoutedRequests = <M extends Pick<SimRequest, 'setId' | 'beatmapId'>>(
	requests: readonly M[],
	scouted: Scouted,
	rates: readonly number[],
	screened: readonly number[],
	explore = EXPLORE_SHARE,
	random: () => number = Math.random,
): (M & { rates: number[] })[] => requests.flatMap(map => {
	const seen = scouted.get(map.beatmapId);
	if (seen) {
		const theirs = rates.filter(rate => [...seen.rates].some(played => Math.abs(played - rate) < 1e-6));
		return [{ ...map, rates: [...new Set([...screened, ...theirs])].sort((a, b) => a - b) }];
	}
	return random() < explore ? [{ ...map, rates: [...screened] }] : [];
});

/** The part of the game's add-on API (`host.api`, oss!idle 1.3) the scout reads. */
export type ScoutApi = {
	skillRankings(skill: string, options?: RankingOption): Promise<ApiRanking<ApiSkillRanking>>;
	characterScores(id: number, type: 'recent', options?: ListOption): Promise<ApiScoreOnMap[]>;
};

/** Ranking pages read per skill at most, looking for players near your level. */
const MAX_PAGES = 8;
/** Players whose recent plays are read. */
const NEIGHBOURS = 30;
/** Recent plays read per player. */
const RECENT = 50;

/** What players near your level played lately: each map's rates, and how many of them played it. */
export type Scouted = Map<number, { rates: Set<number>; players: number }>;

/**
 * The maps and rates the players nearest your level in `levels`' skills played
 * recently. `levels` is your play level in each skill you farm; `self` is your
 * character, left out.
 */
export const scoutRecent = async (
	api: ScoutApi,
	levels: Readonly<Record<string, number>>,
	self?: number,
): Promise<Scouted> => {
	// each character's distance from you: the widest gap over the skills you farm
	const distance = new Map<number, number>();
	for (const [skill, level] of Object.entries(levels)) {
		for (let page = 1; page <= MAX_PAGES; page++) {
			const { ranking, cursor } = await paced(() => api.skillRankings(skill, { page }));
			for (const entry of ranking) {
				const id = entry.user.character_id;
				if (id === self) continue;
				const gap = Math.abs((entry.skill.level + (entry.skill.prestige ?? 0)) - level);
				distance.set(id, Math.max(distance.get(id) ?? 0, gap));
			}
			// the ranking runs from the top down: past your level, the rest are further still
			const lowest = ranking.at(-1);
			if (!cursor || !lowest || lowest.skill.level + (lowest.skill.prestige ?? 0) < level) break;
		}
	}

	const nearest = [...distance].sort((a, b) => a[1] - b[1]).slice(0, NEIGHBOURS).map(([id]) => id);
	const scouted: Scouted = new Map();
	for (const id of nearest) {
		let scores: ApiScoreOnMap[];
		try {
			scores = await paced(() => api.characterScores(id, 'recent', { limit: RECENT }));
		} catch {
			continue; // a restricted or vanished player: the others still count
		}
		const seen = new Set<number>();
		for (const score of scores) {
			let map = scouted.get(score.beatmap_id);
			if (!map) scouted.set(score.beatmap_id, map = { rates: new Set(), players: 0 });
			map.rates.add(score.rate);
			if (!seen.has(score.beatmap_id)) map.players++, seen.add(score.beatmap_id);
		}
	}
	return scouted;
};
