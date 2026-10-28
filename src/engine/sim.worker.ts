/**
 * The simulation worker.
 *
 * Runs oss!idle's own simulation - the same `CharacterBot` + `ManiaGame` the
 * server uses to produce an authoritative score - over one beatmapset at a
 * time, and reports what each play would be worth in XP.
 *
 * It runs off the main thread because the game is a rhythm game sharing this
 * page: simulating a few hundred maps takes seconds of solid CPU, and doing
 * that on the main thread would stutter audio and input.
 *
 * The bundler inlines this file into the add-on as a string (`worker:` import),
 * since a Blob-loaded add-on has no URL to load a separate worker file from.
 */

// Side-effect import, exactly as every decode site in the game does it.
// osu-classes' `groupAt` re-sorts the whole control-point list on each
// insertion, so decoding is quadratic in control points without it.
import '@oss-idle/shared/osu/controlPointPatch';
import { BeatmapDecoder } from 'osu-parsers';
import type { Beatmap } from 'osu-classes';
import { fatigueLevel, warmup } from '@oss-idle/shared/fatigue';
import type { Mod } from '@oss-idle/shared/mods';
import { LEAD_IN_MS } from '@oss-idle/shared/play';
import { ManiaGame } from '@oss-idle/shared/rulesets/mania/maniaGame';
import { xpScore } from '@oss-idle/shared/rulesets/mania/xpScore';
import CharacterBot from '@oss-idle/shared/rulesets/mania/4k/bots/character';
import { PHYSICAL_SKILLS } from '@oss-idle/shared/rulesets/mania/4k/skills';
import { makeOrderedSkills } from '@oss-idle/shared/rulesets/mania/4k/skills/factory';
import Memory from '@oss-idle/shared/rulesets/mania/4k/skills/memory';
import { tireSkill } from '@oss-idle/shared/rulesets/mania/4k/tiring';
import { ppChart, ppReady, type PPChart } from './pp.js';
import type { SimResult, WorkerRequest, WorkerResponse } from './protocol.js';

const decoder = new BeatmapDecoder();

const post = (message: WorkerResponse) => (self as unknown as Worker).postMessage(message);

/**
 * Give the event loop a turn. The game's skills update through async `Synced`
 * listeners, and their pending promises keep a whole play alive until the loop
 * runs - dozens of plays of one map without a turn run the worker out of memory.
 * A message rather than `setTimeout`, which browsers clamp to 4ms once nested.
 */
const channel = new MessageChannel();
const settle = () => new Promise<void>(resolve => {
	channel.port1.onmessage = () => resolve();
	channel.port2.postMessage(null);
});

/** Rates that fail every run this many times in a row end a map's sweep: a faster rate is harder still. */
const FAILS_TO_STOP = 2;

// Mirrors the server's `STRAINED_4K` and `playStrain` (server-only code):
// notes where no physical skill strains past its threshold add no fatigue, and
// the heaviest maps strain on about FULL_STRAIN_SHARE of their notes.
const STRAINED_4K = {
	...Object.fromEntries(PHYSICAL_SKILLS.map(skill => [skill, 0.2])),
	coordination: 0.3,
};
const FULL_STRAIN_SHARE = 0.4;

/**
 * Rebuild the player's skills from a stored `character` row, tired as a
 * character `minutes` of fatigue in, the way the server's `loadCharacterSkills` does.
 *
 * `timesPlayed` seeds the memory skill, which is per map: left at 0, memory earns
 * nothing anywhere.
 */
const skillsFrom = (row: Record<string, unknown>, timesPlayed: number, minutes: number) => {
	const gear = Number(row.staminaUpgrades) || 0;
	const fatigue = fatigueLevel(minutes);
	const warm = warmup(minutes, gear);
	const skills = makeOrderedSkills();
	for (const skill of skills) {
		const set = (field: 'level' | 'xp' | 'upgrades' | 'overdrive' | 'prestige' | 'lifetimeXp', column: string) => {
			const value = row[column];
			if (typeof value === 'number') skill[field].set(value);
		};
		set('level', skill.name);
		set('xp', `${skill.name}XP`);
		set('upgrades', `${skill.name}Upgrades`);
		set('overdrive', `${skill.name}Overdrive`);
		set('prestige', `${skill.name}Prestige`);
		// since 1.3 a skill plays at what all its xp ever bought (`playLevel`)
		set('lifetimeXp', `${skill.name}LifetimeXp`);
		tireSkill(skill, fatigue, warm);
		if (skill instanceof Memory) skill.timesPlayed.set(timesPlayed);
	}
	return skills;
};

const decode = (chartText: string): Beatmap => {
	const chart = decoder.decodeFromString(chartText);
	// The game's `buildBarlines` steps through each timing section by the raw
	// `beatLengthUnlimited`, so a gimmick timing point (~1e-7ms) pushes billions of
	// barlines. Barlines are drawing only, and every other reader uses the clamped
	// `beatLength`, so clamping the raw value leaves the result unchanged.
	for (const tp of chart.controlPoints.timingPoints) tp.beatLengthUnlimited = tp.beatLength;
	return chart;
};

