/**
 * The simulation worker.
 *
 * Runs oss!idle's own simulation - the same `CharacterBot` + `ManiaGame` the
 * server uses to produce an authoritative score - over one beatmapset at a
 * time, and reports what each play would be worth in XP.
 *
 * It runs off the main thread because the game is a rhythm game sharing this
 * page: simulating a few hundred maps takes seconds of solid CPU, and doing
 * that on the main thread would stutter audio and input. Results stream back a
 * rate at a time, so the overlay fills in as it goes rather than waiting for the
 * sweep.
 *
 * The bundler inlines this file into the add-on as a string (`worker:` import),
 * since a Blob-loaded add-on has no URL to load a separate worker file from.
 */

// Side-effect import, exactly as every decode site in the game does it.
// osu-classes' `groupAt` re-sorts the whole control-point list on each
// insertion, so decoding is quadratic in control points: an SV-heavy chart
// (Camellia - Singularity carries ~23 400 timing points) takes ~3.6s instead of
// ~70ms. Over a whole library that is minutes of the sweep spent in the parser.
import '@oss-idle/shared/osu/controlPointPatch';
import { BeatmapDecoder } from 'osu-parsers';
import type { Beatmap } from 'osu-classes';
import { ManiaGame, LEAD_IN_MS } from '@oss-idle/shared/sim/maniaGame';
import CharacterBot from '@oss-idle/shared/sim/bots/character';
import { makeOrderedSkills } from '@oss-idle/shared/sim/skills/factory';
import Memory from '@oss-idle/shared/sim/skills/memory';
import { ppChart, ppReady, type PPChart } from './pp.js';
import type {
	SimResult,
	WorkerRequest,
	WorkerResponse,
} from './protocol.js';

const decoder = new BeatmapDecoder();

const post = (message: WorkerResponse) => (self as unknown as Worker).postMessage(message);

/**
 * Give the event loop a turn. The game's skills update through async `Synced`
 * listeners, and their pending promises keep a whole play alive until the loop
 * runs - dozens of plays of one map without a turn run the worker out of memory.
 *
 * A message rather than `setTimeout`, which browsers hold back to at least 4ms
 * once timers nest - and this runs once per map and rate.
 */
const channel = new MessageChannel();
const settle = () => new Promise<void>(resolve => {
	channel.port1.onmessage = () => resolve();
	channel.port2.postMessage(null);
});

/**
 * Rates that fail every run this many times in a row end a map's sweep: a
 * faster rate is harder still. Two, not one, because a single screening run
 * can fail by bad luck on a map that usually clears.
 */
const FAILS_TO_STOP = 2;

/**
 * Rebuild the player's skills from a stored `character` row.
 *
 * Mirrors the client's `Character` constructor: the row keeps one column group
 * per skill, and the factory produces the objects the bot expects.
 *
 * `timesPlayed` seeds the memory skill, which the client does separately (it is
 * per map, not per character). Memory trains on the *transition* from unknown to
 * memorised - its XP weight is a hump that is zero on a fresh map and zero again
 * on a mastered one - so leaving this at its default 0 means memory earns
 * nothing anywhere, on every map.
 */
const skillsFrom = (row: Record<string, unknown>, timesPlayed: number) => {
	const skills = makeOrderedSkills();
	for (const skill of skills) {
		const set = (field: 'level' | 'xp' | 'upgrades' | 'overdrive' | 'prestige', column: string) => {
			const value = row[column];
			if (typeof value === 'number') skill[field].set(value);
		};
		set('level', skill.name);
		set('xp', `${skill.name}XP`);
		set('upgrades', `${skill.name}Upgrades`);
		set('overdrive', `${skill.name}Overdrive`);
		set('prestige', `${skill.name}Prestige`);
		if (skill instanceof Memory) skill.timesPlayed.set(timesPlayed);
	}
	return skills;
};

/**
 * Simulate one chart `runs` times and average the result.
 *
 * The play is advanced straight past the end rather than stepped: the game only
 * needs intermediate samples to stream a replay, and we want the final score. A
 * run past `songEndMs` guarantees every note - including a trailing long note's
 * tail - has been judged.
 *
 * Averaging is not optional polish. The bot samples its hit error, so one run of
 * a chart is a draw from a distribution, not a measurement: spread runs 4-17% of
 * total XP, worst on maps the character is only just holding together. Ranking
 * maps against each other on single draws would shuffle the top of the table
 * every scan.
 *
 * The chart is decoded once per map and replayed at every rate, since decoding
 * costs more than the simulation does. A rate runs as the server's
 * `simulateAndStore` does: notes sped up by the game, XP over the play's real
 * length, pp at that clock rate.
 */
