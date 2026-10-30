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
import { farmLevels, scoutedRequests, scoutRecent, type ScoutApi } from '../engine/scout.js';
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
import TargetView from './TargetView.js';
import { useFarm } from './useFarm.js';

type Phase =
	| { kind: 'idle' }
	| { kind: 'scanning'; label: string; done: number; total: number }
	| { kind: 'ready' }
	| { kind: 'error'; message: string };

/** Which playlist an XP target builds: one to warm up from rested, one to farm at the peak, flat or for more XP, or one that ignores the peak. */
export type PlaylistKind = 'warmup' | 'steady' | 'xp' | 'free' | 'repeat';

export type Settings = {
	/** 'total', 'pp' or 'skills'. */
	targetSkill: string;
	/** Legacy main skills fallback. */
	targetSkills: string[];
	/** Legacy secondary skills fallback. */
	secondarySkills: string[];
	/** Exact multiplier weights per skill. */
	skillWeights: Record<string, number>;
	/** When enabled, the add-on does not auto-fill maps; only user-pinned maps form the playlist. */
	manualRotation: boolean;
	playlistKind: PlaylistKind;
	playlistSize: number;
	/** Let the farm find the playlist size that does best (`bestSize`) instead of `playlistSize`. */
	autoSize: boolean;
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
	/** Balance several weighted skills against their best plays, or sum their XP as before. */
	balanceSkills: boolean;
	/** Simulate first what players near your level played lately, and a share of the rest: see `scout.ts`. */
	fastScan: boolean;
	/** Fill the All maps list while a scan runs, at each of the farm's updates, not only once it is over. */
	liveMaps: boolean;
	/** All maps lists every rate and mods simulated, not only each difficulty's best. */
	everyRate: boolean;
	/** Simulate the library at the warm-up peak, as the farm is played; off, at `scanMinutes` of fatigue. */
	scanAtPeak: boolean;
	/** The fatigue, in strained minutes, a scan plays the library at when not at the peak. */
	scanMinutes: number;
	/** Plays put in the playlist by hand, by `playKey`. */
	pinned: string[];
	/** How many times in a row a playlist map plays, set by hand, by `playKey`. */
	repeats: Record<string, number>;
	/** Difficulties taken out of the playlist by hand. */
	excluded: number[];
	characterId: number;
	characterPinned: boolean;
};

const DEFAULTS: Settings = {
	targetSkill: 'total',
	targetSkills: ['stamina'],
	secondarySkills: [],
	skillWeights: { stamina: 1.0 },
	manualRotation: false,
	playlistKind: 'steady',
	playlistSize: 20,
	autoSize: true,
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
	balanceSkills: true,
	fastScan: true,
	liveMaps: true,
	everyRate: false,
	scanAtPeak: true,
	scanMinutes: 0,
	pinned: [],
	repeats: {},
	excluded: [],
	characterId: 0,
	characterPinned: false,
};

const settingsStore = createSettings<Settings>('osu-idle-sim', DEFAULTS);

/** The playlist before the farm worker has made one. */
const NO_PLAYS: RankedMap[] = [];
const NO_REPEATS: number[] = [];

/** The tired states a play is simulated at, and the peak too when the library was played elsewhere: the forecast needs it. */
const withPeak = (states: number[], peak: number | undefined): number[] =>
	peak === undefined || states.includes(peak) ? states : [...states, peak].sort((a, b) => a - b);

/** How many of the screening pass's best difficulties get the full run count. */
const REFINE_MAPS = 50;
/** How many of the best plays are simulated tired, to learn what warm-up and fatigue cost this character. */
const CALIBRATE_MAPS = 8;

export const SKILL_NAMES = Skills as readonly string[];

