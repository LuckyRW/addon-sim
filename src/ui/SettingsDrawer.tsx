import { useEffect } from 'react';
import type { Settings } from './App.js';
import { popovers } from './escape.js';
import RatePicker from './RatePicker.js';
import { Skills } from '@oss-idle/shared/rulesets/mania/4k/skills';
import { NumberField, skillLabel } from './parts.js';

/** Everything that tunes the simulation, out of the way of the playlist. */
export default function SettingsDrawer({ settings: s, update, steps, ownLevels, onClose }: {
	settings: Settings;
	update: (patch: Partial<Settings>) => void;
	/** Every rate the character has unlocked. */
	steps: number[];
	/** The character's own play levels, by skill. */
	ownLevels: Record<string, number>;
	onClose: () => void;
}) {
	// Escape closes the drawer before the panel
	useEffect(() => {
		popovers.add(onClose);
		return () => { popovers.delete(onClose); };
	}, [onClose]);

	const check = (key: 'applyMindblock' | 'excludeFailed' | 'oneMapPerSet' | 'balanceSkills' | 'rankWeakest' | 'fastScan' | 'liveMaps' | 'baseXp', label: string, help?: string) => (
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
					<label className="check">
						<input type="checkbox" checked={!!s.memorized} onChange={e => update({ memorized: e.target.checked })} />
						<span>Fully memorized maps
							<span className="help">Simulate every map as if played enough to memorize it, whatever your own plays: the scan, Target, #1s and Bottlenecks. Re-scan after changing it.</span>
						</span>
					</label>
					<label className="check">
						<input type="checkbox" checked={s.scanAtPeak} onChange={e => update({ scanAtPeak: e.target.checked })} />
						<span>Scan at peak warm-up
							<span className="help">Off: play the library at the fatigue below, so All maps shows XP/s at that tiredness. The playlist still forecasts warm-up and fatigue.</span>
						</span>
					</label>
					{!s.scanAtPeak && (
						<div className="field">
							<label htmlFor="scan-minutes">Fatigue to scan at (strained minutes)<span className="help">0 is rested and cold; the peak is about 100, pushing from about 154, tired from 300.</span></label>
							<NumberField id="scan-minutes" min={0} max={420} value={s.scanMinutes} onChange={scanMinutes => update({ scanMinutes })} />
						</div>
					)}
					<div className="field">
						<label htmlFor="runs">Runs per map<span className="help">The best maps are averaged over this many plays. More is steadier, and asks the sim API more often; plays already asked for are reused.</span></label>
						<NumberField id="runs" min={1} max={10} integer value={s.runs} onChange={runs => update({ runs })} />
					</div>
					<div className="field">
						<label htmlFor="refine-maps">Best maps checked thoroughly<span className="help">A scan first plays every map once. This many of the best are then played again at each rate near their best, Runs per map times, with memory as a session has it: what the ··· on a row does. Set it above your library's size to check every map, for many more sim calls.</span></label>
						<NumberField id="refine-maps" min={0} max={10000} integer value={s.refineMaps} onChange={refineMaps => update({ refineMaps })} />
					</div>
					<label className="check">
						<input type="checkbox" checked={s.refineEveryRate} onChange={e => update({ refineEveryRate: e.target.checked })} />
						<span>Check every rate of the best maps
							<span className="help">Refining plays each of those maps at every rate you have, not only the 3 or 4 near its best: no rate is skipped, for several times the sim calls (about 20 rates a map with every speed upgrade).</span>
						</span>
					</label>

					<h3 className="label">Session</h3>
					<div className="field">
						<label htmlFor="delay">Autopilot delay (s)<span className="help">From your game settings unless changed here. You rest between maps.</span></label>
						<NumberField
							id="delay" min={0} max={600} value={s.delaySec}
							onChange={delaySec => update({ delaySec, delayTouched: true })}
						/>
					</div>

					<h3 className="label">Maps</h3>
					{check('applyMindblock', "Count today's plays", 'Mindblock: maps you replayed today earn less')}
					{check('baseXp', 'Rank on base XP', 'Compare maps without upgrades, overdrive, prestige, medals and mods. Their XP / s shows base XP; the Average on the playlist stays what you really earn')}
					{check('excludeFailed', 'Leave out maps failed over half the time')}
					{check('oneMapPerSet', 'One difficulty per mapset')}
					{check('liveMaps', 'Fill the maps list during scans', 'Off: the All maps list waits for the scan to finish')}
					{check('fastScan', 'Fast scan', 'Simulate the maps players near your level played lately, and 15% of the rest: far fewer sim calls')}
					{check('balanceSkills', 'Balance several skills', 'Off: add up their weighted XP, so the skill with the most XP to give takes most plays')}
					{check('rankWeakest', 'Rank on the weakest skill', 'Each map is worth only the least of its weighted skills’ XP (XP times the multiplier): 10 stamina / 8 jack speed beats 15 / 7. Overrides balancing; the maps list shows which skill and how much. Pair with Rank on base XP to compare base XP')}

					<h3 className="label">Levels</h3>
					<p className="help">Simulate the character at these levels instead of its own: a level set here starts with no XP into it. Scans and the Target tab use them.</p>
					<div className="level-grid">
						{Skills.map(skill => {
							const own = ownLevels[skill];
							const set = s.levels?.[skill];
							return (
								<label key={skill} className={`level-field${set === undefined ? '' : ' is-set'}`}>
									<span>{skillLabel(skill)}</span>
									<NumberField
										aria-label={`${skillLabel(skill)} level`} min={0} max={1000} integer
										value={set ?? own ?? 0}
										onChange={level => {
											const next = { ...s.levels };
											if (level === own) delete next[skill];
											else next[skill] = level;
											update({ levels: next });
										}}
									/>
								</label>
							);
						})}
					</div>
					<button className="level-reset" disabled={!Object.keys(s.levels ?? {}).length} onClick={() => update({ levels: {} })}>Use my levels</button>
					<p className="help">Rates, Hard Rock, runs and levels apply on the next scan.</p>
				</div>
			</aside>
		</>
	);
}
