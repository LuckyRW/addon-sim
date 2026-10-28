/** The bundler loads `.css` imports as strings for the overlay's shadow root. */
declare module '*.css' {
	const css: string;
	export default css;
}

/** `worker:` imports are inlined and spawn the worker from a Blob URL. */
declare module 'worker:*' {
	const createWorker: () => Worker;
	export default createWorker;
}