/** Skill Multiplier Input Dropdown Popover */
function SkillMultiplierPicker({
	weights,
	onChange,
}: {
	weights: Record<string, number>;
	onChange: (skill: string, value: number) => void;
}) {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const close = useCallback(() => root.current?.querySelector<HTMLElement>(':focus')?.blur(), []);

	const activeEntries = Object.entries(weights).filter(([_, w]) => (w ?? 0) > 0);
	const summary = activeEntries.length
		? activeEntries.map(([k, v]) => `${k}: ${v}x`).join(', ')
		: 'all 0x';

	return (
		<div
			ref={root}
			className="skill-picker"
			title={summary}
			onFocus={() => {
				setOpen(true);
				popovers.add(close);
			}}
			onBlur={e => {
				if (root.current?.contains(e.relatedTarget as Node)) return;
				setOpen(false);
				popovers.delete(close);
			}}
		>
			<button className="skill-trigger" aria-expanded={open} title={summary}>
				<span className="label">Multipliers</span>
				<span>
					{activeEntries.length
						? `${activeEntries[0][0]} (${activeEntries[0][1]}x)${activeEntries.length > 1 ? ` +${activeEntries.length - 1}` : ''}`
						: 'set multipliers'}
				</span>
				<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
					<path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.6" />
				</svg>
			</button>
			{open && (
				<fieldset
					className="skill-grid"
					tabIndex={-1}
					aria-label="Skill Multipliers"
					style={{
						display: 'grid',
						gridTemplateColumns: 'repeat(2, 1fr)',
						gap: '6px',
						minWidth: '280px',
						padding: '8px 10px',
						background: '#151520',
						border: '1px solid #33334d',
						borderRadius: '6px',
						boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
					}}
				>
					{SKILL_NAMES.map(skill => {
						const val = weights[skill] ?? 0;
						const active = val > 0;
						return (
							<label
								key={skill}
								style={{
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'space-between',
									gap: '6px',
									fontSize: '11px',
									padding: '3px 6px',
									background: active ? 'rgba(56, 189, 248, 0.12)' : 'rgba(255, 255, 255, 0.02)',
									borderRadius: '4px',
									border: `1px solid ${active ? '#0284c7' : '#2b2b3a'}`,
									cursor: 'default',
								}}
							>
								<span style={{ color: active ? '#38bdf8' : '#888', fontWeight: active ? 600 : 400 }}>
									{skill}
								</span>
								<div style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
									<input
										type="number"
										step="0.1"
										min="0"
										max="10"
										value={val === 0 ? '' : val}
										placeholder="0"
										onFocus={e => e.target.select()}
										onChange={e => {
											const raw = e.target.value.trim();
											if (raw === '') {
												onChange(skill, 0);
											} else {
												const parsed = parseFloat(raw);
												onChange(skill, isNaN(parsed) ? 0 : Math.max(0, parsed));
											}
										}}
										onClick={e => e.stopPropagation()}
										style={{
											width: '46px',
											padding: '2px 4px',
											background: '#101018',
											border: '1px solid #444',
											borderRadius: '3px',
											color: '#fff',
											fontSize: '11px',
											textAlign: 'right',
											outline: 'none',
										}}
									/>
									<span style={{ fontSize: '10px', color: '#666' }}>x</span>
								</div>
							</label>
						);
					})}
				</fieldset>
			)}
		</div>
	);
}

