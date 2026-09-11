/**
 * Playlist management.
 *
 * Playlists are local to the client's sql.js database: a `playlist` row and one
 * `playlist_entry` per difficulty, keyed on `(playlistId, beatmapId)`. Writes
 * go through the managed handle's write path so they are persisted back to
 * IndexedDB - a raw read-side mutation would live only until reload.
 *
 * The client caches playlists in views that re-query on a version counter it
 * bumps itself. An add-on cannot bump that counter (it is module state, not
 * page state), so song select may show a stale list until it re-reads - the
 * overlay says so rather than pretending otherwise.
 */

import { gameDb } from '@osu-idle/addon-sdk';

type PlaylistRow = { id: number; name: string; createdAt: number };

export const playlists = {

	/** Every playlist, with how many difficulties each holds. */
	async list(): Promise<(PlaylistRow & { count: number })[]> {
		return gameDb.select<PlaylistRow & { count: number }>(`
			SELECT p.id, p.name, p.createdAt,
			       (SELECT COUNT(*) FROM playlist_entry e WHERE e.playlistId = p.id) AS count
			FROM playlist p
			ORDER BY p.createdAt DESC
		`);
	},

	/**
	 * The playlist with this name, oldest first.
	 *
	 * The game does not enforce unique playlist names - `Playlist.create` inserts
	 * whatever it is given - so a player can hold two called the same thing.
	 * Ordering by id makes the choice deterministic: regenerating a playlist
	 * keeps overwriting the same one instead of picking arbitrarily.
	 */
	async byName(name: string): Promise<PlaylistRow | undefined> {
		return gameDb.first<PlaylistRow>(
			'SELECT * FROM playlist WHERE name = ? ORDER BY id ASC LIMIT 1',
			[name],
		);
	},

	/** The difficulty ids in a playlist. */
	async entries(playlistId: number): Promise<number[]> {
		const rows = await gameDb.select<{ beatmapId: number }>(
			'SELECT beatmapId FROM playlist_entry WHERE playlistId = ?',
			[playlistId],
		);
		return rows.map(row => row.beatmapId);
	},

	/**
	 * Create a playlist holding exactly `beatmapIds`, replacing one of the same
	 * name. Generated playlists are regenerated often, so replace is the useful
	 * default - and clearing and refilling in one batch means the playlist is
	 * never persisted in a half-empty state.
	 *
	 * Replacing keeps the existing playlist's **id**, so anything already
	 * pointing at it keeps pointing at it.
	 */
	async replace(
		name: string,
		beatmapIds: readonly number[],
	): Promise<{ id: number; created: boolean }> {
		const existing = await this.byName(name);

		if (existing) {
			await gameDb.batch([
				{ sql: 'DELETE FROM playlist_entry WHERE playlistId = ?', params: [existing.id] },
				...beatmapIds.map(id => ({
					sql: 'INSERT OR REPLACE INTO playlist_entry (playlistId, beatmapId) VALUES (?, ?)',
					params: [existing.id, id] as (string | number)[],
				})),
			]);
			return { id: existing.id, created: false };
		}

		await gameDb.run(
			'INSERT INTO playlist (name, createdAt) VALUES (?, ?)',
			[name, Date.now()],
		);
		const created = await this.byName(name);
		if (!created) throw new Error(`Failed to create playlist "${name}"`);

		if (beatmapIds.length) {
			await gameDb.batch(beatmapIds.map(id => ({
				sql: 'INSERT OR REPLACE INTO playlist_entry (playlistId, beatmapId) VALUES (?, ?)',
				params: [created.id, id] as (string | number)[],
			})));
		}
		return { id: created.id, created: true };
	},

	async remove(playlistId: number): Promise<void> {
		await gameDb.batch([
			{ sql: 'DELETE FROM playlist_entry WHERE playlistId = ?', params: [playlistId] },
			{ sql: 'DELETE FROM playlist WHERE id = ?', params: [playlistId] },
		]);
	},
};

/**
 * Plays of each map since `since`, by beatmap id - what the memory skill trains
 * on. Mirrors the client's `Score.countPlays`, which is called per map with the
 * character's `memoryResetAt`: plays from before memory was last prestiged do
 * not count, because that training is what the prestige spent.
 *
 * Fetched for the whole library in one query rather than per map, since a sweep
 * needs every count at once.
 */
export const playCountsSince = async (
	characterId: number,
	since: number,
): Promise<Record<number, number>> => {
	const rows = await gameDb.select<{ beatmapId: number; n: number }>(
		`SELECT beatmapId, COUNT(*) AS n FROM score
		 WHERE characterId = ? AND playedAt >= ?
		 GROUP BY beatmapId`,
		[characterId, since],
	);
	const counts: Record<number, number> = {};
	for (const row of rows) counts[row.beatmapId] = row.n;
	return counts;
};

/**
 * Plays of each map in the last 24 hours, by beatmap id - the input mindblock
 * is computed from. Mirrors the server's `recentMapPlays`: the last 50 plays
 * inside a 24h window, counted per map.
 */
export const recentPlayCounts = async (characterId: number): Promise<Map<number, number>> => {
	const since = Date.now() - 24 * 60 * 60 * 1000;
	const rows = await gameDb.select<{ beatmapId: number }>(
		'SELECT beatmapId FROM score WHERE characterId = ? AND playedAt >= ? ORDER BY playedAt DESC LIMIT 50',
		[characterId, since],
	);
	const counts = new Map<number, number>();
	for (const row of rows) counts.set(row.beatmapId, (counts.get(row.beatmapId) ?? 0) + 1);
	return counts;
};
