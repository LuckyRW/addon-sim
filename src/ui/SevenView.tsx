/**
 * 7K: maps measured from real plays, what is left to test, and playlists that test it.
 * See `engine/seven.ts`.
 */

import { useEffect, useMemo, useState } from 'react';
import { beatmapStore, type CharacterRow } from '@oss-idle/addon-sdk';
import { rateSteps } from '@oss-idle/shared/rate';
import { replacePlaylist } from '../engine/playlist.js';
import {
	attemptsOf, baseOf, MEDALS_KEY, medals7k, progress7k, readAttempts, recorderStatus, screenRates, statusOf, testsOf, totalOf,
	type Attempt, type Progress7k,
} from '../engine/seven.js';
import { formatXp, NumberField, skillBreakdown, skillLabel } from './parts.js';

type Map7k = { beatmapId: number; title: string; artist: string; version: string; difficulty: number; lengthSec: number };

/** A map tested at a rate: its last pass, worth so much base XP a second. */
type Measured = {
	map: Map7k;
	rate: number;
	perSecond: number;
	/** base XP / s by skill */
	skills: Record<string, number>;
	top: string;
	topPerSecond: number;
	level?: number;
	at: number;
	plays: number;
	fails: number;
	/** mean warm-up bar change per play, start to the next play's start */
	drift?: number;
};

const MAX_ENTRIES_DEFAULT = 200;

