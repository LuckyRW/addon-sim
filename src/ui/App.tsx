/**
 * The farm overlay.
 *
 * Opens on the playlist: pick what to farm and for how long, scan, save. The
 * full ranking is a tab away, and everything that tunes the simulation sits
 * in a settings drawer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Mod } from '@oss-idle/shared/mods';
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
	liveDifficulties,
	ratesFor,
	runSweep,
	type MapInfo,
	type Simulate,
	type Sweep,
	updateHint,
} from '../engine/client.js';
import { replacePlaylist } from '../engine/playlist.js';
import type { SimRequest, SimResult } from '../engine/protocol.js';
import {
	MEMORY_AHEAD,
	playKey,
	screenRates,
	SECONDARY_WEIGHT,
	type FarmTarget,
	type MapRow,
	type RankedMap,
} from '../farm/metrics.js';
import type { FarmSettings } from '../farm/farm.worker.js';
import {
	HOLD_BAND,
	peakMinutes,
	stateMinutes,
	STEADY_BAND,
} from '../farm/session.js';
import MapsView from './MapsView.js';
import PlaylistView from './PlaylistView.js';
import { popovers } from './escape.js';
import SettingsDrawer from './SettingsDrawer.js';
import { useFarm } from './useFarm.js';

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
/** Which playlist an XP target builds: one to warm up from rested, one to farm at the peak, flat or for more XP, or one that ignores the peak. */
export type PlaylistKind = 'warmup' | 'steady' | 'xp' | 'free';

export type Settings = {
	/** 'total', 'pp' or 'skills'. */
	targetSkill: string;
	/** The main skills a 'skills' target farms. */
	targetSkills: string[];
	/** The skills the lighter plays of a 'skills' target earn on the side. */
	secondarySkills: string[];
	playlistKind: PlaylistKind;
	playlistSize: number;
	warmupSize: number;
	playlistName: string;
	playlistNameTouched: boolean;
	runs: number;
	/** Unlocked rates not to simulate. */
	excludedRates: number[];
	tryHardRock: boolean;
	/** Seconds between plays; the game's own setting until changed here. */
	delaySec: number;
	delayTouched: boolean;
	applyMindblock: boolean;
	excludeFailed: boolean;
	oneMapPerSet: boolean;
	/** Plays put in the playlist by hand, by `playKey`. */
	pinned: string[];
	/** Difficulties taken out of the playlist by hand. */
	excluded: number[];
	characterId: number;
	characterPinned: boolean;
};

const DEFAULTS: Settings = {
	targetSkill: 'total',
	targetSkills: ['stamina'],
	secondarySkills: [],
	playlistKind: 'steady',
	playlistSize: 20,
	warmupSize: 5,
	playlistName: 'Farm: total',
	playlistNameTouched: false,
	runs: 3,
	excludedRates: [],
	tryHardRock: true,
	delaySec: 30,
	delayTouched: false,
	applyMindblock: true,
	excludeFailed: true,
	oneMapPerSet: false,
	pinned: [],
	excluded: [],
	characterId: 0,
	characterPinned: false,
};

const settingsStore = createSettings<Settings>('osu-idle-sim', DEFAULTS);

/** The playlist before the farm worker has made one. */
const NO_PLAYS: RankedMap[] = [];

/** How many of the screening pass's best difficulties get the full run count. */
const REFINE_MAPS = 50;
/** How many of the best plays are simulated tired, to learn what warm-up and fatigue cost this character. */
const CALIBRATE_MAPS = 8;

export const SKILL_NAMES = Skills as readonly string[];

/** Skills to tick, in a grid that pops out while the picker has focus. */
function SkillPicker({ label, fill, picked, locked, onToggle, title }: {
	label: string;
	/** The secondary skills' picker, in their lighter tone. */
	fill?: boolean;
	picked: readonly string[];
	/** Skills that cannot be ticked or unticked here. */
	locked: readonly string[];
	onToggle: (skill: string) => void;
	title?: string;
}) {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const close = useCallback(() => root.current?.querySelector<HTMLElement>(':focus')?.blur(), []);
	return (
		<div
			ref={root} className={`skill-picker${fill ? ' fill' : ''}`} title={title}
			onFocus={() => { setOpen(true); popovers.add(close); }}
			onBlur={e => {
				if (root.current?.contains(e.relatedTarget as Node)) return;
				setOpen(false);
				popovers.delete(close);
			}}
		>
			<button className="skill-trigger" aria-expanded={open} title={picked.join(', ')}>
				<span className="label">{label}</span>
				<span>{picked.length ? `${picked[0]}${picked.length > 1 ? ` +${picked.length - 1}` : ''}` : 'nothing'}</span>
				<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
			</button>
			{open && (
				<fieldset className="skill-grid" tabIndex={-1} aria-label={label}>
					{SKILL_NAMES.map(skill => (
						<label key={skill} className="toggle">
							<input
								type="checkbox" checked={picked.includes(skill)}
								disabled={locked.includes(skill)} onChange={() => onToggle(skill)}
							/>
							{skill}
						</label>
					))}
				</fieldset>
			)}
		</div>
	);
}