const decode = (chartText: string): Beatmap => {
	const chart = decoder.decodeFromString(chartText);
	// The game's `buildBarlines` steps through each timing section by the raw
	// `beatLengthUnlimited`, so a gimmick timing point (beatLength ~1e-7ms) makes
	// it push billions of barlines and the worker runs out of memory. Barlines are
	// drawing only, and every other reader uses the clamped `beatLength` (6 to
	// 60000ms), so clamping the raw value leaves the result unchanged.
	for (const tp of chart.controlPoints.timingPoints) tp.beatLengthUnlimited = tp.beatLength;
	return chart;
};

const simulate = (
	chart: Beatmap,
	rate: number,
	character: Record<string, unknown>,
	divine: boolean,
	runs: number,
	pp: PPChart,
	timesPlayed: number,
): Omit<SimResult, 'setId' | 'beatmapId'> => {
	const totals: Record<string, number> = {};
	const grades: string[] = [];
	let accuracy = 0;
	let duration = 0;
	let failures = 0;
	let ppTotal = 0;
	const totalsPerRun: number[] = [];

	for (let run = 0; run < runs; run++) {
		const bot = new CharacterBot(skillsFrom(character, timesPlayed));
		// Only `divine` and `rate` - exactly what the server passes in `simulateAndStore`,
		// and what the client's local play passes. `scrollMs` is left at its
		// default (600): it is the bot's visibility span, a constant of the
		// simulation, not the player's scroll-speed setting. Only the live
		// renderer passes that, because it is about drawing.
		const game = new ManiaGame(chart, bot, { divine, rate });

		game.update(game.songEndMs + 2000);

		const score = game.score;
		const xp = bot.getSkillsXP(chart.totalLength / rate, score) as Record<string, number>;

		let runTotal = 0;
		for (const [skill, value] of Object.entries(xp)) {
			totals[skill] = (totals[skill] ?? 0) + value;
			runTotal += value;
		}
		totalsPerRun.push(runTotal);

		// A failed play stops where HP ran out, so it costs less time *and* earns
		// less - both halves matter to an XP-per-second ranking.
		const lastNoteEnd = game.notes.reduce(
			(max, note) => Math.max(max, note.hold ? note.endTime : note.time),
			0,
		);
		const failed = score.failed;
		if (failed) failures++;
		const endMs = failed && score.failedIndex > 0
			? (game.hits[score.failedIndex - 1]?.time ?? lastNoteEnd)
			: lastNoteEnd;

		accuracy += score.accuracy;
		duration += (LEAD_IN_MS + endMs) / 1000;
		grades.push(String(score.grade));
		ppTotal += pp.calculate(score, rate);
	}

	const xp: Record<string, number> = {};
	for (const [skill, sum] of Object.entries(totals)) xp[skill] = sum / runs;
	const totalXp = totalsPerRun.reduce((sum, value) => sum + value, 0) / runs;

	// Report how noisy the mean is, so a close ranking can be read with the
	// right amount of confidence.
	const variance = totalsPerRun.reduce((sum, value) => sum + (value - totalXp) ** 2, 0) / runs;
	const variation = totalXp > 0 ? Math.sqrt(variance) / totalXp : 0;

	grades.sort();

	return {
		rate,
		stars: pp.stars(rate),
		xp,
		totalXp,
		durationSec: duration / runs,
		accuracy: accuracy / runs,
		grade: grades[Math.floor(grades.length / 2)] ?? 'D',
		pp: ppTotal / runs,
		runs,
		failRate: failures / runs,
		variation,
	};
};

self.onmessage = (event: MessageEvent<WorkerRequest>) => void run(event.data);

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Simulate one beatmapset's difficulties.
 *
 * The set's charts arrive with the job, read once for all its difficulties.
 */
const run = async (job: WorkerRequest): Promise<void> => {
	const { setId, charts, character, divine, runs } = job;
	try {
		// One wasm init per worker, before any chart is parsed for pp.
		const ppAvailable = await ppReady();

		for (const { beatmapId, rates, timesPlayed } of job.maps) {
			const chart = charts[beatmapId];
			if (!chart) {
				post({ type: 'map', beatmapId, error: 'no stored chart' });
				continue;
			}
			// Parsed once per map and freed after: wasm objects outlive
			// their JS wrappers, and a sweep sees a thousand maps.
			const pp = ppChart(chart, ppAvailable);
			try {
				const decoded = decode(chart);
				let failStreak = 0;
				for (const rate of [...rates].sort((a, b) => a - b)) {
					await settle();
					const result = simulate(decoded, rate, character, divine, Math.max(1, runs || 1), pp, timesPlayed);
					post({ type: 'result', result: { setId, beatmapId, ...result } });
					failStreak = result.failRate === 1 ? failStreak + 1 : 0;
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
