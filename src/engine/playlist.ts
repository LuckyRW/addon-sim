/**
 * Saving a rotation as a playlist whose entries can be locked at a rate.
 *
 * Written straight into the game's tables: one `playlist` row, and a
 * `playlist_entry` per entry with its `rate` (0 follows the mod, anything else
 * plays the entry at that rate) and, since oss!idle 1.2.3.0, the `position` it
 * plays in.
 */

import { gameDb } from '@oss-idle/addon-sdk';

/** Which entries are locked at their rate: every one, all but x1, or none. */
export type RateLock = 'all' | 'rated' | 'none';

export type PlaylistEntry = { beatmapId: number; rate: number };

/** The rate an entry is stored with: its own when locked, 0 to follow the mod. */
export const storedRate = ({ rate }: PlaylistEntry, lock: RateLock): number =>
	lock === 'all' || (lock === 'rated' && rate !== 1) ? rate : 0;

/** The oldest playlist called `name`: the game lets two share a name, and
 * this keeps a regenerated playlist overwriting the same one. */
const playlistId = (name: string) => gameDb.value<number>(
	'SELECT id FROM playlist WHERE name = ? ORDER BY id LIMIT 1', [name],
);

/** Create or refill the playlist `name` with exactly these entries. */
export const replacePlaylist = async (
	name: string,
	entries: readonly PlaylistEntry[],
	lock: RateLock,
): Promise<{ created: boolean }> => {
	const existing = await playlistId(name);
	if (existing === undefined) {
		await gameDb.run('INSERT INTO playlist (name, createdAt) VALUES (?, ?)', [name, Date.now()]);
	}
	const id = existing ?? await playlistId(name);
	if (id === undefined) throw new Error(`Failed to create playlist "${name}"`);
	// cleared and refilled in one save, so it is never stored half-empty
	await gameDb.batch([
		{ sql: 'DELETE FROM playlist_entry WHERE playlistId = ?', params: [id] },
		...entries.map((entry, i) => ({
			sql: 'INSERT INTO playlist_entry (playlistId, beatmapId, rate, position) VALUES (?, ?, ?, ?)',
			params: [id, entry.beatmapId, storedRate(entry, lock), i + 1],
		})),
	]);
	return { created: existing === undefined };
};
