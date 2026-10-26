import { useEffect } from 'react';
import type { Settings } from './App.js';
import { popovers } from './escape.js';
import RatePicker from './RatePicker.js';

/** Everything that tunes the simulation, out of the way of the playlist. */
export default function SettingsDrawer({ settings: s, update, steps, onClose }: {
	settings: Settings;
	update: (patch: Partial<Settings>) => void;
	/** Every rate the character has unlocked. */
	steps: number[];
	onClose: () => void;
}) {
	// Escape closes the drawer before the panel
	useEffect(() => {
		popovers.add(onClose);
		return () => { popovers.delete(onClose); };
	}, [onClose]);

	const check = (key: 'applyMindblock' | 'excludeFailed' | 'oneMapPerSet' | 'includeUnranked', label: string, help?: string) => (
		<label className="check">
			<input type="checkbox" checked={s[key]} onChange={e => update({ [key]: e.target.checked })} />
			<span>{label}{help && <span className="help">{help}</span>}</span>
		</label>
	);

	return (
		<>
			<div className="drawer-shade" onClick={onClose} />
			<aside className="drawer" aria-label="Settings">
				<div className="drawer-head">
					<h2>Settings</h2>
					<span className="spacer" />
					<button className="icon" aria-label="Close settings" onClick={onClose}>
						<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" /></svg>
					</button>
				</div>
				<div className="drawer-body">
					<h3 className="label">What to try</h3>
					<div className="field column">
						<span>Rates</span>
						<RatePicker steps={steps} excluded={s.excludedRates} onChange={excluded => update({ excludedRates: excluded })} />
					</div>
					<label className="check">
						<input type="checkbox" checked={s.tryHardRock} onChange={e => update({ tryHardRock: e.target.checked })} />
						<span>Try Hard Rock
							<span className="help">+10% accuracy XP, tighter hit windows. Each map keeps whichever earns more. Doubles the scan.</span>
						</span>
					</label>
					<div className="field">
						<label htmlFor="runs">Runs per map<span className="help">The best maps are averaged over this many plays. More is steadier, slower.</span></label>
						<input
							id="runs" type="number" min={1} max={10} value={s.runs}
							onChange={e => update({ runs: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })}
						/>
					</div>

					<h3 className="label">Session</h3>
					<div className="field">
						<label htmlFor="delay">Autopilot delay (s)<span className="help">From your game settings unless changed here. You rest between maps.</span></label>
						<input
							id="delay" type="number" min={0} max={600} value={s.delaySec}
							onChange={e => update({ delaySec: Math.max(0, Number(e.target.value) || 0), delayTouched: true })}
						/>
					</div>

					<h3 className="label">Maps</h3>
					{check('applyMindblock', "Count today's plays", 'Mindblock: maps you replayed today earn less')}
					{check('excludeFailed', 'Leave out maps failed over half the time')}
					{check('oneMapPerSet', 'One difficulty per mapset')}
					{check('includeUnranked', 'Include unranked maps', 'They give a signed-in character no XP')}
					<p className="help">Rates, Hard Rock, runs and unranked maps apply on the next scan.</p>
				</div>
			</aside>
		</>
	);
}
