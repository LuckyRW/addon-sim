/**
 * oss!idle sim.
 *
 * The panel is mounted for the add-on's whole life and only *hidden* when
 * closed. Rendering `null` instead would unmount the React tree, which throws
 * away a sweep's results and runs the cleanup that cancels the worker - so
 * closing the overlay would quietly abandon the scan the player is waiting on.
 */

import { gameDb } from '@oss-idle/addon-sdk';
import { ReactAddon } from '@oss-idle/addon-sdk/react';
import type { ReactNode } from 'react';
import App from './ui/App.js';
import { popovers } from './ui/escape.js';
import { keepFocus } from './focus.js';
import styles from './ui/styles.css';

const TOGGLE = 'Ctrl+Shift+F';
const OVERLAY_ID = 'osu-idle-sim';

export class SimAddon extends ReactAddon {

	private open = false;

	/** Undoes what holds the keyboard while the panel is open. */
	private release?: () => void;

	constructor() {
		super({ name: 'oss!idle sim', overlayId: OVERLAY_ID, styles });
	}

	protected override async onReady(): Promise<void> {
		// Capture phase, so the combo never reaches the game's own handlers.
		this.own(this.hotkeys.register(TOGGLE, () => this.toggle(), { allowInText: true }));
		this.own(() => this.release?.());

		this.log.info(`ready - press ${TOGGLE} to open`);

		// The client opens its database lazily; warn rather than fail silently if
		// it never appears, since every query the overlay makes depends on it.
		gameDb.ready().catch(() => this.log.warn('game database never opened'));
	}

	private toggle(): void {
		this.open = !this.open;
		if (this.open) this.hold();
		else {
			this.release?.();
			this.release = undefined;
		}
		this.refresh();
	}

	/** Escape and typing belong to the panel while it is open, and to the game otherwise. */
	private hold(): void {
		const host = document.getElementById(OVERLAY_ID)!;
		const stopFocus = keepFocus(host);
		const stopEscape = this.hotkeys.register('Escape', () => {
			const popover = [...popovers].at(-1);
			if (popover) popover();
			else this.toggle();
		}, { allowInText: true });
		this.release = () => {
			stopEscape();
			stopFocus();
			// once unguarded, so the game takes focus back to its own box
			(host.shadowRoot?.activeElement as HTMLElement | null)?.blur();
		};
	}

	protected render(): ReactNode {
		return <App open={this.open} onClose={() => this.toggle()} version={this.meta.version ?? ''} />;
	}
}
