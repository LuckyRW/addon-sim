/**
 * Messages between the overlay and the simulation worker.
 *
 * Everything crossing this boundary is structured-cloneable: the worker
 * receives a plain snapshot of the character (the `character` row as stored)
 * and rebuilds the game's `Skill` objects on its own side, because those carry
 * behaviour and cannot be cloned.
 */

/**
 * One difficulty to simulate, and the rates to simulate it at.
 *
 * Deliberately just ids: charts are read by the worker, straight from the same
 * IndexedDB the client stores them in. Reading them on the main thread instead
 * would mean holding an entire library of `.osu` text in memory (a thousand maps
 * is easily hundreds of megabytes) and then paying for a structured-clone copy
 * of all of it per worker.
 */
export type SimRequest = {
	setId: number;
	beatmapId: number;
	rates: number[];
};

/**
 * What a simulated play is worth, before any farm-level adjustment.
 *
 * The simulation is **stochastic** - the bot's hit error is sampled, so the same
 * chart played twice earns different XP (measured at 4-17% variation run to
 * run, worst on maps the character is only just clearing). Every field here is
 * therefore a mean over `runs` attempts, which is what makes two close maps
 * rankable against each other at all.
 */
export type SimResult = {
	setId: number;
	beatmapId: number;
	/** Playback rate the play ran at. */
	rate: number;
	/** Star rating at that rate (0 if rosu-pp is unavailable). */
	stars: number;
	/** Mean per-skill XP per play, before mindblock. */
	xp: Record<string, number>;
	/** Sum over every skill. */
	totalXp: number;
	/** Mean wall-clock cost in seconds: lead-in plus time to the last judged note. */
	durationSec: number;
	/** Mean accuracy across runs. */
	accuracy: number;
	/** Grade of the median run. */
	grade: string;
	/** Mean performance points per play (0 if rosu-pp is unavailable). */
	pp: number;
	/** How many attempts were averaged. */
	runs: number;
	/** Share of runs that died to HP drain (0 = always clears, 1 = never). */
	failRate: number;
	/** Relative spread of total XP across runs - how trustworthy the mean is. */
	variation: number;
};

export type SimError = {
	setId: number;
	beatmapId: number;
	message: string;
};

/**
 * One beatmapset's difficulties, handed to a free worker.
 *
 * A whole set per job because a set's charts are one IndexedDB read: split
 * across workers, each of them would read the whole set again.
 */
export type WorkerRequest = {
	type: 'job';
	setId: number;
	/** The `character` row, used to rebuild the player's skills worker-side. */
	character: Record<string, unknown>;
	/** Whether the character has the DIVINE unlock (changes judgement). */
	divine: boolean;
	/** Attempts to average per map and rate. Higher is steadier but linearly slower. */
	runs: number;
	maps: {
		beatmapId: number;
		/** Playback rates to simulate it at. */
		rates: number[];
		/**
		 * Plays to seed the memory skill with, which is the only thing that makes
		 * it earn: it trains on *partially* learned maps, so a map the character
		 * has never played trains it exactly zero.
		 */
		timesPlayed: number;
	}[];
};

/**
 * A worker reports each rate as it finishes and each map once it is through
 * with it, so the overlay fills in as it goes - and so a worker that dies or
 * stalls can be pinned to the map it was on.
 */
export type WorkerResponse =
	| { type: 'result'; result: SimResult }
	| { type: 'map'; beatmapId: number; error?: string }
	/** The job is over; any of its maps not reported were not simulated. */
	| { type: 'idle' };
