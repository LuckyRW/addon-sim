import { memo, useMemo, useState } from 'react';
import type { MapInfo } from '../engine/client.js';
import { playKey, type FarmTarget, type MapRow, type RankedMap } from '../farm/metrics.js';
import { formatRate, MapName, PlayChips } from './parts.js';

/** Rows the table renders at most: a thousand-map library would be a slow DOM for nothing. */
const SHOWN = 300;

export type MapFilterKind = 'all' | 'warm' | 'cool';

/** Every difficulty at its best play, with warming/cooling and strain filters, to hand-pick into the playlist. */
export default memo(function MapsView({ best, rotation, index, target, delaySec, onToggle }: {
	/** Every difficulty at its best play, best first, with how it moves fatigue (the farm worker's rows). */
	best: MapRow[];
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

	const picked = useMemo(() => new Map<number, MapRow>(rotation.map(map => [map.beatmapId, map])), [rotation]);

	const rows = useMemo(() => {
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		// a playlist entry is listed at the play the playlist makes
		let list = best.map(map => picked.get(map.beatmapId) ?? map);

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
	}, [best, picked, index, query, filter, strainRange]);

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
					const inPlaylist = picked.get(map.beatmapId) === map;
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
							<span className="num muted">{map.recentPlays || ''}</span>
						</div>
					);
				})}
			</div>
		</section>
	);
});
