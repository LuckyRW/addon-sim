/**
 * The farm overlay.
 *
 * One screen: sweep the library, rank it by XP per second toward a chosen
 * target, and turn the top of that ranking into a playlist.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Skills } from '@osu-idle/shared/skills';
import {
	rateLabel,
	rateSteps,
	versionLabel,
} from '@osu-idle/shared/rate';
import {
	createSettings,
	gameCharacter,
	playlists,
	recentPlayCounts,
	type CharacterRow,
} from '@osu-idle/addon-sdk';
import { usePersistedSettings } from '@osu-idle/addon-sdk/react';
import {
	collectCharts,
	libraryIndex,
	medalMultiplier,
	runSweep,
	type MapInfo,
	type Sweep,
} from '../engine/client.js';
import type { SimResult } from '../engine/protocol.js';
import {
	buildRotation,
	rankMaps,
	rowKey,
	tableRows,
	type FarmTarget,
	type RankedMap,
} from '../farm/metrics.js';
import RatePicker from './RatePicker.js';

type Phase =
	| { kind: 'idle' }
	| { kind: 'scanning'; done: number; total: number }
	| { kind: 'ready' }
	| { kind: 'error'; message: string };

const SKILL_NAMES = Skills as unknown as string[];

/**
 * What the overlay remembers between sessions.
 *
 * Scan results are deliberately *not* stored: a library sweep is megabytes of
 * per-skill numbers, and `localStorage` is shared with the game's own settings -
 * filling it would break the client, not just this add-on.
 *
 * `characterId` is remembered only once the player has overridden the detected
 * character (`characterPinned`). Otherwise detection runs afresh each time, so
 * signing in or out is picked up instead of being overridden by a stale choice.
 */
type Settings = {
	targetSkill: string;
	overheadSec: number;
	runs: number;
	/** Unlocked rates not to simulate. */
	excludedRates: number[];
	excludeFailed: boolean;
	applyMindblock: boolean;
	oneMapPerSet: boolean;
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
	playlistSize: 5,
	playlistName: 'Farm: total',
	playlistNameTouched: false,
	characterId: 0,
	characterPinned: false,
};

const settingsStore = createSettings<Settings>('osu-idle-sim', DEFAULTS);

const formatRate = (rate: number) =>
	rate >= 100 ? rate.toFixed(0) : rate >= 10 ? rate.toFixed(1) : rate.toFixed(2);

