/**
 * Saving a rotation as a playlist whose entries can be locked at a rate.
 *
 * The SDK's `playlists.replace` writes difficulties only. Since oss!idle
 * 1.0.1.0 a `playlist_entry` also carries a `rate`: 0 follows the mod, anything
 * else plays the entry at that rate, and the rate is part of the key - so one
 * difficulty can be listed once per rate.
 */

import { gameDb, playlists } from '@oss-idle/addon-sdk';

/** Which entries are locked at their rate: every one, all but x1, or none. */
export type RateLock = 'all' | 'rated' | 'none';

export type PlaylistEntry = { beatmapId: number; rate: number };

/** The rate an entry is stored with: its own when locked, 0 to follow the mod. */
export const storedRate = ({ rate }: PlaylistEntry, lock: RateLock): number =>
	lock === 'all' || (lock === 'rated' && rate !== 1) ? rate : 0;

/** Create or refill the playlist `name` with exactly these entries. */
export const replacePlaylist = async (
	name: string,
	entries: readonly PlaylistEntry[],
	lock: RateLock,
): Promise<{ created: boolean }> => {
	const existing = await playlists.byName(name);
	// a new playlist is created empty and filled below; an existing one is
	// cleared and refilled in the same save, so it is never stored half-empty
	const id = existing?.id ?? (await playlists.replace(name, [])).id;
	await gameDb.batch([
		...(existing ? [{ sql: 'DELETE FROM playlist_entry WHERE playlistId = ?', params: [id] }] : []),
		...entries.map((entry, position) => ({
			sql: 'INSERT INTO playlist_entry (playlistId, beatmapId, rate, position) VALUES (?, ?, ?, ?)',
			params: [id, entry.beatmapId, storedRate(entry, lock), position],
		})),
	]);
	return { created: !existing };
};