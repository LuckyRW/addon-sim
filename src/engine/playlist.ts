/**
 * Saving a rotation as a playlist.
 *
 * Written straight into the game's tables: one `playlist` row, and a
 * `playlist_entry` per entry, locked at its `rate` and `mods` and played at
 * its `position`.
 */

import { gameDb } from '@oss-idle/addon-sdk';
import { modsKey, type Mod } from '@oss-idle/shared/mods';

/** A playlist map, played `repeat` times in a row (the game's queue reads it since 1.3). */
export type PlaylistEntry = { beatmapId: number; rate: number; mods: Mod[]; repeat?: number };

/** The oldest playlist called `name`: the game lets two share a name, and
 * this keeps a regenerated playlist overwriting the same one. */
const playlistId = (name: string) => gameDb.value<number>(
	'SELECT id FROM playlist WHERE name = ? ORDER BY id LIMIT 1', [name],
);

/** Create or refill the playlist `name` with exactly these entries. */
export const replacePlaylist = async (
	name: string,
	entries: readonly PlaylistEntry[],
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
			sql: 'INSERT INTO playlist_entry (playlistId, beatmapId, rate, position, mods, repeat) VALUES (?, ?, ?, ?, ?, ?)',
			params: [id, entry.beatmapId, entry.rate, i + 1, modsKey(entry.mods), Math.max(1, Math.round(entry.repeat ?? 1))],
		})),
	]);
	return { created: existing === undefined };
};
