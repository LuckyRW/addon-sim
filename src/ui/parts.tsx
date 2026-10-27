import { warmupTrend } from '@oss-idle/shared/fatigue';
import { modsLabel } from '@oss-idle/shared/mods';
import { rateLabel } from '@oss-idle/shared/rate';
import type { MapInfo } from '../engine/client.js';
import type { RankedMap } from '../farm/metrics.js';

export const formatTime = (seconds: number) => {
	const total = Math.round(seconds);
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

export const formatRate = (value: number) =>
	value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);

export const formatXp = (value: number) =>
	value >= 10_000 ? `${(value / 1000).toFixed(1)}k` : Math.round(value).toLocaleString();

/** The rate and mods a play runs at. */
export function PlayChips({ map }: { map: RankedMap }) {
	return (
		<span className="chips">
			<span className="chip">{rateLabel(map.rate)}</span>
			{map.mods.length > 0 && <span className="chip mod">{modsLabel(map.mods)}</span>}
		</span>
	);
}

/** fatigue.ts's REST_RATE: the fatigue an easy minute played rests. */
const REST_RATE = 0.2;

/** How far a play moves the character's fatigue, signed: the drift behind the game's own arrows. */
export function Trend({ map }: { map: RankedMap }) {
	const drift = map.strained - REST_RATE * (map.lengthMin - map.strained);
	const trend = warmupTrend(map.lengthMin, map.strained);
	const effect = trend > 0 ? ': warms you up' : trend < 0 ? ': lets you rest' : '';
	return (
		<span
			className={`trend${trend > 0 ? ' warm' : trend < 0 ? ' rest' : ''}`}
			title={`Strained ${formatTime(map.strained * 60)} of ${formatTime(map.lengthMin * 60)}${effect}`}
		>
			{drift < 0 ? '−' : '+'}{formatTime(Math.abs(drift) * 60)}
		</span>
	);
}

/** A map's title and, under it, its difficulty. */
export function MapName({ map, info }: { map: RankedMap; info?: MapInfo }) {
	return (
		<div className="map">
			<div className="title">{info ? `${info.artist} - ${info.title}` : `#${map.beatmapId}`}</div>
			<div className="sub">
				{info?.version ?? ''}
				{map.stars ? ` · ${map.stars.toFixed(2)}★` : ''} · {formatTime(map.durationSec)}
			</div>
		</div>
	);
}
