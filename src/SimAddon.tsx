/**
 * oss!idle sim.
 *
 * The panel is mounted for the add-on's whole life and only *hidden* when
 * closed. Rendering `null` instead would unmount the React tree, which throws
 * away a sweep's results and runs the cleanup that cancels it - so
 * closing the overlay would quietly abandon the scan the player is waiting on.
 */

import type { ScoutApi } from './engine/scout.js';
import { gameCharacter, gameDb } from '@oss-idle/addon-sdk';
import { recordPlays } from './engine/seven.js';
import { ReactAddon } from '@oss-idle/addon-sdk/react';
import type { ReactNode } from 'react';
import type { Simulate } from './engine/client.js';
import App from './ui/App.js';
import LastPlayBox from './ui/LastPlayBox.js';
import { popovers } from './ui/escape.js';
import styles from './ui/styles.css';

const TOGGLE = 'Ctrl+Shift+F';

export class SimAddon extends ReactAddon {

	private open = false;

	/** Bumped on each 7K play recorded: the 7K tab and the song select box read the record again. */
	private sevenVersion = 0;
	private characterId?: number;

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

		// 7K plays, recorded off the game's socket as they finish (7K has no sim)
		const whose = async () => { try { this.characterId = (await gameCharacter.live())?.id; } catch { /* not open yet */ } };
		void whose();
		const timer = setInterval(() => void whose(), 10_000);
		this.own(() => clearInterval(timer));
		this.own(recordPlays(() => this.characterId, () => { this.sevenVersion++; this.refresh(); }));
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

	/** The sim API, as the signed-in player: oss!idle 1.3 hands add-ons API v2 (`host.api`). */
	private simulate: Simulate = body => {
		const api = (this.host as { api?: { simulate: Simulate } } | undefined)?.api;
		if (!api) return Promise.reject(new Error('This game hands add-ons no API: update oss!idle to 1.3.'));
		return api.simulate(body);
	};

	protected render(): ReactNode {
		return (
			<>
				<App
					open={this.open} onClose={() => this.toggle()} version={this.meta.version ?? ''} sevenVersion={this.sevenVersion}
					simulate={body => this.simulate(body)}
					scout={(this.host as { api?: ScoutApi } | undefined)?.api}
				/>
				{/* song select's last-play box: shown with the panel closed too */}
				{!this.open && <LastPlayBox sevenVersion={this.sevenVersion} />}
			</>
		);
	}
}
