/**
 * Pacing API v2 calls under the player's rate limit.
 *
 * The limit is the player's, whatever part of the add-on calls: the sim sweep and
 * the scout share one clock.
 */

import type { ApiError } from '@oss-idle/shared/apiV2';

/** API v2 takes 1200 calls a minute from a player: one every 50ms. */
const CALL_SPACING_MS = 50;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const statusOf = (e: unknown) => (e as Partial<ApiError>)?.status;

/** When the next call may go. */
let nextCall = 0;

/** An API v2 call, spaced under the rate limit, retried while the server is busy (429). */
export const paced = async <T>(call: () => Promise<T>): Promise<T> => {
	for (let attempt = 0; ; attempt++) {
		const now = Date.now();
		const at = Math.max(now, nextCall);
		nextCall = at + CALL_SPACING_MS;
		if (at > now) await sleep(at - now);
		try {
			return await call();
		} catch (e) {
			if (statusOf(e) !== 429 || attempt >= 5) throw e;
			await sleep(1000 * 2 ** attempt);
		}
	}
};
