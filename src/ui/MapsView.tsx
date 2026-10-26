import { useMemo, useState } from 'react';
import type { MapInfo } from '../engine/client.js';
import { bestPerDifficulty, playKey, rankingScore, type FarmTarget, type RankedMap } from '../farm/metrics.js';
import { formatRate, MapName, PlayChips, Trend } from './parts.js';

/** Rows the table renders at most: a thousand-map library would be a slow DOM for nothing. */
const SHOWN = 300;

/** Every difficulty at its best play, to search and hand-pick into the playlist. */
export default function MapsView({ ranked, rotation, index, target, onToggle }: {
	ranked: RankedMap[];
	rotation: RankedMap[];
	index: Map<number, MapInfo>;
	target: FarmTarget;
	onToggle: (map: RankedMap) => void;
}) {
	const [query, setQuery] = useState('');
	const picked = useMemo(() => new Map(rotation.map(map => [map.beatmapId, map])), [rotation]);
	const rows = useMemo(() => {
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		// a playlist entry is listed at the play the playlist makes
		const best = bestPerDifficulty(ranked).map(map => picked.get(map.beatmapId) ?? map);
		return words.length
			? best.filter(map => {
				const info = index.get(map.beatmapId);
				const text = `${info?.artist} ${info?.title} ${info?.creator} ${info?.version}`.toLowerCase();
				return words.every(word => text.includes(word));
			})
			: best;
	}, [ranked, picked, index, query]);
	const pp = target.kind === 'pp';

	return (
		<section className="maps">
			<div className="maps-tools">
				<input
					type="search" aria-label="Search maps" placeholder="Search title, artist, mapper"
					value={query} onChange={e => setQuery(e.target.value)}
				/>
				<span className="spacer" />
				<span className="hint">Each difficulty at its best rate and mods. Picked maps stay in the playlist.</span>
			</div>
			<div className="rows">
				<div className="row maps-row head">
					<span /><span className="num">#</span><span>Map</span><span>Plays as</span>
					<span className="num">{pp ? 'pp' : 'XP / s'}</span>
					{!pp && <span className="num">pp</span>}
					<span className="num">Fails</span><span className="num">Warm-up</span><span className="num">Today</span>
				</div>
				{rows.slice(0, SHOWN).map((map, i) => {
					const inPlaylist = picked.get(map.beatmapId) === map;
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
							<Trend map={map} />
							<span className="num muted">{map.recentPlays || ''}</span>
						</div>
					);
				})}
			</div>
		</section>
	);
}
