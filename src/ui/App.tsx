/**
 * The farm overlay.
 *
 * Opens on the playlist: pick what to farm and for how long, scan, save. The
 * full ranking is a tab away, and everything that tunes the simulation sits
 * in a settings drawer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { modsKey, type Mod } from '@oss-idle/shared/mods';
import { rateSteps } from '@oss-idle/shared/rate';
import { Skills } from '@oss-idle/shared/rulesets/mania/4k/skills';
import {
	createSettings,
	gameCharacter,
	recentPlayCounts,
	type CharacterRow,
} from '@oss-idle/addon-sdk';
import { usePersistedSettings } from '@oss-idle/addon-sdk/react';
import {
	autopilotDelay,
	collectCharts,
	libraryIndex,
	medalMultiplier,
	rankedDifficulties,
	ratesFor,
	runSweep,
	type MapInfo,
	type Sweep,
} from '../engine/client.js';
import { entriesLockMods, replacePlaylist } from '../engine/playlist.js';
import type { SimRequest, SimResult } from '../engine/protocol.js';
import {
	MEMORY_AHEAD,
	playKey,
	rankMaps,
	refinePlan,
	screenRates,
	type FarmTarget,
	type RankedMap,
} from '../farm/metrics.js';
import {
	buildRotation,
	coldCurve,
	forecast,
	peakMinutes,
	stateLookup,
	stateMinutes,
	type SessionOptions,
} from '../farm/session.js';
import MapsView from './MapsView.js';
import PlaylistView from './PlaylistView.js';
import SettingsDrawer from './SettingsDrawer.js';

type Phase =
	| { kind: 'idle' }
	| { kind: 'scanning'; label: string; done: number; total: number }
	| { kind: 'ready' }
	| { kind: 'error'; message: string };

/**
 * What the overlay remembers between sessions. Scan results are not stored:
 * a library sweep is megabytes, and `localStorage` is shared with the game.
 *
 * `characterId` is remembered only once the player has picked one
 * (`characterPinned`), so signing in or out is otherwise picked up.
 */
export type Settings = {
	targetSkill: string;
	sessionHours: number;
	playlistSize: number;
	playlistName: string;
	playlistNameTouched: boolean;
	runs: number;
	/** Unlocked rates not to simulate. */
	excludedRates: number[];
	tryHardRock: boolean;
	/** Start the session warm rather than rested. */
	startWarm: boolean;
	/** Seconds between plays; the game's own setting until changed here. */
	delaySec: number;
	delayTouched: boolean;
	applyMindblock: boolean;
	excludeFailed: boolean;
	oneMapPerSet: boolean;
	includeUnranked: boolean;
	/** Plays put in the playlist by hand, by `playKey`. */
	pinned: string[];
	/** Difficulties taken out of the playlist by hand. */
	excluded: number[];
	characterId: number;
	characterPinned: boolean;
};

const DEFAULTS: Settings = {
	targetSkill: 'total',
	sessionHours: 4,
	playlistSize: 6,
	playlistName: 'Farm: total',
	playlistNameTouched: false,
	runs: 3,
	excludedRates: [],
	tryHardRock: true,
	startWarm: false,
	delaySec: 30,
	delayTouched: false,
	applyMindblock: true,
	excludeFailed: true,
	oneMapPerSet: false,
	includeUnranked: false,
	pinned: [],
	excluded: [],
	characterId: 0,
	characterPinned: false,
};

const settingsStore = createSettings<Settings>('osu-idle-sim', DEFAULTS);

/** `batch` added to `previous`, a refined play replacing its screening one. */
const merged = (previous: readonly SimResult[], batch: readonly SimResult[]): SimResult[] => {
	const id = (result: SimResult) => `${playKey(result)}~${result.minutes}`;
	const fresh = new Set(batch.map(id));
	return [...previous.filter(result => !fresh.has(id(result))), ...batch];
};

/** How many of the screening pass's best difficulties get the full run count. */
const REFINE_MAPS = 50;
/** How many of the best plays are simulated tired, to learn what warm-up and fatigue cost this character. */
const CALIBRATE_MAPS = 8;

export const SKILL_NAMES = Skills as readonly string[];

