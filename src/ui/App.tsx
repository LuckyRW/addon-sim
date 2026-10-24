/**
 * The farm overlay.
 *
 * One screen: sweep the library, rank it by XP per second toward a chosen
 * target, and turn the top of that ranking into a playlist.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Skills } from '@oss-idle/shared/skills';
import {
	rateLabel,
	rateSteps,
	versionLabel,
} from '@oss-idle/shared/rate';
import {
	createSettings,
	gameCharacter,
	recentPlayCounts,
	type CharacterRow,
} from '@oss-idle/addon-sdk';
import { usePersistedSettings } from '@oss-idle/addon-sdk/react';
import {
	collectCharts,
	libraryIndex,
	medalMultiplier,
	ratesFor,
	runSweep,
	type MapInfo,
	type Sweep,
} from '../engine/client.js';
import type { SimRequest, SimResult } from '../engine/protocol.js';
import {
	buildBalancedDualRotation,
	buildMaxXpRotation,
	buildRotation,
	PLAYS_PER_MAP,
	rankMaps,
	refinePlan,
	rowKey,
	screenRates,
	tableRows,
	type FarmTarget,
	type RankedMap,
} from '../farm/metrics.js';
import { optimizeSingleSkill } from '../farm/optimizer.js';
import RatePicker from './RatePicker.js';
import { replacePlaylist, type RateLock } from '../engine/playlist.js';

type Phase =
	| { kind: 'idle' }
	| { kind: 'scanning'; label: string; done: number; total: number }
	| { kind: 'ready' }
	| { kind: 'error'; message: string };

const SKILL_NAMES = Skills as unknown as string[];

type Settings = {
	targetSkill: string;
	overheadSec: number;
	runs: number;
	excludedRates: number[];
	excludeFailed: boolean;
	applyMindblock: boolean;
	oneMapPerSet: boolean;
	severalRates: boolean;
	lockRates: RateLock;
	playlistSize: number;
	playlistName: string;
	playlistNameTouched: boolean;
	characterId: number;
	characterPinned: boolean;
};

const DEFAULTS: Settings = {
	targetSkill: 'total',
	overheadSec: 8,
	runs: 3,
	excludedRates: [],
	excludeFailed: true,
	applyMindblock: true,
	oneMapPerSet: false,
	severalRates: false,
	lockRates: 'all',
	playlistSize: 5,
	playlistName: 'Farm: total',
	playlistNameTouched: false,
	characterId: 0,
	characterPinned: false,
};

const settingsStore = createSettings<Settings>('osu-idle-sim', DEFAULTS);

const REFINE_MAPS = 50;

const rankOptions = (
	{ applyMindblock, overheadSec, excludeFailed }: Settings,
	target: FarmTarget,
	recent: Map<number, number>,
	medals: number,
) => ({
	target,
	recentPlays: applyMindblock ? recent : new Map<number, number>(),
	overheadSec,
	maxFailRate: excludeFailed ? 0.5 : 1,
	medalMultiplier: medals,
});

const formatRate = (rate: number) =>
	rate >= 100 ? rate.toFixed(0) : rate >= 10 ? rate.toFixed(1) : rate.toFixed(2);

const PP_NOTE = 'Ranked by the pp a play would score, not by pp per second: '
	+ 'only your best score on a map counts, so playing it faster earns nothing extra. '
	+ 'Mindblock scales XP, not score, so it is ignored here.';

const formatTime = (seconds: number) => {
	const total = Math.round(seconds);
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

export default function App({
	open,
	onClose,
	version,
}: {
	open: boolean;
	onClose: () => void;
	version: string;
}) {
	const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
	const [results, setResults] = useState<SimResult[]>([]);
	const [index, setIndex] = useState<Map<number, MapInfo>>(new Map());
	const [recent, setRecent] = useState<Map<number, number>>(new Map());
	const [medals, setMedals] = useState<number | null | undefined>(undefined);
	const [errorCount, setErrorCount] = useState(0);
	const [duplicateCount, setDuplicateCount] = useState(0);

	const [settings, update] = usePersistedSettings(settingsStore, DEFAULTS);
	const {
		targetSkill, overheadSec, runs, excludedRates,
		excludeFailed, applyMindblock, oneMapPerSet, severalRates, lockRates,
		playlistSize, playlistName,
	} = settings;

	const [characters, setCharacters] = useState<CharacterRow[]>([]);
	const [characterId, setCharacterId] = useState<number | undefined>(
		settings.characterPinned ? settings.characterId : undefined,
	);
	const [saveState, setSaveState] = useState<string>('');

	const sweepRef = useRef<Sweep | undefined>(undefined);

	const refreshCharacters = useCallback(async () => {
		const [rows, detected] = await Promise.all([gameCharacter.list(), gameCharacter.live()]);
		setCharacters(rows);
		setCharacterId(previous => {
			if (previous !== undefined && rows.some(row => row.id === previous)) return previous;
			return detected?.id ?? rows[0]?.id;
		});
	}, []);

	useEffect(() => {
		if (open) void refreshCharacters();
	}, [open, refreshCharacters]);

	const target: FarmTarget = useMemo(() => {
		if (targetSkill === 'total') return { kind: 'total' };
		if (targetSkill === 'pp') return { kind: 'pp' };
		return { kind: 'skill', skill: targetSkill };
	}, [targetSkill]);

	useEffect(() => {
		if (!settings.playlistNameTouched) update({ playlistName: `Farm: ${targetSkill}` });
	}, [targetSkill, settings.playlistNameTouched, update]);

	const ranked: RankedMap[] = useMemo(
		() => rankMaps(results, rankOptions(settings, target, recent, medals ?? 1)),
		[results, target, recent, applyMindblock, overheadSec, excludeFailed, medals],
	);

	const rotation = useMemo(() => buildRotation(ranked, {
		size: playlistSize,
		target,
		overheadSec,
		oneMapPerSet,
		medalMultiplier: medals ?? 1,
		mixRates: lockRates !== 'none',
		severalRates,
	}), [ranked, playlistSize, target, overheadSec, oneMapPerSet, medals, lockRates, severalRates]);

	const oneRate = lockRates === 'none' ? ` at ${rateLabel(rotation[0]?.rate ?? 1)}` : '';

	const rotationIds = useMemo(
		() => new Set(rotation.map(rowKey)),
		[rotation],
	);

	const rows = useMemo(() => tableRows(ranked, rotation), [ranked, rotation]);
	const simulatedMaps = useMemo(() => new Set(results.map(map => map.beatmapId)).size, [results]);

	const speedUpgrades = Number(characters.find(row => row.id === characterId)?.speedUpgrades) || 0;
	const steps = rateSteps(speedUpgrades);
	const noRates = steps.every(step => excludedRates.includes(step));

	const scan = useCallback(async () => {
		setSaveState('');
		setPhase({ kind: 'scanning', label: 'Screening', done: 0, total: 0 });
		try {
			await refreshCharacters();
			const [survey, maps, character] = await Promise.all([
				collectCharts(),
				libraryIndex(),
				characterId === undefined ? gameCharacter.live() : gameCharacter.byId(characterId),
			]);
			setIndex(maps);
			const [recentPlays, multiplier] = character
				? await Promise.all([recentPlayCounts(Number(character.id)), medalMultiplier(character)])
				: [new Map<number, number>(), 1];
			setRecent(recentPlays);
			setMedals(multiplier ?? null);

			if (!survey.requests.length) {
				const detail = survey.sets === 0
					? 'The beatmap store is empty - download a map in song select first.'
					: `Found ${survey.sets} set(s), but none of their ${survey.versions} difficulties are 4K mania.`;
				setPhase({ kind: 'error', message: `Nothing to simulate. ${detail}` });
				return;
			}

			const rates = ratesFor(Number(character?.speedUpgrades) || 0, excludedRates);
			const screened = screenRates(rates);

			setResults([]);
			setErrorCount(0);
			setDuplicateCount(survey.duplicates);

			let pending: SimResult[] = [];
			let pendingErrors = 0;
			let shownAt = 0;
			let phaseAt = 0;
			const show = () => {
				const batch = pending;
				pending = [];
				shownAt = Date.now();
				if (batch.length) setResults(previous => {
					const fresh = new Set(batch.map(rowKey));
					return [...previous.filter(map => !fresh.has(rowKey(map))), ...batch];
				});
				if (pendingErrors) {
					const count = pendingErrors;
					pendingErrors = 0;
					setErrorCount(previous => previous + count);
				}
			};

			const pass = async (label: string, requests: SimRequest[], passRuns: number) => {
				setPhase({ kind: 'scanning', label, done: 0, total: requests.length });
				const sweep = await runSweep(requests, {
					runs: passRuns, characterId, memoryAhead: PLAYS_PER_MAP / 2,
				}, progress => {
					pending.push(...progress.results);
					pendingErrors += progress.errors.length;
					const now = Date.now();
					if (now - phaseAt >= 200) {
						phaseAt = now;
						setPhase({ kind: 'scanning', label, done: progress.done, total: progress.total });
					}
					if (now - shownAt >= 1000) show();
				});
				sweepRef.current = sweep;
				const outcome = await sweep.finished;
				show();
				return outcome;
			};

			const screening = await pass('Screening', survey.requests.map(map => ({ ...map, rates: screened })), 1);
			if (!screening.cancelled && (runs > 1 || screened.length < rates.length)) {
				const best = rankMaps(screening.results, rankOptions(settings, target, recentPlays, multiplier ?? 1));
				await pass('Refining', refinePlan(best, rates, screened, REFINE_MAPS), runs);
			}
			setPhase({ kind: 'ready' });
		} catch (e) {
			setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
		}
	}, [runs, excludedRates, characterId, refreshCharacters, settings, target]);

	useEffect(() => () => sweepRef.current?.cancel(), []);

	const savePlaylist = useCallback(async () => {
		if (!rotation.length) return;
		setSaveState('saving');
		try {
			const { created } = await replacePlaylist(playlistName, rotation, lockRates);
			setSaveState(
				`${created ? 'Created' : 'Replaced'} "${playlistName}" - ${rotation.length} maps`
				+ `${oneRate}. Reopen song select to see it.`,
			);
		} catch (e) {
			setSaveState(e instanceof Error ? e.message : String(e));
		}
	}, [rotation, playlistName, lockRates, oneRate]);

	const saveDualFarmPlaylist = useCallback(async () => {
		if (!results.length) return;
		setSaveState('saving');
		try {
			const dualRotation = buildBalancedDualRotation({
				allResults: results,
				overheadSec,
				medalMultiplier: medals ?? 1,
				maxCoordStrainShare: 0.06,
				idleBufferMinutes: 0.25,
			});

			if (!dualRotation.length) {
				setSaveState('No maps matched low-strain coordination criteria.');
				return;
			}

			const dualName = '⚡ Dual Farm (Coord + Speed)';
			const { created } = await replacePlaylist(dualName, dualRotation, 'all');
			const netDelta = dualRotation.reduce((acc, m) => acc + (m.fatigue?.deltaMinutes ?? 0), 0);

			setSaveState(
				`${created ? 'Created' : 'Replaced'} "${dualName}" (${dualRotation.length} maps, Net Δ: ${netDelta >= 0 ? '+' : ''}${netDelta.toFixed(2)}m/cycle). Reopen song select to see it.`
			);
		} catch (e) {
			setSaveState(e instanceof Error ? e.message : String(e));
		}
	}, [results, overheadSec, medals]);

	const saveMaxXpPlaylist = useCallback(async () => {
		if (!results.length) return;
		setSaveState('saving');
		try {
			const maxRotation = buildMaxXpRotation({
				allResults: results,
				target,
				size: playlistSize,
				overheadSec,
				medalMultiplier: medals ?? 1,
				maxFailRate: excludeFailed ? 0.5 : 1,
			});

			if (!maxRotation.length) {
				setSaveState('No maps available to build playlist.');
				return;
			}

			const targetName = targetSkill === 'total' ? 'Total' : targetSkill.charAt(0).toUpperCase() + targetSkill.slice(1);
			const maxName = `🔥 Max ${targetName} XP/s`;
			const { created } = await replacePlaylist(maxName, maxRotation, 'all');

			setSaveState(
				`${created ? 'Created' : 'Replaced'} "${maxName}" (${maxRotation.length} maps). Reopen song select to see it.`
			);
		} catch (e) {
			setSaveState(e instanceof Error ? e.message : String(e));
		}
	}, [results, target, playlistSize, overheadSec, medals, excludeFailed, targetSkill]);

	const saveSmartOptimizedPlaylist = useCallback(async () => {
		if (!results.length) return;
		setSaveState('saving');
		try {
			const optimal = optimizeSingleSkill({
				allResults: results,
				target,
				maxHourlyStrain: 7.5,
				maxPlaylistSize: playlistSize,
				overheadSec,
				medalMultiplier: medals ?? 1,
				maxFailRate: excludeFailed ? 0.5 : 1,
				maxBurstDurationSec: 135,
			});

			if (!optimal.rotation.length) {
				setSaveState('No eligible maps found for optimization.');
				return;
			}

			const targetName = targetSkill === 'total' ? 'Total' : targetSkill.charAt(0).toUpperCase() + targetSkill.slice(1);
			const playlistTitle = `🧠 Opt ${targetName} (<=7.5m/h)`;
			const { created } = await replacePlaylist(playlistTitle, optimal.rotation, 'all');

			const xpRate = (optimal.expectedXpPerSec ?? optimal.projectedXpPerSec ?? 0).toFixed(1);
			const strainRate = (optimal.hourlyStrainRate ?? 0).toFixed(1);

			setSaveState(
				`${created ? 'Created' : 'Replaced'} "${playlistTitle}" (${optimal.rotation.length} maps, ${xpRate} XP/s, Strain: +${strainRate}m/hr). Reopen song select to see it.`
			);
		} catch (e) {
			setSaveState(e instanceof Error ? e.message : String(e));
		}
	}, [results, target, playlistSize, overheadSec, medals, excludeFailed, targetSkill]);

	const scanning = phase.kind === 'scanning';

	return (
		<div style={{ display: open ? 'contents' : 'none' }} aria-hidden={!open}>
			<div className="backdrop" onClick={onClose} />
			<div className="panel" role="dialog" aria-label="oss!idle sim">
				<header>
					<h1>oss!idle sim</h1>
					<span className="hint">
						XP/second across your downloaded maps, simulated for your character
					</span>
					<span className="spacer" />
					<span className="hint">v{version} - Ctrl+Shift+F</span>
					<button onClick={onClose}>Close</button>
				</header>

				<div className="controls">
					<label title="The client keeps the live character in memory, out of reach of an add-on - so this is a best guess. Check it matches who you are playing.">
						Character
						<select
							value={characterId ?? ''}
							onChange={e => {
								const id = Number(e.target.value);
								setCharacterId(id);
								update({ characterId: id, characterPinned: true });
							}}
						>
							{characters.map(row => (
								<option key={row.id} value={row.id}>
									{row.name} - lv {row.overallLevel}{row.local ? ' (guest)' : ''}
								</option>
							))}
						</select>
					</label>

					<label>
						Target
						<select value={targetSkill} onChange={e => update({ targetSkill: e.target.value })}>
							<option value="total">Total XP</option>
							<option value="pp">pp</option>
							{SKILL_NAMES.map(skill => (
								<option key={skill} value={skill}>{skill}</option>
							))}
						</select>
					</label>

					<label
						title="Result screen, transitions and song load - paid on every play. Unused when ranking by pp."
						style={{ opacity: targetSkill === 'pp' ? 0.45 : undefined }}
					>
						Overhead (s)
						<input
							type="number" min={0} max={60} value={overheadSec}
							onChange={e => update({ overheadSec: Number(e.target.value) || 0 })}
						/>
					</label>

					<label title={`The simulation is stochastic. Every map is screened once, then the best ${REFINE_MAPS} are averaged over this many attempts - more steadies the top of the ranking, at a linear cost in that pass`}>
						Runs / map
						<input
							type="number" min={1} max={10} value={runs}
							onChange={e => update({ runs: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })}
						/>
					</label>

					<div className="field" title="Every map is screened at every third rate, and the best ones filled in at the rates around their best. A playlist plays at one rate unless its entries are locked.">
						Rates
						<RatePicker
							steps={steps}
							excluded={excludedRates}
							onChange={excluded => update({ excludedRates: excluded })}
						/>
					</div>

					<label className="check">
						<input
							type="checkbox" checked={applyMindblock}
							onChange={e => update({ applyMindblock: e.target.checked })}
						/>
						Account for today&apos;s plays (mindblock)
					</label>

					<label className="check">
						<input
							type="checkbox" checked={excludeFailed}
							onChange={e => update({ excludeFailed: e.target.checked })}
						/>
						Hide maps you usually fail
					</label>

					<label
						className="check"
						title="Mindblock counts plays per difficulty, so several difficulties of one set are independent farm targets. Tick this only if you would rather not hear the same song repeatedly."
					>
						<input
							type="checkbox" checked={oneMapPerSet}
							onChange={e => update({ oneMapPerSet: e.target.checked })}
						/>
						One difficulty per mapset
					</label>

					<label
						className="check"
						title="Mindblock counts plays per difficulty whatever the rate, so each extra rate of a difficulty is charged its plays. Needs locked rates."
						style={{ opacity: lockRates === 'none' ? 0.45 : undefined }}
					>
						<input
							type="checkbox" checked={severalRates}
							onChange={e => update({ severalRates: e.target.checked })}
						/>
						Several rates of one difficulty
					</label>

					{medals === null && (
						<span className="hint" title="The medal list comes from the game server; XP is ranked without the medal bonus.">
							Medal bonus unavailable
						</span>
					)}
					{medals != null && medals > 1 && (
						<span className="hint" title="Every medal held compounds its tier's XP bonus onto each play.">
							Medals +{((medals - 1) * 100).toFixed(1)}% XP
						</span>
					)}

					<span className="spacer" style={{ flex: 1 }} />

					<button
						className="primary" onClick={scan} disabled={scanning || noRates}
						title={noRates ? 'Pick at least one rate' : undefined}
					>
						{scanning ? 'Simulating...' : results.length ? 'Re-scan' : 'Scan library'}
					</button>
					{scanning && (
						<button onClick={() => sweepRef.current?.cancel()}>Stop</button>
					)}
				</div>

				<div className="body">
					{phase.kind === 'error' && <div className="empty error">{phase.message}</div>}

					{!results.length && phase.kind !== 'error' && (
						<div className="empty">
							{scanning
								? 'Simulating your library...'
								: <>Scan your library to rank every downloaded map by XP per second.<br />
									Every map is played by a simulation of your current character.</>}
						</div>
					)}

					{!!results.length && (
						<table>
							<thead>
								<tr>
									<th className="rank" />
									<th>Map</th>
									<th className="num">SR</th>
									<th className="num">Length</th>
									<th className="num">Acc</th>
									<th className="num">pp</th>
									{targetSkill !== 'pp' && (
										<>
											<th className="num">
												{targetSkill === 'total' ? 'Total XP' : `${targetSkill} XP`}
											</th>
											<th className="num">XP/s</th>
										</>
									)}
									<th
										className="num"
										title="Physical note strain share and net fatigue change (Δ minutes per play including overhead)"
									>
										Strain (Δ)
									</th>
									<th className="num">Fail</th>
									<th className="num">Played 24h</th>
								</tr>
							</thead>
							<tbody>
								{rows.slice(0, 300).map((map, position) => {
									const info = index.get(map.beatmapId);
									return (
										<tr
											key={rowKey(map)}
											className={rotationIds.has(rowKey(map)) ? 'picked' : undefined}
											title={rotationIds.has(rowKey(map)) ? 'In the generated playlist' : undefined}
										>
											<td className="rank">{position + 1}</td>
											<td className="map">
												<div className="title">
													{info ? `${info.artist} - ${info.title}` : `#${map.beatmapId}`}
												</div>
												<div className="sub">{versionLabel(info?.version ?? '', map.rate)}</div>
											</td>
											<td className="num">{(map.stars || info?.difficulty)?.toFixed(2) ?? '-'}</td>
											<td className="num">{formatTime(map.durationSec)}</td>
											<td className="num">{(map.accuracy * 100).toFixed(2)}%</td>
											<td className={targetSkill === 'pp' ? 'num rate' : 'num'}>
												{map.pp.toFixed(targetSkill === 'pp' ? 1 : 0)}
											</td>
											{targetSkill !== 'pp' && (
												<>
													<td className="num">{Math.round(map.value).toLocaleString()}</td>
													<td
														className="num rate"
														title={`+/- ${(map.variation * 100).toFixed(0)}% across ${map.runs} run(s)`}
													>
														{formatRate(map.perSecond)}
													</td>
												</>
											)}
											<td
												className="num"
												style={{
													color: map.fatigue?.isDrain ? '#f87171' : '#4ade80',
													fontWeight: 600,
												}}
												title={`${((map.physicalShare ?? 0) * 100).toFixed(1)}% physical strain share (${map.fatigue?.strainedMinutes.toFixed(2) ?? 0}m strained time)`}
											>
												{((map.physicalShare ?? 0) * 100).toFixed(0)}% ({map.fatigue?.formatted ?? '±0m'})
											</td>
											<td className="num">
												{map.failRate ? `${Math.round(map.failRate * 100)}%` : ''}
											</td>
											<td className="num">{map.recentPlays || ''}</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					)}
				</div>

				<footer>
					{scanning && (
						<>
							<div className="bar">
								<div style={{ width: `${phase.total ? (phase.done / phase.total) * 100 : 0}%` }} />
							</div>
							<span className="status">{phase.label} {phase.done} / {phase.total}</span>
						</>
					)}

					{!scanning && (
						<>
							<label className="check">
								Playlist
								<input
									type="text" value={playlistName}
									onChange={e => update({
								playlistName: e.target.value, playlistNameTouched: true,
							})}
								/>
							</label>
							<label className="check">
								Maps
								<input
									type="number" min={1} max={20} value={playlistSize}
									onChange={e => update({ playlistSize: Math.max(1, Number(e.target.value) || 1) })}
								/>
							</label>
							<label
								className="check"
								title="A locked entry plays at its own rate; an unlocked one follows the rate picked in song select, so an unlocked playlist sticks to one rate."
							>
								Lock rates
								<select
									value={lockRates}
									onChange={e => update({ lockRates: e.target.value as RateLock })}
								>
									<option value="all">All</option>
									<option value="rated">All but x1</option>
									<option value="none">None</option>
								</select>
							</label>
							<button
								className="primary"
								onClick={savePlaylist}
								disabled={!rotation.length || saveState === 'saving'}
							>
								{saveState === 'saving'
									? 'Saving...'
									: `Save ${rotation.length}${oneRate} as playlist`}
							</button>

							<button
								type="button"
								onClick={saveSmartOptimizedPlaylist}
								disabled={!results.length || saveState === 'saving'}
								style={{
									background: 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)',
									color: '#fff',
									fontWeight: 600,
									border: 'none',
									cursor: 'pointer',
								}}
								title="Mathematically solves the best strategy: compares Pure Sprint (-20% fatigue debuff), In-Skill Balance, and 0-Strain Rest Interleaving."
							>
								🧠 Smart Optimize
							</button>

							<button
								type="button"
								onClick={saveMaxXpPlaylist}
								disabled={!results.length || saveState === 'saving'}
								style={{
									background: 'linear-gradient(135deg, #ea580c 0%, #c2410c 100%)',
									color: '#fff',
									fontWeight: 600,
									border: 'none',
									cursor: 'pointer',
								}}
								title={`Generates a pure, unconstrained playlist of the top ${playlistSize} maps by XP/s for ${targetSkill} at their best rates.`}
							>
								🔥 Max {targetSkill === 'total' ? 'Total' : targetSkill.toUpperCase()} XP/s
							</button>

							<button
								type="button"
								onClick={saveDualFarmPlaylist}
								disabled={!results.length || saveState === 'saving'}
								style={{
									background: 'linear-gradient(135deg, #059669 0%, #047857 100%)',
									color: '#fff',
									fontWeight: 600,
									border: 'none',
									cursor: 'pointer',
								}}
								title="Picks <=6% strain Coordination maps and pairs them with high-efficiency Speed burst maps to maintain net-balanced fatigue with idle recovery buffer."
							>
								⚡ 1-Click Dual Farm
							</button>

							<span className={saveState && saveState !== 'saving' ? 'status ok' : 'status'}>
								{saveState === 'saving' ? '' : saveState}
							</span>
							<span className="spacer" style={{ flex: 1 }} />
							{targetSkill === 'pp' && (
							<span className="status" title={PP_NOTE}>
								ranked by pp per play
							</span>
						)}
							<span className="status">
								{results.length
									? `${rows.length} playable of ${simulatedMaps} simulated`
									: ''}
								{errorCount ? ` - ${errorCount} skipped` : ''}
								{duplicateCount ? ` - ${duplicateCount} duplicate` : ''}
							</span>
						</>
					)}
				</footer>
			</div>
		</div>
	);
}