export default function SevenView({ character, version }: { character?: CharacterRow; version: number }) {
	const [maps, setMaps] = useState<Map7k[]>([]);
	const [progress, setProgress] = useState<Progress7k>();
	const [attempts, setAttempts] = useState<Attempt[]>([]);
	const [medals, setMedals] = useState(medals7k());
	const [name, setName] = useState('7K tests');
	const [maxEntries, setMaxEntries] = useState(MAX_ENTRIES_DEFAULT);
	const [refineMaps, setRefineMaps] = useState(20);
	const [saved, setSaved] = useState('');

	useEffect(() => {
		void beatmapStore.difficulties().then(list => setMaps(list
			.filter(({ version: v }) => v.mode === 3 && v.keys === 7)
			.map(({ set, version: v }) => ({
				beatmapId: v.id, title: set.title, artist: set.artist, version: v.version, difficulty: v.difficulty, lengthSec: v.total_length / 1000,
			}))))
			.catch(() => setMaps([]));
	}, []);
	useEffect(() => {
		if (!character) return;
		void progress7k(Number(character.id)).then(setProgress);
		setAttempts(attemptsOf(Number(character.id)));
	}, [character?.id, version]);

	const byId = useMemo(() => new Map(maps.map(m => [m.beatmapId, m])), [maps]);
	const rates = useMemo(() => rateSteps(progress?.speedUpgrades ?? 0), [progress?.speedUpgrades]);
	const screened = useMemo(() => screenRates(rates), [rates]);
	const tests = useMemo(() => testsOf(attempts, progress?.levelSum ?? 0), [attempts, progress?.levelSum]);

	const measured = useMemo(() => {
		const rows: Measured[] = [];
		const ordered = [...attempts].sort((a, b) => a.startedAt - b.startedAt);
		const drifts = new Map<string, number[]>();
		ordered.forEach((a, i) => {
			const next = ordered[i + 1];
			const map = byId.get(a.beatmapId);
			if (!map || a.bar === undefined || next?.bar === undefined) return;
			// the next play started soon after: the change is this play's, and the wait after it
			if (next.startedAt - a.startedAt > (map.lengthSec / a.rate + 600) * 1000) return;
			const key = `${a.beatmapId}@${a.rate}@${a.mods}`;
			drifts.set(key, [...drifts.get(key) ?? [], next.bar - a.bar]);
		});
		for (const [key, t] of tests) {
			const [id, mods] = key.split('|');
			if (mods) continue; // no mods only, for now
			const map = byId.get(Number(id));
			if (!map) continue;
			for (const [rate, list] of t.byRate) {
				const passes = list.filter(a => !a.failed);
				const last = passes.at(-1);
				if (!last) continue;
				const base = baseOf(last, ordered);
				const seconds = map.lengthSec / rate;
				const [top, topXp] = Object.entries(base).sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
				const d = drifts.get(`${id}@${rate}@`);
				rows.push({
					map, rate, perSecond: totalOf(base) / seconds, skills: Object.fromEntries(Object.entries(base).map(([s, xp]) => [s, xp / seconds])), top, topPerSecond: topXp / seconds,
					level: top ? last.levels[top] : undefined, at: last.startedAt, plays: list.length, fails: list.length - passes.length,
					drift: d?.length ? d.reduce((x, y) => x + y, 0) / d.length : undefined,
				});
			}
		}
		return rows.sort((a, b) => b.perSecond - a.perSecond);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [tests, byId, attempts, medals]);

	const counts = useMemo(() => {
		let untested = 0, ruledOut = 0, tested = 0;
		for (const m of maps) {
			for (const rate of screened) {
				const s = statusOf(tests.get(`${m.beatmapId}|`), rate);
				if (s === 'untested') untested++;
				else if (s === 'too easy' || s === 'too hard') ruledOut++;
				else tested++;
			}
		}
		return { untested, ruledOut, tested };
	}, [maps, screened, tests]);

	const save = async (kind: 'x1' | 'screen' | 'refine') => {
		const entries: { beatmapId: number; rate: number }[] = [];
		const open = (id: number, rate: number) => statusOf(tests.get(`${id}|`), rate) === 'untested';
		if (kind === 'x1') {
			for (const m of maps) if (rates.includes(1) && open(m.beatmapId, 1)) entries.push({ beatmapId: m.beatmapId, rate: 1 });
		} else if (kind === 'screen') {
			// a map's rates from x1 outwards: the nearest tests narrow it fastest
			for (const m of maps) {
				for (const rate of [...screened].sort((a, b) => Math.abs(a - 1) - Math.abs(b - 1))) {
					if (open(m.beatmapId, rate)) entries.push({ beatmapId: m.beatmapId, rate });
				}
			}
		} else {
			const best = new Map<number, Measured>();
			for (const row of measured) if (!best.has(row.map.beatmapId)) best.set(row.map.beatmapId, row);
			for (const row of [...best.values()].slice(0, refineMaps)) {
				const at = screened.indexOf(row.rate);
				const below = at >= 0 ? screened[at - 1] ?? -Infinity : row.rate - 0.051;
				const above = at >= 0 ? screened[at + 1] ?? Infinity : row.rate + 0.051;
				for (const rate of rates) if (rate > below && rate < above && open(row.map.beatmapId, rate)) entries.push({ beatmapId: row.map.beatmapId, rate });
			}
		}
		const kept = entries.slice(0, maxEntries);
		if (!kept.length) { setSaved('Nothing left to test there.'); return; }
		setSaved('Saving...');
		try {
			const { created } = await replacePlaylist(name, kept.map(e => ({ ...e, mods: [] })));
			setSaved(`${created ? 'Created' : 'Updated'} "${name}" with ${kept.length} plays${entries.length > kept.length ? ` (of ${entries.length})` : ''}. Reopen song select to see it.`);
		} catch (e) {
			setSaved(e instanceof Error ? e.message : String(e));
		}
	};

	return (
		<section className="maps target">
			<div className="target-form">
				<p className="hint">
					7K has no sim: every 7K play you make is recorded here as it happens, fails included (the game keeps no failed play),
					with your levels before it and how tired and warm you started it. Base XP takes out mindblock, fatigue, medals, genetics, mods and your skill multipliers.
					A map at a rate that gave 0 XP rules out its slower rates; one that failed rules out its faster rates until a skill levels up. No mods only, for now.
				</p>
				{!progress && <p className="empty">No 7K progress found for this character: play 7K once, or pick the character you play it on.</p>}
				<div className="target-row">
					<span className="hint" title={recorderStatus.problem || undefined} style={recorderStatus.sockets ? undefined : { color: '#fbbf24' }}>
						{recorderStatus.sockets ? '● listening' : '○ not connected yet: starts with the next play'}
						{recorderStatus.lastMessage ? ` · last play message ${Math.round((Date.now() - recorderStatus.lastMessage) / 60000)} min ago` : ''}
						{recorderStatus.problem ? ` · ⚠ ${recorderStatus.problem}` : ''}
					</span>
					<span className="hint">{attempts.length.toLocaleString()} plays recorded · {maps.length.toLocaleString()} 7K maps downloaded · {rates.length} rates</span>
					<span className="spacer" />
					<label className="strain-filter" title="Your medals' XP multiplier: the same on every skill, so it changes no ranking, only the numbers">
						Medals ×
						<NumberField aria-label="Medal multiplier" min={1} max={100} value={medals}
							onChange={v => { setMedals(v); try { localStorage.setItem(MEDALS_KEY, String(v)); } catch { /* not kept */ } }} />
					</label>
				</div>
				<p className="why">
					Screening grid ({screened.map(r => `x${r}`).join(', ')}): {counts.tested.toLocaleString()} tested,{' '}
					{counts.ruledOut.toLocaleString()} ruled out, {counts.untested.toLocaleString()} left.
				</p>
				<div className="target-row">
					<input aria-label="Playlist name" value={name} onChange={e => setName(e.target.value)} />
					<label className="strain-filter" title="The most plays one playlist holds">
						Up to
						<NumberField aria-label="Most plays" min={1} max={2000} integer value={maxEntries} onChange={setMaxEntries} />
					</label>
					<button disabled={!maps.length} onClick={() => void save('x1')} title="Every 7K map not yet tested at x1">Untested at x1</button>
					<button disabled={!maps.length} onClick={() => void save('screen')} title="Each map at its screening rates not yet tested or ruled out, nearest x1 first">Screening</button>
					<label className="strain-filter" title="How many of the best measured maps the refining playlist takes">
						best
						<NumberField aria-label="Maps to refine" min={1} max={500} integer value={refineMaps} onChange={setRefineMaps} />
					</label>
					<button disabled={!measured.length} onClick={() => void save('refine')} title="The best measured maps at the untested rates between the screened rates either side of their best">Refining</button>
				</div>
				{saved && <p className="hint">{saved}</p>}
			</div>
			<div className="rows">
				<div className="row crown head">
					<span>Map</span><span className="num">Rate</span><span className="num">Base XP/s</span><span className="num">Best skill</span><span className="num">Drift / play</span>
				</div>
				{measured.slice(0, 200).map(row => (
					<div className="row crown" key={`${row.map.beatmapId}@${row.rate}`}>
						<span className="name" title={`${row.plays} plays, ${row.fails} failed · last ${new Date(row.at).toLocaleString()}`}>
							{row.map.artist} - {row.map.title} <span className="hint">[{row.map.version}]</span>
						</span>
						<span className="num">x{row.rate}</span>
						<span className="num strong" title={skillBreakdown(row.skills)}>{formatXp(row.perSecond)}</span>
						<span className="num" title={row.level !== undefined ? `played at level ${row.level}` : undefined}>
							{row.top ? <>{skillLabel(row.top)} {formatXp(row.topPerSecond)} <span className="hint">{row.level !== undefined ? `Lv ${row.level}` : ''}</span></> : ''}
						</span>
						<span className="num" style={{ color: row.drift === undefined ? '#888' : row.drift > 0 ? '#f87171' : '#38bdf8' }}>
							{row.drift === undefined ? '' : `${row.drift > 0 ? '+' : ''}${(row.drift * 100).toFixed(1)}%`}
						</span>
					</div>
				))}
				{!measured.length && <p className="empty">No 7K plays recorded yet: play some, then come back.</p>}
			</div>
		</section>
	);
}
