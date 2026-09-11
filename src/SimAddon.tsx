/**
 * osu!idle sim.
 *
 * The panel is mounted for the add-on's whole life and only *hidden* when
 * closed. Rendering `null` instead would unmount the React tree, which throws
 * away a sweep's results and runs the cleanup that cancels the worker - so
 * closing the overlay would quietly abandon the scan the player is waiting on.
 */

import { gameDb } from '@osu-idle/addon-sdk';
import { ReactAddon } from '@osu-idle/addon-sdk/react';
import type { ReactNode } from 'react';
import App from './ui/App.js';
import styles from './ui/styles.css';

const TOGGLE = 'Ctrl+Shift+F';

/** Shown in the overlay header, so a stale pasted bundle is obvious at a glance. */
const VERSION = '0.4.1';

export class SimAddon extends ReactAddon {

	private open = false;

	constructor() {
		super({ name: 'osu!idle sim', version: VERSION, overlayId: 'osu-idle-sim', styles });
	}

	protected override async onReady(): Promise<void> {
		// Capture phase, so the combo never reaches the game's own handlers.
		this.own(this.hotkeys.register(TOGGLE, () => this.toggle(), { allowInText: true }));
		this.own(this.hotkeys.register('Escape', () => {
			if (this.open) this.toggle();
		}, { allowInText: true }));

		this.log.info(`ready - press ${TOGGLE} to open`);

		// The client opens its database lazily; warn rather than fail silently if
		// it never appears, since every query the overlay makes depends on it.
		gameDb.ready().catch(() => this.log.warn('game database never opened'));
	}

	private toggle(): void {
		this.open = !this.open;
		this.refresh();
	}

	protected render(): ReactNode {
		return <App open={this.open} onClose={() => this.toggle()} version={VERSION} />;
	}
}