export default function App({ open, onClose, version, simulate, scout }: {
	/** Hidden, never unmounted: unmounting would throw away a scan and cancel it. */
	open: boolean;
	onClose: () => void;
	version: string;
	/** The sim API, as the signed-in player. */
	simulate: Simulate;
	/** Rankings and scores, for a fast scan; none on a game that hands add-ons no API. */
	scout?: ScoutApi;
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
	const [view, setView] = useState<'playlist' | 'maps' | 'target'>('playlist');
	const [drawer, setDrawer] = useState(false);
	const [saveState, setSaveState] = useState('');

	const [settings, update] = usePersistedSettings(settingsStore, DEFAULTS);
	const s = settings;

	const [characters, setCharacters] = useState<CharacterRow[]>([]);
	const [characterId, setCharacterId] = useState<number | undefined>(
		s.characterPinned ? s.characterId : undefined,
	);
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
		setCharacterId(previous =>
			previous !== undefined && rows.some(row => row.id === previous)
				? previous
				: detected?.id ?? rows[0]?.id,
		);
	}, []);

	useEffect(() => {
		if (!open) return;
		void refreshCharacters();
		if (!s.delayTouched) update({ delaySec: autopilotDelay() });
	}, [open, refreshCharacters, s.delayTouched, update]);

	// Settings migration for legacy target skills
	useEffect(() => {
		if (SKILL_NAMES.includes(s.targetSkill)) {
			update({
				targetSkill: 'skills',
				targetSkills: [s.targetSkill],
				skillWeights: { [s.targetSkill]: 1.0 },
			});
		} else if (s.targetSkill === 'skills' && (!s.skillWeights || Object.keys(s.skillWeights).length === 0)) {
			const initial: Record<string, number> = {};
			for (const sk of s.targetSkills) initial[sk] = 1.0;
			for (const sk of s.secondarySkills) initial[sk] = SECONDARY_WEIGHT;
			update({ skillWeights: Object.keys(initial).length ? initial : { stamina: 1.0 } });
		}
	}, [s.targetSkill, s.targetSkills, s.secondarySkills, s.skillWeights, update]);

	const target: FarmTarget = useMemo(() => {
		if (s.targetSkill === 'total') return { kind: 'total' };
		if (s.targetSkill === 'pp') return { kind: 'pp' };
		return {
			kind: 'skills',
			weights: s.skillWeights ?? { stamina: 1.0 },
			skills: s.targetSkills,
			secondary: s.secondarySkills,
			unbalanced: s.balanceSkills === false,
		};
	}, [s.targetSkill, s.skillWeights, s.targetSkills, s.secondarySkills, s.balanceSkills]);

	useEffect(() => {
		if (s.playlistNameTouched) return;
		let goal: string = target.kind;
		if (target.kind === 'skills') {
			const active = Object.entries(target.weights ?? {})
				.filter(([_, w]) => w > 0)
				.map(([sk, w]) => (w === 1 ? sk : `${sk} (${w}x)`));
			goal = active.length ? active.join(' + ') : s.targetSkills.join(' + ');
		}
		update({
			playlistName:
				s.playlistKind === 'warmup' && target.kind !== 'pp'
					? 'Warm-up'
					: `Farm: ${goal}${s.playlistKind === 'xp' && target.kind !== 'pp' ? ' (more XP)' : ''}`,
		});
	}, [target, s.playlistKind, s.playlistNameTouched, s.targetSkills, update]);

	/** Update multiplier weight for a specific skill */
	const updateSkillWeight = (skill: string, value: number) => {
		const nextWeights = { ...(s.skillWeights ?? {}), [skill]: Math.max(0, value) };
		const activeSkills = Object.entries(nextWeights)
			.filter(([_, w]) => w > 0)
			.map(([sk]) => sk);
		update({
			skillWeights: nextWeights,
			targetSkills: activeSkills.length ? activeSkills : [skill],
		});
	};

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
		autoSize: s.autoSize,
		settled: !scanning,
		band: s.playlistKind === 'free' || s.playlistKind === 'repeat' ? Infinity : s.playlistKind === 'xp' ? HOLD_BAND : STEADY_BAND,
		pinned: s.pinned,
		excluded,
		oneMapPerSet: s.oneMapPerSet,
		manualOnly: s.manualRotation,
		repeat: !warmingUp && s.playlistKind === 'repeat',
		setRepeats: s.repeats ?? {},
		// a 1500-row list is milliseconds to take in and draw: during a scan, only when asked for
		withBest: view === 'maps' && (!scanning || s.liveMaps),
		everyRate: s.everyRate,
	}), [target, recentPlays, s.delaySec, s.excludeFailed, medals, loved, gear, warmingUp, s.warmupSize, s.playlistSize, s.autoSize,
		s.playlistKind, s.pinned, excluded, s.oneMapPerSet, s.manualRotation, s.repeats, s.liveMaps, s.everyRate, view, scanning]);
	const { view: model, behind, send, ask } = useFarm(farmSettings);
	const rotation = model?.rotation ?? NO_PLAYS;
	/** How many times in a row each playlist map plays: more than once only for the Repeats playlist. */
	const repeats = model?.repeats ?? NO_REPEATS;
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
			// where the library is played: the peak, or the fatigue set in Settings
			const atPeak = s.scanAtPeak ? peakMinutes(rowGear) : Math.max(0, s.scanMinutes);
			const tiredMinutes = withPeak(stateMinutes(rowGear), s.scanAtPeak ? undefined : peakMinutes(rowGear));
			const rates = ratesFor(Number(row?.speedUpgrades) || 0, s.excludedRates);
			const screened = screenRates(rates);
			const mods: Mod[][] = s.tryHardRock ? [[], ['HR']] : [[]];
			send({ type: 'reset' });
			setSkipped(0);

			const addPeaks = (batch: SimResult[]) => send({ type: 'plays', peaks: batch });
			tried.current.clear();
			const options = {
				target,
				recentPlays: s.applyMindblock ? plays : new Map(),
				delaySec: s.delaySec,
				maxFailRate: s.excludeFailed ? 0.5 : 1,
				medals: multiplier ?? 1,
			};

			// A fast scan screens what players near your level played lately, at the rates
			// they played too, and a share of the rest; without them, the whole library.
			let toScreen = survey.requests.map(map => ({ ...map, rates: screened }));
			if (s.fastScan && scout && row) {
				setPhase({ kind: 'scanning', label: 'Scouting players near your level', done: 0, total: 0 });
				try {
					const scouted = await scoutRecent(scout, farmLevels(row, target), Number(row.id));
					const picked = scoutedRequests(survey.requests, scouted, rates, screened);
					if (picked.some(map => scouted.has(map.beatmapId))) toScreen = picked;
				} catch (e) {
					console.warn('[farm] scouting failed, scanning the whole library:', e);
				}
			}

			// Screen the library once, then spend the full run count near the top. Screening
			// seeds memory with the map's own plays: a map never played is one the sim cache
			// can answer for.
			const screening = await pass('Screening', toScreen.map(map => ({
				...map, mods, minutes: [atPeak],
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
				setId: map.setId, beatmapId: map.beatmapId, rates: [map.rate], mods: [map.mods], minutes: tiredMinutes,
			})), Math.max(1, s.runs - 1), batch => send({ type: 'plays', states: batch }));
			setPhase({ kind: 'ready' });
		} catch (e) {
			await failed(e);
		}
	}, [characterId, refreshCharacters, s, target, pass, failed, scout, send, ask]);

	useEffect(() => {
		if (phase.kind !== 'ready' || target.kind === 'pp') return;
		const missing = rotation.filter(map => !tried.current.has(playKey(map)));
		if (!missing.length) return;
		for (const map of missing) tried.current.add(playKey(map));
		void (async () => {
			try {
				await pass('Forecasting', missing.map(map => ({
					setId: map.setId, beatmapId: map.beatmapId, rates: [map.rate], mods: [map.mods], minutes: withPeak(stateMinutes(gear), s.scanAtPeak ? undefined : peakMinutes(gear)),
				})), Math.max(1, s.runs - 1), batch => send({ type: 'plays', states: batch }));
			} catch (e) {
				return failed(e);
			}
			setPhase({ kind: 'ready' });
		})();
	}, [phase.kind, rotation, target.kind, gear, s.runs, s.scanAtPeak, pass, failed, send]);

	useEffect(() => () => sweepRef.current?.cancel(), []);

	/** Simulate one difficulty at every rate the character can play, at the fatigue scans play at. */
	const everyRateOf = useCallback(async (map: MapRow) => {
		const rates = rateSteps(Number(character?.speedUpgrades) || 0);
		try {
			const outcome = await pass(`Every rate`, [{
				setId: map.setId, beatmapId: map.beatmapId, rates, mods: [map.mods],
				minutes: [s.scanAtPeak ? peakMinutes(gear) : Math.max(0, s.scanMinutes)],
			}], s.runs, batch => send({ type: 'plays', peaks: batch }));
			if (!outcome.cancelled) setPhase({ kind: 'ready' });
		} catch (e) {
			await failed(e);
		}
	}, [character, pass, s.scanAtPeak, s.scanMinutes, s.runs, gear, send, failed]);

	const save = useCallback(async () => {
		if (!rotation.length) return;
		setSaveState('saving');
		try {
			const { created } = await replacePlaylist(s.playlistName, rotation.map((map, i) => ({ ...map, repeat: repeats[i] ?? 1 })));
			setSaveState(`${created ? 'Created' : 'Updated'} "${s.playlistName}". Reopen song select to see it.`);
		} catch (e) {
			setSaveState(e instanceof Error ? e.message : String(e));
		}
	}, [rotation, repeats, s.playlistName]);

	/** Pin and toggle individual difficulty rates without knocking out distinct rate variations */
	const toggle = useCallback(
		(map: MapRow) => {
			const key = playKey(map);
			if (rotation.some(other => playKey(other) === key)) {
				update({
					pinned: s.pinned.filter(other => other !== key),
					excluded: [...s.excluded, map.beatmapId],
				});
			} else {
				update({
					pinned: [...s.pinned.filter(other => other !== key), key],
					excluded: s.excluded.filter(id => id !== map.beatmapId),
				});
			}
		},
		[rotation, s.pinned, s.excluded, update],
	);

	const steps = rateSteps(Number(character?.speedUpgrades) || 0);
	const noRates = steps.every(step => s.excludedRates.includes(step));

	return (
		<div style={{ display: open ? 'contents' : 'none' }} aria-hidden={!open}>
			<div className="backdrop" onClick={onClose} />
			<div className="panel" role="dialog" aria-label="oss!idle sim">
				<header>
					<h1>oss!idle sim</h1>
					<label
						className="character"
						title="The character the simulation plays. Detected from your last play; check it is who you are playing."
					>
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
									{row.name} · lv {row.overallLevel}
									{row.local ? ' (guest)' : ''}
								</option>
							))}
						</select>
					</label>
					<span className="spacer" />
					<nav className="seg" aria-label="View">
						<button className={view === 'playlist' ? 'on' : ''} onClick={() => setView('playlist')}>
							Playlist
						</button>
						<button className={view === 'maps' ? 'on' : ''} onClick={() => setView('maps')}>
							All maps {!!model?.maps && <span className="count">{model.maps.toLocaleString()}</span>}
						</button>
						<button className={view === 'target' ? 'on' : ''} onClick={() => setView('target')}>
							Target
						</button>
					</nav>
					<span className="spacer" />
					<span className="hint">v{version}</span>
					<button
						className="icon"
						aria-label="Settings"
						aria-expanded={drawer}
						onClick={() => setDrawer(!drawer)}
					>
						<svg
							width="18"
							height="18"
							viewBox="0 0 24 24"
							aria-hidden
							fill="none"
							stroke="currentColor"
							strokeWidth="1.8"
						>
							<path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
							<circle cx="16" cy="7" r="2" />
							<circle cx="10" cy="17" r="2" />
						</svg>
					</button>
					<button className="icon" aria-label="Close" onClick={onClose}>
						<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
							<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" />
						</svg>
					</button>
				</header>

				<div className="toolbar">
					<span className="label">Farm</span>
					<div className="seg" role="group" aria-label="Goal">
						<button
							className={s.targetSkill === 'total' ? 'on' : ''}
							onClick={() => update({ targetSkill: 'total' })}
						>
							Total XP
						</button>
						<button
							className={target.kind === 'skills' ? 'on' : ''}
							onClick={() => update({ targetSkill: 'skills' })}
						>
							Skills
						</button>
						<button
							className={s.targetSkill === 'pp' ? 'on' : ''}
							onClick={() => update({ targetSkill: 'pp' })}
						>
							pp
						</button>
					</div>
					{target.kind === 'skills' && (
						<SkillMultiplierPicker
							weights={s.skillWeights ?? { stamina: 1.0 }}
							onChange={updateSkillWeight}
						/>
					)}
					<label
						style={{
							display: 'inline-flex',
							alignItems: 'center',
							gap: '4px',
							fontSize: '11px',
							color: s.manualRotation ? '#38bdf8' : '#aaa',
							cursor: 'pointer',
							userSelect: 'none',
							marginLeft: '6px',
						}}
						title="Disable automatic rotation building and only use the maps you have specifically pinned."
					>
						<input
							type="checkbox"
							checked={s.manualRotation}
							onChange={e => update({ manualRotation: e.target.checked })}
						/>
						Manual playlist
					</label>
					<span className="spacer" />
					{scanning ? (
						<>
							<div className="progress">
								<div style={{ width: `${phase.total ? (phase.done / phase.total) * 100 : 0}%` }} />
							</div>
							<span className="status">
								{phase.label} {phase.done} / {phase.total}
							</span>
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
								className={simulated ? '' : 'primary'}
								onClick={scan}
								disabled={noRates}
								title={noRates ? 'Pick at least one rate in Settings' : undefined}
							>
								{simulated ? 'Re-scan' : 'Scan library'}
							</button>
						</>
					)}
				</div>

				{phase.kind === 'error' && <div className="empty error">{phase.message}</div>}
				{phase.kind !== 'error' && !simulated && view !== 'target' && (
					<div className="empty">
						{scanning ? (
							'Simulating your library...'
						) : (
							<>
								<p>
									Every downloaded map is played by a simulation of your character,
									<br />
									then the best ones are put together into a playlist that holds you at your warm-up peak.
								</p>
								<button className="primary big" onClick={scan} disabled={noRates}>
									Scan library
								</button>
							</>
						)}
					</div>
				)}
				{model && simulated && view === 'playlist' && (
					<PlaylistView
						rotation={rotation}
						repeats={repeats}
						autoSize={model.size}
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
					<MapsView
						best={model.best ?? NO_PLAYS}
						rotation={rotation}
						index={index}
						target={farm}
						delaySec={s.delaySec}
						onToggle={toggle}
						everyRate={s.everyRate}
						onEveryRate={everyRate => update({ everyRate })}
						onEveryRateOf={everyRateOf}
						busy={scanning}
					/>
				)}

				{/* kept mounted: a search goes on, and its answer stays, while another tab is open */}
				<div style={{ display: view === 'target' ? 'contents' : 'none' }}>
					<TargetView character={character} simulate={simulate} busy={scanning} />
				</div>

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