/** pp is not affected by mindblock - see the `pp` farm target. */
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
	/**
	 * Whether the panel is showing. It is *hidden*, never unmounted: a sweep
	 * takes a while, and unmounting would throw away the results so far and
	 * cancel the worker mid-run, so closing the overlay would silently undo the
	 * scan the player is waiting on.
	 */
	open: boolean;
	onClose: () => void;
	version: string;
}) {
	const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
	const [results, setResults] = useState<SimResult[]>([]);
	const [index, setIndex] = useState<Map<number, MapInfo>>(new Map());
	const [recent, setRecent] = useState<Map<number, number>>(new Map());
	/** `undefined` until a scan has read it, `null` when the server was unreachable. */
	const [medals, setMedals] = useState<number | null | undefined>(undefined);
	const [errorCount, setErrorCount] = useState(0);
	const [duplicateCount, setDuplicateCount] = useState(0);

	const [settings, update] = usePersistedSettings(settingsStore, DEFAULTS);
	const {
		targetSkill, overheadSec, runs, excludedRates,
		excludeFailed, applyMindblock, oneMapPerSet,
		playlistSize, playlistName,
	} = settings;

	const [characters, setCharacters] = useState<CharacterRow[]>([]);
	const [characterId, setCharacterId] = useState<number | undefined>(
		settings.characterPinned ? settings.characterId : undefined,
	);
	const [saveState, setSaveState] = useState<string>('');

	const sweepRef = useRef<Sweep | undefined>(undefined);

	/**
	 * Re-read the characters.
	 *
	 * The client writes skill levels back to this row after every play
	 * (`persistSkills`), so the row is live - but this list is a snapshot, and
	 * the overlay is mounted for the add-on's whole life. Without re-reading, the
	 * level beside a character's name would be whatever it was when the game
	 * booted, while a sweep quietly used the real, current one. Refreshed
	 * whenever the panel is opened and again before each scan.
	 */
	const refreshCharacters = useCallback(async () => {
		const [rows, detected] = await Promise.all([gameCharacter.list(), gameCharacter.live()]);
		setCharacters(rows);
		setCharacterId(previous => {
			// A pinned choice wins, but only while that character still exists.
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

	// Keep the suggested playlist name in step with the target, but never
	// overwrite a name the player has typed themselves.
	useEffect(() => {
		if (!settings.playlistNameTouched) update({ playlistName: `Farm: ${targetSkill}` });
	}, [targetSkill, settings.playlistNameTouched, update]);

	const ranked: RankedMap[] = useMemo(() => rankMaps(results, {
		target,
		recentPlays: applyMindblock ? recent : new Map(),
		overheadSec,
		maxFailRate: excludeFailed ? 0.5 : 1,
		medalMultiplier: medals ?? 1,
	}), [results, target, recent, applyMindblock, overheadSec, excludeFailed, medals]);

	const rotation = useMemo(() => buildRotation(ranked, {
		size: playlistSize,
		target,
		overheadSec,
		oneMapPerSet,
		medalMultiplier: medals ?? 1,
	}), [ranked, playlistSize, target, overheadSec, oneMapPerSet, medals]);

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
		setPhase({ kind: 'scanning', done: 0, total: 0 });
		try {
			// Levels move while the overlay sits open; the sweep reads the
			// character fresh, so the label beside it should be fresh too.
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
				// Say which of the several possible causes it actually is.
				const detail = survey.sets === 0
					? 'The beatmap store is empty - download a map in song select first.'
					: `Found ${survey.sets} set(s), but none of their ${survey.versions} difficulties are 4K mania.`;
				setPhase({ kind: 'error', message: `Nothing to simulate. ${detail}` });
				return;
			}

			setResults([]);
			setErrorCount(0);
			setDuplicateCount(survey.duplicates);
			setPhase({ kind: 'scanning', done: 0, total: survey.requests.length });

			// Every results update re-ranks the whole library on the game's
			// thread - hundreds of ms at every rate - so the table catches up
			// once a second rather than on each finished map.
			let pending: SimResult[] = [];
			let shownAt = 0;
			const show = () => {
				const batch = pending;
				pending = [];
				shownAt = Date.now();
				if (batch.length) setResults(previous => [...previous, ...batch]);
			};

			const sweep = await runSweep(survey.requests, {
				runs, characterId, excludedRates,
			}, progress => {
				setPhase({ kind: 'scanning', done: progress.done, total: progress.total });
				pending.push(...progress.results);
				if (Date.now() - shownAt >= 1000) show();
				if (progress.errors.length) {
					setErrorCount(previous => previous + progress.errors.length);
				}
			});
			sweepRef.current = sweep;

			await sweep.finished;
			show();
			setPhase({ kind: 'ready' });
		} catch (e) {
			setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
		}
	}, [runs, excludedRates, characterId, refreshCharacters]);

	useEffect(() => () => sweepRef.current?.cancel(), []);

	const savePlaylist = useCallback(async () => {
		if (!rotation.length) return;
		setSaveState('saving');
		try {
			const { created } = await playlists.replace(
				playlistName, rotation.map(map => map.beatmapId),
			);
			setSaveState(
				`${created ? 'Created' : 'Replaced'} "${playlistName}" - ${rotation.length} maps`
				+ ` at ${rateLabel(rotation[0]!.rate)}. Reopen song select to see it.`,
			);
		} catch (e) {
			setSaveState(e instanceof Error ? e.message : String(e));
		}
	}, [rotation, playlistName]);

	const scanning = phase.kind === 'scanning';

	return (
		<div style={{ display: open ? 'contents' : 'none' }} aria-hidden={!open}>
			<div className="backdrop" onClick={onClose} />
			<div className="panel" role="dialog" aria-label="osu!idle sim">
				<header>
					<h1>osu!idle sim</h1>
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


					<label title="The simulation is stochastic; averaging more attempts steadies the ranking, at a linear cost in scan time">
						Runs / map
						<input
							type="number" min={1} max={10} value={runs}
							onChange={e => update({ runs: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })}
						/>
					</label>

					<div className="field" title="Each rate is a full extra sweep of the library. A playlist plays at one rate, so the generated one sticks to its best.">
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
							<span className="status">{phase.done} / {phase.total}</span>
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
							<button
								className="primary"
								onClick={savePlaylist}
								disabled={!rotation.length || saveState === 'saving'}
							>
								{saveState === 'saving'
									? 'Saving...'
									: `Save ${rotation.length} at ${rateLabel(rotation[0]?.rate ?? 1)} as playlist`}
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
