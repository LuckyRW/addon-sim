/** The bundler loads `.css` imports as strings for the overlay's shadow root. */
declare module '*.css' {
	const css: string;
	export default css;
}
