/**
 * The simulation worker.
 *
 * Runs osu!idle's own simulation - the same `CharacterBot` + `ManiaGame` the
 * server uses to produce an authoritative score - over a batch of charts, and
 * reports what each play would be worth in XP.
 *
 * It runs off the main thread because the game is a rhythm game sharing this
 * page: simulating a few hundred maps takes seconds of solid CPU, and doing
 * that on the main thread would stutter audio and input. Results stream back in
 * chunks so the overlay can fill in as it goes rather than waiting for the sweep.
 *
 * The bundler inlines this file into the add-on as a string (`worker:` import),
 * since a Blob-loaded add-on has no URL to load a separate worker file from.
 */

// Side-effect import, exactly as every decode site in the game does it.
// osu-classes' `groupAt` re-sorts the whole control-point list on each
// insertion, so decoding is quadratic in control points: an SV-heavy chart
// (Camellia - Singularity carries ~23 400 timing points) takes ~3.6s instead of
// ~70ms. Over a whole library that is minutes of the sweep spent in the parser.
import '@osu-idle/shared/osu/controlPointPatch';
import { BeatmapDecoder } from 'osu-parsers';
import { ManiaGame, LEAD_IN_MS } from '@osu-idle/shared/sim/maniaGame';
import CharacterBot from '@osu-idle/shared/sim/bots/character';
import { makeOrderedSkills } from '@osu-idle/shared/sim/skills/factory';
import Memory from '@osu-idle/shared/sim/skills/memory';
import { beatmapStore } from '@osu-idle/addon-sdk';
import { ppChart, ppReady, type PPChart } from './pp.js';
import type {
	SimError,
	SimResult,
	WorkerRequest,
	WorkerResponse,
} from './protocol.js';

const decoder = new BeatmapDecoder();

/** Stream results back in chunks this size, so the table fills as it goes. */
const CHUNK = 8;

let cancelled = false;

const post = (message: WorkerResponse) => (self as unknown as Worker).postMessage(message);

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
 * The chart is decoded once and replayed, since decoding costs more than the
 * simulation does.
 */
const simulate = (
	chartText: string,
	character: Record<string, unknown>,
	divine: boolean,
	runs: number,
	pp: PPChart,
	timesPlayed: number,
): Omit<SimResult, 'setId' | 'beatmapId'> => {
	const chart = decoder.decodeFromString(chartText);
	// The game's `buildBarlines` steps through each timing section by the raw
	// `beatLengthUnlimited`, so a gimmick timing point (beatLength ~1e-7ms) makes
	// it push billions of barlines and the worker runs out of memory. Barlines are
	// drawing only, and every other reader uses the clamped `beatLength` (6 to
	// 60000ms), so clamping the raw value leaves the result unchanged.
	for (const tp of chart.controlPoints.timingPoints) tp.beatLengthUnlimited = tp.beatLength;

	const totals: Record<string, number> = {};
	const grades: string[] = [];
	let accuracy = 0;
	let duration = 0;
	let failures = 0;
	let ppTotal = 0;
	const totalsPerRun: number[] = [];

	for (let run = 0; run < runs; run++) {
		const bot = new CharacterBot(
			skillsFrom(character, timesPlayed),
			chart.difficulty.overallDifficulty,
		);
		// Only `divine` - exactly what the server passes in `simulateAndStore`,
		// and what the client's local play passes. `scrollMs` is left at its
		// default (600): it is the bot's visibility span, a constant of the
		// simulation, not the player's scroll-speed setting. Only the live
		// renderer passes that, because it is about drawing.
		const game = new ManiaGame(chart, bot, { divine });

		game.update(game.songEndMs + 2000);

		const score = game.score;
		const xp = bot.getSkillsXP(chart.totalLength, score) as Record<string, number>;

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
		ppTotal += pp.calculate(score);
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

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
	const message = event.data;

	if (message.type === 'cancel') {
		cancelled = true;
		return;
	}

	cancelled = false;
	void run(message);
};

/**
 * Work through this worker's slice of the library.
 *
 * Jobs are grouped by beatmapset so each set's charts are read from IndexedDB
 * once and its difficulties simulated together, rather than one read per
 * difficulty.
 */
const run = async (message: Extract<WorkerRequest, { type: 'run' }>): Promise<void> => {
	const { batch, character, divine, runs, playCounts } = message;

	// One wasm init per worker, before any chart is parsed for pp.
	const ppAvailable = await ppReady();

	try {
		const bySet = new Map<number, number[]>();
		for (const request of batch) {
			const ids = bySet.get(request.setId);
			if (ids) ids.push(request.beatmapId);
			else bySet.set(request.setId, [request.beatmapId]);
		}

		let results: SimResult[] = [];
		let errors: SimError[] = [];
		let done = 0;

		const flush = () => {
			post({ type: 'progress', done, total: batch.length, results, errors });
			results = [];
			errors = [];
		};

		for (const [setId, beatmapIds] of bySet) {
			if (cancelled) break;

			let charts: Record<number, string> = {};
			try {
				charts = await beatmapStore.charts(setId);
			} catch (e) {
				// The whole set is unreadable - report each difficulty and move on.
				for (const beatmapId of beatmapIds) {
					errors.push({
						setId, beatmapId,
						message: e instanceof Error ? e.message : String(e),
					});
					done++;
				}
				flush();
				continue;
			}

			for (const beatmapId of beatmapIds) {
				if (cancelled) break;
				done++;

				const chart = charts[beatmapId];
				if (!chart) {
					errors.push({ setId, beatmapId, message: 'no stored chart' });
				} else {
					// Parsed once per map and freed after: wasm objects outlive
					// their JS wrappers, and a sweep sees a thousand maps.
					const pp = ppChart(chart, ppAvailable);
					try {
						results.push({
							setId,
							beatmapId,
							...simulate(
								chart, character, divine, Math.max(1, runs || 1), pp,
								playCounts[beatmapId] ?? 0,
							),
						});
					} catch (e) {
						// One unparseable or exotic chart must not end the sweep.
						errors.push({
							setId, beatmapId,
							message: e instanceof Error ? e.message : String(e),
						});
					} finally {
						pp.free();
					}
				}

				if (results.length + errors.length >= CHUNK) flush();
			}
		}

		if (results.length || errors.length) flush();
		post({ type: cancelled ? 'cancelled' : 'done' });
	} catch (e) {
		post({ type: 'fatal', message: e instanceof Error ? e.message : String(e) });
	}
};