export default function App({ open, onClose, version }: {
	/** Hidden, never unmounted: unmounting would throw away a scan and cancel it. */
	open: boolean;
	onClose: () => void;
	version: string;
}) {
	const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
	/** Plays simulated at peak warm-up. */
	const [results, setResults] = useState<SimResult[]>([]);
	/** The same plays simulated tired. */
	const [states, setStates] = useState<SimResult[]>([]);
	const [index, setIndex] = useState<Map<number, MapInfo>>(new Map());
	const [recent, setRecent] = useState<Map<number, number>>(new Map());
	/** `undefined` until a scan has read it, `null` when the server was unreachable. */
	const [medals, setMedals] = useState<number | null | undefined>(undefined);
	const [skipped, setSkipped] = useState(0);
	const [lockMods, setLockMods] = useState(false);
	const [view, setView] = useState<'playlist' | 'maps'>('playlist');
	const [drawer, setDrawer] = useState(false);
	const [saveState, setSaveState] = useState('');

	const [settings, update] = usePersistedSettings(settingsStore, DEFAULTS);
	const s = settings;

	const [characters, setCharacters] = useState<CharacterRow[]>([]);
	const [characterId, setCharacterId] = useState<number | undefined>(s.characterPinned ? s.characterId : undefined);
	const character = characters.find(row => row.id === characterId);
	const gear = Number(character?.staminaUpgrades) || 0;
	const peak = peakMinutes(gear);

	const sweepRef = useRef<Sweep | undefined>(undefined);
	/** Plays simulated tired, or tried: see the Forecasting effect. */
	const tried = useRef(new Set<string>());
	const scanning = phase.kind === 'scanning';

	/** Re-read the characters: the client writes levels back after every play. */
	const refreshCharacters = useCallback(async () => {
		const [rows, detected] = await Promise.all([gameCharacter.list(), gameCharacter.live()]);
		setCharacters(rows);
		setCharacterId(previous => (previous !== undefined && rows.some(row => row.id === previous)
			? previous
			: detected?.id ?? rows[0]?.id));
	}, []);

	useEffect(() => {
		if (!open) return;
		void refreshCharacters();
		void entriesLockMods().then(setLockMods, () => setLockMods(false));
		if (!s.delayTouched) update({ delaySec: autopilotDelay() });
	}, [open, refreshCharacters, s.delayTouched, update]);

	const target: FarmTarget = useMemo(() => (s.targetSkill === 'total'
		? { kind: 'total' }
		: s.targetSkill === 'pp' ? { kind: 'pp' } : { kind: 'skill', skill: s.targetSkill }), [s.targetSkill]);

	useEffect(() => {
		if (!s.playlistNameTouched) update({ playlistName: `Farm: ${s.targetSkill}` });
	}, [s.targetSkill, s.playlistNameTouched, update]);

	const recentPlays = s.applyMindblock ? recent : new Map<number, number>();

	const ranked: RankedMap[] = useMemo(() => rankMaps(results, {
		target,
		recentPlays,
		delaySec: s.delaySec,
		maxFailRate: s.excludeFailed ? 0.5 : 1,
		medals: medals ?? 1,
	}), [results, target, recentPlays, s.delaySec, s.excludeFailed, medals]);

	const session: SessionOptions = useMemo(() => {
		const peaks = new Map(results.map(result => [playKey(result), result]));
		const curve = coldCurve(states, peaks, gear);
		return {
			target,
			lookup: stateLookup(states, gear, curve),
			sessionSec: s.sessionHours * 3600,
			startMinutes: s.startWarm ? peak : 0,
			delaySec: s.delaySec,
			gear,
			medals: medals ?? 1,
			recentPlays,
		};
	}, [results, states, gear, peak, target, s.sessionHours, s.startWarm, s.delaySec, medals, recentPlays]);

	const excluded = useMemo(() => new Set(s.excluded), [s.excluded]);

	const rotation = useMemo(() => {
		const options = { ...session, size: s.playlistSize, pinned: s.pinned, excluded, oneMapPerSet: s.oneMapPerSet };
		if (lockMods) return buildRotation(ranked, options);
		// a playlist plays with song select's mods: build one per mod set, keep the best
		const sets = [...new Set(ranked.map(map => modsKey(map.mods)))];
		let best: RankedMap[] = [];
		let bestValue = -Infinity;
		for (const key of sets) {
			const rotation = buildRotation(ranked.filter(map => modsKey(map.mods) === key), options);
			const value = target.kind === 'pp'
				? rotation.reduce((sum, map) => sum + map.value, 0)
				: forecast(rotation, session).total;
			if (value > bestValue) {
				best = rotation;
				bestValue = value;
			}
		}
		return best;
	}, [ranked, session, s.playlistSize, s.pinned, excluded, s.oneMapPerSet, lockMods, target]);

	const outlook = useMemo(() => forecast(rotation, session), [rotation, session]);
	/** The best plays alone, for comparison. */
	const baseline = useMemo(() => {
		const best: RankedMap[] = [];
		for (const map of ranked) {
			if (best.length >= s.playlistSize) break;
			if (!best.some(other => other.beatmapId === map.beatmapId)) best.push(map);
		}
		return forecast(best, session);
	}, [ranked, session, s.playlistSize]);

	/** Run one pass of plays through the workers, feeding results to `onBatch` once a second. */
	const pass = useCallback(async (
		label: string,
		requests: SimRequest[],
		runs: number,
		onBatch: (batch: SimResult[]) => void,
	) => {
		setPhase({ kind: 'scanning', label, done: 0, total: requests.length });
		let pending: SimResult[] = [];
		let errors = 0;
		let shownAt = 0;
		let phaseAt = 0;
		const show = () => {
			if (pending.length) onBatch(pending);
			pending = [];
			if (errors) setSkipped(previous => previous + errors);
			errors = 0;
			shownAt = Date.now();
		};
		const sweep = await runSweep(requests, { runs, characterId, memoryAhead: MEMORY_AHEAD }, progress => {
			pending.push(...progress.results);
			errors += progress.errors.length;
			const now = Date.now();
			if (now - phaseAt >= 200) {
				phaseAt = now;
				setPhase({ kind: 'scanning', label, done: progress.done, total: progress.total });
			}
			// re-ranking runs on the game's thread, so the table catches up once a second
			if (now - shownAt >= 1000) show();
		});
		sweepRef.current = sweep;
		const outcome = await sweep.finished;
		show();
		return outcome;
	}, [characterId]);


	const scan = useCallback(async () => {
		setSaveState('');
		setPhase({ kind: 'scanning', label: 'Reading library', done: 0, total: 0 });
		try {
			await refreshCharacters();
			const row = characterId === undefined ? await gameCharacter.live() : await gameCharacter.byId(characterId);
			// a guest's plays pay XP on any map, an account character's only on ranked ones
			const filtering = !!row && !row.local && !s.includeUnranked;
			const ranked = filtering ? await rankedDifficulties() : undefined;
			const [survey, maps] = await Promise.all([collectCharts(ranked), libraryIndex()]);
			setIndex(maps);
			const [plays, multiplier] = row
				? await Promise.all([recentPlayCounts(Number(row.id)), medalMultiplier(row)])
				: [new Map<number, number>(), 1];
			setRecent(plays);
			setMedals(multiplier ?? null);

			if (!survey.requests.length) {
				const detail = survey.sets === 0
					? 'The beatmap store is empty - download a map in song select first.'
					: survey.skippedUnranked
						? `None of your ${survey.skippedUnranked} 4K difficulties are ranked - include unranked maps in Settings to simulate them.`
						: `Found ${survey.sets} set(s), but none of their ${survey.versions} difficulties are 4K mania.`;
				setPhase({ kind: 'error', message: `Nothing to simulate. ${detail}` });
				return;
			}

			const rowGear = Number(row?.staminaUpgrades) || 0;
			const atPeak = peakMinutes(rowGear);
			const rates = ratesFor(Number(row?.speedUpgrades) || 0, s.excludedRates);
			const screened = screenRates(rates);
			const mods: Mod[][] = s.tryHardRock ? [[], ['HR']] : [[]];
			setResults([]);
			setStates([]);
			setSkipped(0);

			let peaks: SimResult[] = [];
			const addPeaks = (batch: SimResult[]) => setResults(peaks = merged(peaks, batch));
			const addStates = (batch: SimResult[]) => setStates(previous => merged(previous, batch));
			tried.current.clear();
			const options = {
				target, recentPlays: s.applyMindblock ? plays : new Map(), delaySec: s.delaySec,
				maxFailRate: s.excludeFailed ? 0.5 : 1, medals: multiplier ?? 1,
			};

			// Screen the library once, then spend the full run count near the top.
			const screening = await pass('Screening', survey.requests.map(map => ({
				...map, rates: screened, mods, minutes: [atPeak],
			})), 1, addPeaks);
			if (screening.cancelled) return setPhase({ kind: 'ready' });
			if (s.runs > 1 || screened.length < rates.length) {
				const refining = await pass('Refining', refinePlan(
					rankMaps(peaks, options), rates, screened, REFINE_MAPS, mods, atPeak,
				), s.runs, addPeaks);
				if (refining.cancelled) return setPhase({ kind: 'ready' });
			}

			// Learn what warm-up and fatigue cost this character on its best plays.
			const best = rankMaps(peaks, options);
			const calibrate: SimRequest[] = [];
			for (const map of best) {
				if (calibrate.length >= CALIBRATE_MAPS) break;
				if (calibrate.some(other => other.beatmapId === map.beatmapId)) continue;
				calibrate.push({
					setId: map.setId, beatmapId: map.beatmapId, rates: [map.rate], mods: [map.mods], minutes: stateMinutes(rowGear),
				});
				tried.current.add(playKey(map));
			}
			await pass('Warm-up', calibrate, Math.max(1, s.runs - 1), addStates);
			setPhase({ kind: 'ready' });
		} catch (e) {
			setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
		}
	}, [characterId, refreshCharacters, s, target, pass]);

	// The playlist's own plays are simulated tired too once picked, so its
	// forecast reads them rather than the estimate. Each play is tried once:
	// one the simulation cannot play stays estimated.
	useEffect(() => {
		if (phase.kind !== 'ready' || target.kind === 'pp') return;
		const missing = rotation.filter(map => !tried.current.has(playKey(map)));
		if (!missing.length) return;
		for (const map of missing) tried.current.add(playKey(map));
		void (async () => {
			await pass('Forecasting', missing.map(map => ({
				setId: map.setId, beatmapId: map.beatmapId, rates: [map.rate], mods: [map.mods], minutes: stateMinutes(gear),
			})), Math.max(1, s.runs - 1), batch => setStates(previous => merged(previous, batch)));
			setPhase({ kind: 'ready' });
		})();
	}, [phase.kind, rotation, target.kind, gear, s.runs, pass]);

	useEffect(() => () => sweepRef.current?.cancel(), []);

	const save = useCallback(async () => {
		if (!rotation.length) return;
		setSaveState('saving');
		try {
			const { created } = await replacePlaylist(s.playlistName, rotation);
			const mods = !lockMods && rotation[0]?.mods.length ? ` Turn on ${rotation[0].mods.join('')} in song select.` : '';
			setSaveState(`${created ? 'Created' : 'Updated'} "${s.playlistName}". Reopen song select to see it.${mods}`);
		} catch (e) {
			setSaveState(e instanceof Error ? e.message : String(e));
		}
	}, [rotation, s.playlistName, lockMods]);

	const toggle = useCallback((map: RankedMap) => {
		const key = playKey(map);
		if (rotation.some(other => playKey(other) === key)) {
			update({ pinned: s.pinned.filter(other => other !== key), excluded: [...s.excluded, map.beatmapId] });
		} else {
			update({
				pinned: [...s.pinned.filter(other => !other.startsWith(`${map.beatmapId}@`)), key],
				excluded: s.excluded.filter(id => id !== map.beatmapId),
			});
		}
	}, [rotation, s.pinned, s.excluded, update]);

	const steps = rateSteps(Number(character?.speedUpgrades) || 0);
	const noRates = steps.every(step => s.excludedRates.includes(step));
	const simulatedMaps = useMemo(() => new Set(results.map(result => result.beatmapId)).size, [results]);

	return (
		<div style={{ display: open ? 'contents' : 'none' }} aria-hidden={!open}>
			<div className="backdrop" onClick={onClose} />
			<div className="panel" role="dialog" aria-label="oss!idle sim">
				<header>
					<h1>oss!idle sim</h1>
					<label className="character" title="The character the simulation plays. Detected from your last play; check it is who you are playing.">
						<span className="dot" />
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
									{row.name} · lv {row.overallLevel}{row.local ? ' (guest)' : ''}
								</option>
							))}
						</select>
					</label>
					<span className="spacer" />
					<nav className="seg" aria-label="View">
						<button className={view === 'playlist' ? 'on' : ''} onClick={() => setView('playlist')}>Playlist</button>
						<button className={view === 'maps' ? 'on' : ''} onClick={() => setView('maps')}>
							All maps {simulatedMaps > 0 && <span className="count">{simulatedMaps.toLocaleString()}</span>}
						</button>
					</nav>
					<span className="spacer" />
					<span className="hint">v{version}</span>
					<button className="icon" aria-label="Settings" aria-expanded={drawer} onClick={() => setDrawer(!drawer)}>
						<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8">
							<path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" />
						</svg>
					</button>
					<button className="icon" aria-label="Close" onClick={onClose}>
						<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" /></svg>
					</button>
				</header>

				<div className="toolbar">
					<span className="label">Farm</span>
					<div className="seg" role="group" aria-label="Goal">
						<button className={s.targetSkill === 'total' ? 'on' : ''} onClick={() => update({ targetSkill: 'total' })}>Total XP</button>
						<select
							className={s.targetSkill !== 'total' && s.targetSkill !== 'pp' ? 'on' : ''}
							aria-label="One skill"
							value={SKILL_NAMES.includes(s.targetSkill) ? s.targetSkill : ''}
							onChange={e => update({ targetSkill: e.target.value })}
						>
							<option value="" disabled>One skill</option>
							{SKILL_NAMES.map(skill => <option key={skill} value={skill}>{skill}</option>)}
						</select>
						<button className={s.targetSkill === 'pp' ? 'on' : ''} onClick={() => update({ targetSkill: 'pp' })}>pp</button>
					</div>
					{target.kind !== 'pp' && (
						<>
							<span className="label">for</span>
							<div className="seg" role="group" aria-label="Session length">
								{[1, 4, 8].map(hours => (
									<button key={hours} className={s.sessionHours === hours ? 'on' : ''} onClick={() => update({ sessionHours: hours })}>
										{hours}h
									</button>
								))}
							</div>
						</>
					)}
					<span className="spacer" />
					{scanning ? (
						<>
							<div className="progress"><div style={{ width: `${phase.total ? (phase.done / phase.total) * 100 : 0}%` }} /></div>
							<span className="status">{phase.label} {phase.done} / {phase.total}</span>
							<button onClick={() => sweepRef.current?.cancel()}>Stop</button>
						</>
					) : (
						<>
							<span className="status">
								{results.length ? `${simulatedMaps.toLocaleString()} maps simulated` : ''}
								{skipped ? ` · ${skipped} skipped` : ''}
								{medals === null ? ' · medal bonus unavailable' : ''}
							</span>
							<button
								className={results.length ? '' : 'primary'} onClick={scan} disabled={noRates}
								title={noRates ? 'Pick at least one rate in Settings' : undefined}
							>
								{results.length ? 'Re-scan' : 'Scan library'}
							</button>
						</>
					)}
				</div>

				{phase.kind === 'error' && <div className="empty error">{phase.message}</div>}
				{phase.kind !== 'error' && !results.length && (
					<div className="empty">
						{scanning ? 'Simulating your library...' : (
							<>
								<p>Every downloaded map is played by a simulation of your character,<br />
									then the best ones are put together into a playlist that holds you at your warm-up peak.</p>
								<button className="primary big" onClick={scan} disabled={noRates}>Scan library</button>
							</>
						)}
					</div>
				)}
				{!!results.length && view === 'playlist' && (
					<PlaylistView
						rotation={rotation}
						index={index}
						target={target}
						forecast={outlook}
						baseline={baseline}
						settings={s}
						update={update}
						lockMods={lockMods}
						onToggle={toggle}
						onSave={save}
						saveState={saveState}
					/>
				)}
				{!!results.length && view === 'maps' && (
					<MapsView ranked={ranked} rotation={rotation} index={index} target={target} onToggle={toggle} />
				)}

				{drawer && (
					<SettingsDrawer
						settings={s}
						update={update}
						steps={steps}
						onClose={() => setDrawer(false)}
					/>
				)}
			</div>
		</div>
	);
}