type Variant = { rate: number; mods: Mod[]; minutes: number };

/**
 * Simulate one chart `runs` times as the server's `simulate` does, and average.
 *
 * The play is advanced straight past the end: we want the final score, not the
 * live samples. XP is read off `xpScore` (the same hits judged at the map's own
 * windows, so HR's tighter windows cost nothing but fails) over the play's real
 * length, and pp at that clock rate and mods.
 */
const simulate = (
	chart: Beatmap,
	{ rate, mods, minutes }: Variant,
	job: WorkerRequest,
	pp: PPChart,
	timesPlayed: number,
): Omit<SimResult, 'setId' | 'beatmapId'> => {
	const runs = Math.max(1, job.runs || 1);
	const totals: Record<string, number> = {};
	const grades: string[] = [];
	const perRun: number[] = [];
	let accuracy = 0;
	let duration = 0;
	let strained = 0;
	let failures = 0;
	let ppTotal = 0;
	const lengthMs = chart.totalLength / rate;
	const options = { divine: job.divine, rate, mods };

	for (let run = 0; run < runs; run++) {
		const bot = new CharacterBot(skillsFrom(job.character, timesPlayed, minutes));
		const game = new ManiaGame(chart, bot, options);
		game.update(game.songEndMs + 1000);

		const { score } = game;
		const xp = bot.getSkillsXP(lengthMs, xpScore(chart, game, options)) as Record<string, number>;
		let runTotal = 0;
		for (const [skill, value] of Object.entries(xp)) {
			totals[skill] = (totals[skill] ?? 0) + value;
			runTotal += value;
		}
		perRun.push(runTotal);

		// A failed play ends where it failed, so it costs less time and earns less.
		const lastNoteEnd = game.notes.reduce((m, n) => Math.max(m, n.hold ? n.endTime : n.time), 0);
		if (score.failed) failures++;
		const endMs = score.failed && score.failedIndex > 0
			? (game.hits[score.failedIndex - 1]?.time ?? lastNoteEnd)
			: lastNoteEnd;

		accuracy += score.accuracy;
		duration += (LEAD_IN_MS + endMs) / 1000;
		strained += Math.min(1, bot.strainedShare(STRAINED_4K) / FULL_STRAIN_SHARE) * lengthMs / 60_000;
		grades.push(String(score.grade));
		ppTotal += pp.calculate(score, rate, mods);
	}

	const xp: Record<string, number> = {};
	for (const [skill, sum] of Object.entries(totals)) xp[skill] = sum / runs;
	const totalXp = perRun.reduce((sum, value) => sum + value, 0) / runs;
	const variance = perRun.reduce((sum, value) => sum + (value - totalXp) ** 2, 0) / runs;
	grades.sort();

	return {
		rate,
		mods,
		minutes,
		stars: pp.stars(rate, mods),
		xp,
		totalXp,
		durationSec: duration / runs,
		lengthMin: lengthMs / 60_000,
		strained: strained / runs,
		accuracy: accuracy / runs,
		grade: grades[Math.floor(grades.length / 2)] ?? 'D',
		pp: ppTotal / runs,
		runs,
		failRate: failures / runs,
		variation: totalXp > 0 ? Math.sqrt(variance) / totalXp : 0,
	};
};

self.onmessage = (event: MessageEvent<WorkerRequest>) => void run(event.data);

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const run = async (job: WorkerRequest): Promise<void> => {
	try {
		const ppAvailable = await ppReady();
		for (const { beatmapId, rates, mods, minutes, timesPlayed } of job.maps) {
			const chart = job.charts[beatmapId];
			if (!chart) {
				post({ type: 'map', beatmapId, error: 'no stored chart' });
				continue;
			}
			// Parsed once per map and freed after: wasm objects outlive their JS wrappers.
			const pp = ppChart(chart, ppAvailable);
			try {
				const decoded = decode(chart);
				let failStreak = 0;
				for (const rate of [...rates].sort((a, b) => a - b)) {
					let allFailed = true;
					for (const set of mods) {
						for (const at of minutes) {
							await settle();
							const result = simulate(decoded, { rate, mods: set, minutes: at }, job, pp, timesPlayed);
							post({ type: 'result', result: { setId: job.setId, beatmapId, ...result } });
							if (result.failRate < 1) allFailed = false;
						}
					}
					failStreak = allFailed ? failStreak + 1 : 0;
					if (failStreak >= FAILS_TO_STOP) break;
				}
				post({ type: 'map', beatmapId });
			} catch (e) {
				// One unparseable or exotic chart must not end the sweep.
				post({ type: 'map', beatmapId, error: message(e) });
			} finally {
				pp.free();
			}
		}
	} finally {
		post({ type: 'idle' });
	}
};
