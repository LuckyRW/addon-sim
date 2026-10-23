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
import styles from './ui/styles.css';

const TOGGLE = 'Ctrl+Shift+F';

export class SimAddon extends ReactAddon {

	private open = false;

	/** Escape, taken only while the panel is open: closed, it is the game's. */
	private escape?: () => void;

	constructor() {
		super({ name: 'oss!idle sim', overlayId: 'osu-idle-sim', styles });
	}

	protected override async onReady(): Promise<void> {
		// Capture phase, so the combo never reaches the game's own handlers.
		this.own(this.hotkeys.register(TOGGLE, () => this.toggle(), { allowInText: true }));

		this.log.info(`ready - press ${TOGGLE} to open`);

		// The client opens its database lazily; warn rather than fail silently if
		// it never appears, since every query the overlay makes depends on it.
		gameDb.ready().catch(() => this.log.warn('game database never opened'));
	}

	private toggle(): void {
		this.open = !this.open;
		this.escape?.();
		// a popover open in the panel closes before the panel does
		this.escape = this.open
			? this.hotkeys.register('Escape', () => {
				const popover = [...popovers].at(-1);
				if (popover) popover();
				else this.toggle();
			}, { allowInText: true })
			: undefined;
		this.refresh();
	}

	protected render(): ReactNode {
		return <App open={this.open} onClose={() => this.toggle()} version={this.meta.version ?? ''} />;
	}
}
