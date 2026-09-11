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

/** WebAssembly inlined into the add-on bundle as base64 (see `assetQueryPlugin`). */
declare module '*?base64' {
	const base64: string;
	export default base64;
}
