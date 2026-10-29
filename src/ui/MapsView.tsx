import { memo, useMemo, useState } from 'react';
import type { MapInfo } from '../engine/client.js';
import { playKey, type FarmTarget, type MapRow, type RankedMap } from '../farm/metrics.js';
import { rateLabel } from '@oss-idle/shared/rate';
import { formatRate, MapName, PlayChips } from './parts.js';

/** Rows the table renders at most: a thousand-map library would be a slow DOM for nothing. */
const SHOWN = 300;

export type MapFilterKind = 'all' | 'warm' | 'cool';

/** Every difficulty at its best play, with warming/cooling and strain filters, to hand-pick into the playlist. */
export default memo(function MapsView({ best, rotation, index, target, delaySec, onToggle, everyRate, onEveryRate, onEveryRateOf, busy }: {
	/** Every difficulty at its best play - or every play, with `everyRate` - best first, with how it moves fatigue (the farm worker's rows). */
	best: MapRow[];
	/** List each rate and mods simulated of a difficulty, not only its best. */
	everyRate: boolean;
	onEveryRate: (everyRate: boolean) => void;
	/** Simulate a difficulty at every rate the character can play. */
	onEveryRateOf: (map: MapRow) => void;
	/** A scan is running: simulating more waits for it. */
	busy: boolean;
	rotation: RankedMap[];
	index: Map<number, MapInfo>;
	target: FarmTarget;
	/** Seconds autopilot waits between maps, which Drift/s counts. */
	delaySec: number;
	onToggle: (map: MapRow) => void;
}) {
	const [query, setQuery] = useState('');
	const [filter, setFilter] = useState<MapFilterKind>('all');
	/** The strain density, in percent of drain time, a map needs to be listed: from, to. */
	const [strainRange, setStrainRange] = useState<[number, number]>([0, 100]);
	const percent = (value: string) => Math.max(0, Math.min(100, Number(value) || 0));
	/** Only plays at this rate, or every rate. */
	const [rate, setRate] = useState<number | undefined>();
	/** The rates any play was simulated at, for the filter. */
	const rates = useMemo(() => [...new Set(best.map(map => map.rate))].sort((a, b) => a - b), [best]);

	const picked = useMemo(() => new Map<number, MapRow>(rotation.map(map => [map.beatmapId, map])), [rotation]);

	const rows = useMemo(() => {
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		// a playlist entry is listed at the play the playlist makes; every rate lists them all, the playlist's among them
		let list = everyRate ? [...best] : best.map(map => picked.get(map.beatmapId) ?? map);
		if (rate !== undefined) list = list.filter(map => Math.abs(map.rate - rate) < 1e-6);

		if (filter !== 'all') list = list.filter(map => (filter === 'warm' ? (map.drift ?? 0) > 0 : (map.drift ?? 0) <= 0));

		const [low, high] = strainRange;
		if (low > 0 || high < 100) {
			list = list.filter(map => {
				const pct = Math.round((map.strainShare ?? 0) * 100);
				return pct >= Math.min(low, high) && pct <= Math.max(low, high);
			});
		}

		if (words.length) {
			list = list.filter(map => {
				const info = index.get(map.beatmapId);
				const text = `${info?.artist} ${info?.title} ${info?.creator} ${info?.version}`.toLowerCase();
				return words.every(word => text.includes(word));
			});
		}

		return list;
	}, [best, picked, index, query, filter, strainRange, everyRate, rate]);

	const pp = target.kind === 'pp';

	return (
		<section className="maps">
			<div className="maps-tools">
				<input
					type="search"
					aria-label="Search maps"
					placeholder="Search title, artist, mapper"
					value={query}
					onChange={e => setQuery(e.target.value)}
				/>
				<div className="seg" role="group" aria-label="Fatigue drift filter">
					<button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
						All
					</button>
					<button
						className={filter === 'warm' ? 'on' : ''}
						onClick={() => setFilter('warm')}
						title="Plays that warm you up (drift > 0)"
					>
						Top warming
					</button>
					<button
						className={filter === 'cool' ? 'on' : ''}
						onClick={() => setFilter('cool')}
						title="Plays that cool you down (drift ≤ 0)"
					>
						Top cooling
					</button>
				</div>
				<div className="seg" role="group" aria-label="Rates listed">
					<button className={everyRate ? '' : 'on'} onClick={() => onEveryRate(false)} title="Each difficulty once, at its best rate and mods">
						Best
					</button>
					<button className={everyRate ? 'on' : ''} onClick={() => onEveryRate(true)} title="Every rate and mods simulated of each difficulty">
						Every rate
					</button>
				</div>
				<select
					className="rate-filter"
					aria-label="Only plays at this rate"
					value={rate ?? ''}
					onChange={e => setRate(e.target.value === '' ? undefined : Number(e.target.value))}
				>
					<option value="">Any rate</option>
					{rates.map(r => <option key={r} value={r}>{rateLabel(r)}</option>)}
				</select>
				<label className="strain-filter" title="Only maps strained for this share of their drain time">
					Strain
					<input
						type="text"
						inputMode="numeric"
						aria-label="Least strain density, percent"
						value={strainRange[0]}
						onChange={e => setStrainRange([percent(e.target.value), strainRange[1]])}
					/>
					–
					<input
						type="text"
						inputMode="numeric"
						aria-label="Most strain density, percent"
						value={strainRange[1]}
						onChange={e => setStrainRange([strainRange[0], percent(e.target.value)])}
					/>
					%
				</label>
				<span className="spacer" />
				<span className="hint">
					{filter === 'warm'
						? 'Warming maps sorted by XP/s'
						: filter === 'cool'
						? 'Cooling maps sorted by XP/s'
						: everyRate
						? 'Every rate simulated: ⋯ on a row simulates the rest'
						: 'Each difficulty at its best rate and mods'}
				</span>
			</div>
			<div className="rows">
				<div className="row maps-row head">
					<span />
					<span className="num">#</span>
					<span>Map</span>
					<span>Plays as</span>
					<span className="num">{pp ? 'pp' : 'XP / s'}</span>
					{!pp && <span className="num">pp</span>}
					<span className="num">Fails</span>
					<span className="num">Drift</span>
					<span className="num" title="Seconds of fatigue per second of the loop, the gap after the map included">Drift/s</span>
					<span className="num">Today</span>
				</div>
				{rows.slice(0, SHOWN).map((map, i) => {
					const inPlaylist = everyRate ? rotation.some(other => playKey(other) === playKey(map)) : picked.get(map.beatmapId) === map;
					const dSec = Math.round((map.drift ?? 0) * 60);
					const cycle = map.durationSec + delaySec;
					const perSec = map.driftPerSec ?? 0;
					const strainPct = Math.round((map.strainShare ?? 0) * 100);
					const qualifiesFull = strainPct >= 40;

					return (
						<div className={`row maps-row${inPlaylist ? ' picked' : ''}`} key={playKey(map)}>
							<button
								className={inPlaylist ? 'add in' : 'add'}
								aria-label={inPlaylist ? 'Take out of the playlist' : 'Put in the playlist'}
								onClick={() => onToggle(map)}
							>
								{inPlaylist ? '✓' : '+'}
							</button>
							<span className="num muted">{i + 1}</span>
							<MapName map={map} info={index.get(map.beatmapId)} />
							<PlayChips map={map} />
							<span className="num strong">{pp ? map.pp.toFixed(1) : formatRate(map.xpPerSecond)}</span>
							{!pp && <span className="num muted">{map.pp.toFixed(0)}</span>}
							<span className="num fail">{map.failRate ? `${Math.round(map.failRate * 100)}%` : ''}</span>
							<span
								className="num"
								style={{
									fontFamily: 'monospace',
									display: 'inline-flex',
									alignItems: 'center',
									justifyContent: 'flex-end',
									gap: '4px',
								}}
								title={`Net drift: ${dSec >= 0 ? `+${dSec}s` : `${dSec}s`} | Strain density: ${strainPct}% (${qualifiesFull ? '≥40%: Full strain credit awarded' : '<40%: Partial strain credit'})`}
							>
								<span
									style={{
										fontWeight: 600,
										color: dSec > 0 ? '#f43f5e' : dSec < 0 ? '#38bdf8' : '#888',
									}}
								>
									{dSec >= 0 ? `+${dSec}s` : `${dSec}s`}
								</span>
								<span
									style={{
										fontSize: '10px',
										padding: '1px 3px',
										borderRadius: '3px',
										background: qualifiesFull ? 'rgba(74, 222, 128, 0.15)' : 'rgba(255, 255, 255, 0.05)',
										color: qualifiesFull ? '#4ade80' : '#888',
										border: qualifiesFull ? '1px solid rgba(74, 222, 128, 0.3)' : '1px solid transparent',
									}}
								>
									{strainPct}%
								</span>
							</span>
							<span
								className="num"
								style={{ fontFamily: 'monospace', color: perSec > 0 ? '#f43f5e' : perSec < 0 ? '#38bdf8' : '#888' }}
								title={`${dSec >= 0 ? '+' : ''}${dSec}s of fatigue over ${Math.round(cycle)}s of play and gap`}
							>
								{perSec >= 0 ? '+' : ''}{perSec.toFixed(2)}
							</span>
							<span className="num muted">
								{map.recentPlays || ''}
								<button
									className="every-rate"
									aria-label="Simulate every rate"
									title={busy ? 'Waits for the scan to finish' : 'Simulate this difficulty at every rate you can play'}
									disabled={busy}
									onClick={() => onEveryRateOf(map)}
								>⋯</button>
							</span>
						</div>
					);
				})}
			</div>
		</section>
	);
});