export default function App({ open, onClose, version, simulate }: {
	/** Hidden, never unmounted: unmounting would throw away a scan and cancel it. */
	open: boolean;
	onClose: () => void;
	version: string;
	/** The sim API, as the signed-in player. */
	simulate: Simulate;
}) {
	const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
	const [index, setIndex] = useState<Map<number, MapInfo>>(new Map());
	/** The library as a pass reads it: a scan's passes run before its `setIndex` renders. */
	const library = useRef(index);
	const [recent, setRecent] = useState<Map<number, number>>(new Map());
	/** `undefined` until a scan has read it, `null` when the server was unreachable. */
	const [medals, setMedals] = useState<number | null | undefined>(undefined);
	const [loved, setLoved] = useState<Set<number>>(new Set());
	const [skipped, setSkipped] = useState(0);
	const [view, setView] = useState<'playlist' | 'maps'>('playlist');
	const [drawer, setDrawer] = useState(false);
	const [saveState, setSaveState] = useState('');

	const [settings, update] = usePersistedSettings(settingsStore, DEFAULTS);
	const s = settings;

	const [characters, setCharacters] = useState<CharacterRow[]>([]);
	const [characterId, setCharacterId] = useState<number | undefined>(s.characterPinned ? s.characterId : undefined);
	const character = characters.find(row => row.id === characterId);
	const gear = Number(character?.staminaUpgrades) || 0;

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
		if (!s.delayTouched) update({ delaySec: autopilotDelay() });
	}, [open, refreshCharacters, s.delayTouched, update]);

	// settings saved by 2.2 and earlier hold the one skill farmed in targetSkill
	useEffect(() => {
		if (SKILL_NAMES.includes(s.targetSkill)) update({ targetSkill: 'skills', targetSkills: [s.targetSkill] });
	}, [s.targetSkill, update]);

	const target: FarmTarget = useMemo(() => (s.targetSkill === 'total'
		? { kind: 'total' }
		: s.targetSkill === 'pp'
			? { kind: 'pp' }
			: { kind: 'skills', skills: s.targetSkills, secondary: s.secondarySkills }), [s.targetSkill, s.targetSkills, s.secondarySkills]);

	useEffect(() => {
		if (s.playlistNameTouched) return;
		const goal = target.kind === 'skills'
			? `${target.skills.join(' + ')}${target.secondary?.length ? ` (+ ${target.secondary.join(' + ')})` : ''}`
			: target.kind;
		update({
			playlistName: s.playlistKind === 'warmup' && target.kind !== 'pp'
				? 'Warm-up'
				: `Farm: ${goal}${s.playlistKind === 'xp' && target.kind !== 'pp' ? ' (more XP)' : ''}`,
		});
	}, [target, s.playlistKind, s.playlistNameTouched, update]);

	/** Make `skill` a main skill or stop farming it, keeping at least one. */
	const toggleSkill = (skill: string) => {
		const on = s.targetSkills.includes(skill);
		if (on && s.targetSkills.length === 1) return;
		update({
			targetSkills: on ? s.targetSkills.filter(other => other !== skill) : [...s.targetSkills, skill],
			secondarySkills: s.secondarySkills.filter(other => other !== skill),
		});
	};

	/** Fill the gaps with `skill` or stop. */
	const toggleFill = (skill: string) => update({
		secondarySkills: s.secondarySkills.includes(skill)
			? s.secondarySkills.filter(other => other !== skill)
			: [...s.secondarySkills, skill],
	});

	const recentPlays = useMemo(() => s.applyMindblock ? recent : new Map<number, number>(), [s.applyMindblock, recent]);
	const excluded = useMemo(() => new Set(s.excluded), [s.excluded]);
	const warmingUp = target.kind !== 'pp' && s.playlistKind === 'warmup';

	// Ranking, the playlist search and its forecasts run in a worker, off the game's thread;
	// it updates every few seconds while a scan brings plays in.
	const farmSettings: FarmSettings = useMemo(() => ({
		target,
		recentPlays,
		delaySec: s.delaySec,
		maxFailRate: s.excludeFailed ? 0.5 : 1,
		medals: medals ?? 1,
		noPp: loved,
		gear,
		warmingUp,
		size: warmingUp ? s.warmupSize : s.playlistSize,
		band: s.playlistKind === 'free' ? Infinity : s.playlistKind === 'xp' ? HOLD_BAND : STEADY_BAND,
		pinned: s.pinned,
		excluded,
		oneMapPerSet: s.oneMapPerSet,
		// a 1500-row list is milliseconds to take in and draw: it waits for the end of a pass
		withBest: view === 'maps' && !scanning,
	}), [target, recentPlays, s.delaySec, s.excludeFailed, medals, loved, gear, warmingUp, s.warmupSize, s.playlistSize,
		s.playlistKind, s.pinned, excluded, s.oneMapPerSet, view, scanning]);
	const { view: model, behind, send, ask } = useFarm(farmSettings);
	const rotation = model?.rotation ?? NO_PLAYS;
	const farm = model?.farm ?? target;
	const simulated = (model?.plays ?? 0) > 0;

	/** Run one pass of plays through the sim API, feeding results to `onBatch` once a second. */
	const pass = useCallback(async (
		label: string,
		requests: SimRequest[],
		runs: number,
		onBatch: (batch: SimResult[]) => void,
		memoryAhead = MEMORY_AHEAD,
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
		const sweep = await runSweep(requests, {
			runs, characterId, memoryAhead, simulate, lengthOf: id => library.current.get(id)?.lengthSec,
		}, progress => {
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
	}, [characterId, simulate]);


	/** A pass that failed: a request the sim API refused needs a newer add-on, and says whether one is out. */
	const failed = useCallback(async (e: unknown) => {
		const message = e instanceof Error ? e.message : String(e);
		const refused = (e as { status?: number } | undefined)?.status === 400;
		setPhase({ kind: 'error', message: refused ? message + await updateHint(version) : message });
	}, [version]);

	const scan = useCallback(async () => {
		setSaveState('');
		setPhase({ kind: 'scanning', label: 'Reading library', done: 0, total: 0 });
		try {
			await refreshCharacters();
			const row = characterId === undefined ? await gameCharacter.live() : await gameCharacter.byId(characterId);
			// the sim API plays live maps only
			const catalog = await liveDifficulties();
			setLoved(catalog?.loved ?? new Set());
			const [survey, maps] = await Promise.all([collectCharts(catalog?.live), libraryIndex()]);
			library.current = maps;
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
						? `None of your ${survey.skippedUnranked} 4K difficulties are ranked or loved: the sim API plays only those.`
						: `Found ${survey.sets} set(s), but none of their ${survey.versions} difficulties are 4K mania.`;
				setPhase({ kind: 'error', message: `Nothing to simulate. ${detail}` });
				return;
			}

			const rowGear = Number(row?.staminaUpgrades) || 0;
			const atPeak = peakMinutes(rowGear);
			const rates = ratesFor(Number(row?.speedUpgrades) || 0, s.excludedRates);
			const screened = screenRates(rates);
			const mods: Mod[][] = s.tryHardRock ? [[], ['HR']] : [[]];
			send({ type: 'reset' });
			setSkipped(0);

			const addPeaks = (batch: SimResult[]) => send({ type: 'plays', peaks: batch });
			tried.current.clear();
			const options = {
				target, recentPlays: s.applyMindblock ? plays : new Map(), delaySec: s.delaySec,
				maxFailRate: s.excludeFailed ? 0.5 : 1, medals: multiplier ?? 1,
			};

			// Screen the library once, then spend the full run count near the top. Screening
			// seeds memory with the map's own plays: a map never played is one the sim cache
			// can answer for.
			const screening = await pass('Screening', survey.requests.map(map => ({
				...map, rates: screened, mods, minutes: [atPeak],
			})), 1, addPeaks, 0);
			if (screening.cancelled) return setPhase({ kind: 'ready' });
			if (s.runs > 1 || screened.length < rates.length) {
				const refining = await pass('Refining', await ask<SimRequest[]>({
					type: 'refine', rank: options, rates, screened, maps: REFINE_MAPS, mods, minutes: atPeak,
				}), s.runs, addPeaks);
				if (refining.cancelled) return setPhase({ kind: 'ready' });
			}

			// Learn what warm-up and fatigue cost this character on its best plays.
			const best = await ask<RankedMap[]>({ type: 'best', rank: options, count: CALIBRATE_MAPS });
			for (const map of best) tried.current.add(playKey(map));
			await pass('Warm-up', best.map(map => ({
				setId: map.setId, beatmapId: map.beatmapId, rates: [map.rate], mods: [map.mods], minutes: stateMinutes(rowGear),
			})), Math.max(1, s.runs - 1), batch => send({ type: 'plays', states: batch }));
			setPhase({ kind: 'ready' });
		} catch (e) {
			await failed(e);
		}
	}, [characterId, refreshCharacters, s, target, pass, failed, send, ask]);

	// The playlist's own plays are simulated tired too once picked, so its
	// forecast reads them rather than the estimate. Each play is tried once:
	// one the simulation cannot play stays estimated.
	useEffect(() => {
		if (phase.kind !== 'ready' || target.kind === 'pp') return;
		const missing = rotation.filter(map => !tried.current.has(playKey(map)));
		if (!missing.length) return;
		for (const map of missing) tried.current.add(playKey(map));
		void (async () => {
			try {
				await pass('Forecasting', missing.map(map => ({
					setId: map.setId, beatmapId: map.beatmapId, rates: [map.rate], mods: [map.mods], minutes: stateMinutes(gear),
				})), Math.max(1, s.runs - 1), batch => send({ type: 'plays', states: batch }));
			} catch (e) {
				return failed(e);
			}
			setPhase({ kind: 'ready' });
		})();
	}, [phase.kind, rotation, target.kind, gear, s.runs, pass, failed, send]);

	useEffect(() => () => sweepRef.current?.cancel(), []);

	const save = useCallback(async () => {
		if (!rotation.length) return;
		setSaveState('saving');
		try {
			const { created } = await replacePlaylist(s.playlistName, rotation);
			setSaveState(`${created ? 'Created' : 'Updated'} "${s.playlistName}". Reopen song select to see it.`);
		} catch (e) {
			setSaveState(e instanceof Error ? e.message : String(e));
		}
	}, [rotation, s.playlistName]);

	const toggle = useCallback((map: MapRow) => {
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
							All maps {!!model?.maps && <span className="count">{model.maps.toLocaleString()}</span>}
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
						<button className={target.kind === 'skills' ? 'on' : ''} onClick={() => update({ targetSkill: 'skills' })}>Skills</button>
						<button className={s.targetSkill === 'pp' ? 'on' : ''} onClick={() => update({ targetSkill: 'pp' })}>pp</button>
					</div>
					{target.kind === 'skills' && (
						<>
							<SkillPicker
								label="Main" picked={s.targetSkills}
								locked={s.targetSkills.length === 1 ? s.targetSkills : []} onToggle={toggleSkill}
							/>
							<SkillPicker
								label="Fill gaps" fill picked={s.secondarySkills} locked={s.targetSkills} onToggle={toggleFill}
								title={`The lighter maps that hold your peak earn these skills too; their XP counts ${SECONDARY_WEIGHT}× a main skill's`}
							/>
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
								{simulated ? `${(model?.maps ?? 0).toLocaleString()} maps simulated` : ''}
								{skipped ? ` · ${skipped} skipped` : ''}
								{medals === null ? ' · medal bonus unavailable' : ''}
							</span>
							<button
								className={simulated ? '' : 'primary'} onClick={scan} disabled={noRates}
								title={noRates ? 'Pick at least one rate in Settings' : undefined}
							>
								{simulated ? 'Re-scan' : 'Scan library'}
							</button>
						</>
					)}
				</div>

				{phase.kind === 'error' && <div className="empty error">{phase.message}</div>}
				{phase.kind !== 'error' && !simulated && (
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
				{model && simulated && view === 'playlist' && (
					<PlaylistView
						rotation={rotation}
						index={index}
						target={farm}
						forecast={model.outlook}
						baseline={model.baseline}
						settings={s}
						update={update}
						onToggle={toggle}
						onSave={save}
						saveState={saveState}
						pending={behind ? (scanning ? 'Updating as plays come in...' : 'Finding the best playlist...') : undefined}
					/>
				)}
				{model && simulated && view === 'maps' && (
					<MapsView best={model.best ?? NO_PLAYS} rotation={rotation} index={index} target={farm} onToggle={toggle} />
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
