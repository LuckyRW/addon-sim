import { useMemo, useState } from 'react';
import type { MapInfo } from '../engine/client.js';
import { bestPerDifficulty, playKey, rankingScore, type FarmTarget, type RankedMap } from '../farm/metrics.js';
import { driftOf, type SessionOptions } from '../farm/session.js';
import { formatRate, MapName, PlayChips } from './parts.js';

/** Rows the table renders at most: a thousand-map library would be a slow DOM for nothing. */
const SHOWN = 300;

export type MapFilterKind = 'all' | 'warm' | 'cool';

/** Every difficulty at its best play, with warming/cooling filters and hand-picking into the playlist. */
export default function MapsView({
	ranked,
	rotation,
	index,
	target,
	session,
	onToggle,
}: {
	ranked: RankedMap[];
	rotation: RankedMap[];
	index: Map<number, MapInfo>;
	target: FarmTarget;
	session: SessionOptions;
	onToggle: (map: RankedMap) => void;
}) {
	const [query, setQuery] = useState('');
	const [filter, setFilter] = useState<MapFilterKind>('all');

	const picked = useMemo(() => new Map(rotation.map(map => [map.beatmapId, map])), [rotation]);

	const rows = useMemo(() => {
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		// a playlist entry is listed at the play the playlist makes
		let list = bestPerDifficulty(ranked).map(map => picked.get(map.beatmapId) ?? map);

		if (filter !== 'all') {
			list = list.filter(map => {
				const d = driftOf(map, session);
				return filter === 'warm' ? d > 0 : d <= 0;
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
	}, [ranked, picked, index, query, filter, session]);

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
					<span className="num">Today</span>
				</div>
				{rows.slice(0, SHOWN).map((map, i) => {
					const inPlaylist = picked.get(map.beatmapId) === map;
					const dMin = driftOf(map, session);
					const dSec = Math.round(dMin * 60);

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
							<span className="num strong">{pp ? map.pp.toFixed(1) : formatRate(rankingScore(map, target))}</span>
							{!pp && <span className="num muted">{map.pp.toFixed(0)}</span>}
							<span className="num fail">{map.failRate ? `${Math.round(map.failRate * 100)}%` : ''}</span>
							<span
								className="num"
								style={{
									fontFamily: 'monospace',
									fontWeight: 600,
									color: dSec > 0 ? '#f43f5e' : dSec < 0 ? '#38bdf8' : '#888',
								}}
							>
								{dSec >= 0 ? `+${dSec}s` : `${dSec}s`}
							</span>
							<span className="num muted">{map.recentPlays || ''}</span>
						</div>
					);
				})}
			</div>
		</section>
	);
}