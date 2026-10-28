/**
 * The sweep's worker: runs `sweep` off the game's thread, asking the game's
 * thread for each sim API call (it alone holds the API) and handing progress
 * back every {@link FLUSH_MS} rather than at every play.
 *
 * The bundler inlines this file into the add-on as a string (`worker:` import),
 * since a Blob-loaded add-on has no URL to load a separate worker file from.
 */

import type { ApiSimulateRequest, ApiSimulation } from '@oss-idle/shared/apiV2';
import { sweep, type SweepJob, type SweepProgress } from './sweep.js';

/** How often progress goes back. */
const FLUSH_MS = 100;

export type SweepIn =
	| { type: 'job'; job: SweepJob }
	/** A sim API call's answer, or how it failed (with the HTTP status when it has one). */
	| { type: 'answer'; id: number; answer?: ApiSimulation; error?: string; status?: number };

export type SweepOut =
	| { type: 'simulate'; id: number; body: ApiSimulateRequest }
	| { type: 'progress'; progress: SweepProgress }
	| { type: 'done' }
	| { type: 'failed'; message: string; status?: number };

const post = (message: SweepOut) => (self as unknown as Worker).postMessage(message);

const calls = new Map<number, { resolve: (answer: ApiSimulation) => void; reject: (e: Error) => void }>();
let lastCall = 0;
const simulate = (body: ApiSimulateRequest) => new Promise<ApiSimulation>((resolve, reject) => {
	const id = ++lastCall;
	calls.set(id, { resolve, reject });
	post({ type: 'simulate', id, body });
});

/** Progress not yet handed back: results and errors gathered, the count as it stands. */
let pending: SweepProgress | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
const flush = () => {
	timer = undefined;
	if (pending) post({ type: 'progress', progress: pending });
	pending = undefined;
};
const gather = (progress: SweepProgress) => {
	pending = pending
		? { ...progress, results: [...pending.results, ...progress.results], errors: [...pending.errors, ...progress.errors] }
		: progress;
	timer ??= setTimeout(flush, FLUSH_MS);
};

const run = async (job: SweepJob) => {
	try {
		await (await sweep(job, simulate, gather)).finished;
		clearTimeout(timer);
		flush();
		post({ type: 'done' });
	} catch (e) {
		clearTimeout(timer);
		flush();
		post({ type: 'failed', message: e instanceof Error ? e.message : String(e), status: (e as { status?: number }).status });
	}
};

self.onmessage = ({ data }: MessageEvent<SweepIn>) => {
	if (data.type === 'job') {
		void run(data.job);
		return;
	}
	const call = calls.get(data.id);
	calls.delete(data.id);
	if (!call) return;
	if (data.answer) call.resolve(data.answer);
	else call.reject(Object.assign(new Error(data.error ?? 'the sim API call failed'), { status: data.status }));
};
