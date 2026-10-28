/**
 * The overlay's side of the farm worker (`farm/farm.worker.ts`): what it sends,
 * the view it gets back, and whether that view is behind what was sent.
 */

import { useCallback, useEffect, useState } from 'react';
import type { FarmAsk, FarmIn, FarmOut, FarmSettings, FarmView } from '../farm/farm.worker.js';
import createFarmWorker from 'worker:../farm/farm.worker';

export const useFarm = (settings: FarmSettings) => {
	const [farm] = useState(() => ({
		worker: createFarmWorker(),
		/** Changes sent: the view is up to date once it has taken in as many. */
		sent: 0,
		asked: 0,
		answers: new Map<number, (value: unknown) => void>(),
	}));
	const [view, setView] = useState<FarmView>();
	const [behind, setBehind] = useState(false);

	useEffect(() => {
		farm.worker.onmessage = ({ data }: MessageEvent<FarmOut>) => {
			if (data.type === 'answer') {
				farm.answers.get(data.id)?.(data.value);
				farm.answers.delete(data.id);
				return;
			}
			// the maps list comes only when asked: the last one stands in the meantime
			setView(previous => ({ ...data, best: data.best ?? previous?.best }));
			setBehind(data.upTo < farm.sent);
		};
		return () => farm.worker.terminate();
	}, [farm]);

	const send = useCallback((message: FarmIn) => {
		setBehind(true);
		farm.worker.postMessage({ ...message, seq: ++farm.sent });
	}, [farm]);

	const ask = useCallback(<T>(question: FarmAsk) => new Promise<T>(resolve => {
		const id = ++farm.asked;
		farm.answers.set(id, resolve as (value: unknown) => void);
		farm.worker.postMessage({ ...question, id });
	}), [farm]);

	useEffect(() => send({ type: 'settings', settings }), [settings, send]);

	return { view, behind, send, ask };
};
