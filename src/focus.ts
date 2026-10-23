/**
 * Keeping the player's typing in the sim's fields.
 *
 * oss!idle 1.2 holds focus in the topmost game surface's box (song select's
 * search, the chat): it takes focus back whenever focus moves somewhere that is
 * not a form field, and moves it there on any printable key typed outside a
 * text field. It judges both by `document.activeElement`, which for a field in
 * this overlay's shadow tree is the shadow host, a plain div. So, unguarded, the
 * game takes focus from every sim field and each digit typed lands in its box.
 */

type Disposer = () => void;

const within = (host: HTMLElement, node: EventTarget | null) =>
	node instanceof Node && host.contains(node);

/**
 * While this runs, focus that moves into or out of `host` never makes the game
 * take it back, and a key typed in one of its fields stays in that field.
 * ponytail: works around the game reading `document.activeElement`; drop it once
 * oss!idle looks into shadow roots.
 */
export const keepFocus = (host: HTMLElement): Disposer => {
	// Ahead of the game's own focusout listener on `document`.
	const onFocusOut = (event: FocusEvent) => {
		if (within(host, event.target) || within(host, event.relatedTarget)) event.stopPropagation();
	};
	// After the game's capture listener, still within the key's dispatch: put
	// focus back before the key types anything.
	const onKeyDown = (event: KeyboardEvent) => {
		const field = event.composedPath()[0];
		if (within(host, event.target) && document.activeElement !== host && field instanceof HTMLElement) {
			field.focus({ preventScroll: true });
		}
	};
	window.addEventListener('focusout', onFocusOut, { capture: true });
	window.addEventListener('keydown', onKeyDown, { capture: true });
	return () => {
		window.removeEventListener('focusout', onFocusOut, { capture: true });
		window.removeEventListener('keydown', onKeyDown, { capture: true });
	};
};
