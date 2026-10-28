import { useState, type InputHTMLAttributes } from 'react';
import { warmupTrend } from '@oss-idle/shared/fatigue';
import { modsLabel } from '@oss-idle/shared/mods';
import { rateLabel } from '@oss-idle/shared/rate';
import type { MapInfo } from '../engine/client.js';
import { balanced, rankingScore, type FarmTarget, type MapRow } from '../farm/metrics.js';

export const formatTime = (seconds: number) => {
	const total = Math.round(seconds);
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

export const formatRate = (value: number) =>
	value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);

/** What the XP column heads: a balanced target's plays are worth their share of each skill's best play. */
export const worthLabel = (target: FarmTarget) => balanced(target) ? 'Of best' : 'XP / s';

export const formatWorth = (map: MapRow, target: FarmTarget) =>
	balanced(target) ? `${Math.round(map.perSecond * 100)}%` : formatRate(rankingScore(map, target));

export const formatXp = (value: number) =>
	value >= 10_000 ? `${(value / 1000).toFixed(1)}k` : Math.round(value).toLocaleString();

/** The rate and mods a play runs at. */
export function PlayChips({ map }: { map: MapRow }) {
	return (
		<span className="chips">
			<span className="chip">{rateLabel(map.rate)}</span>
			{map.mods.length > 0 && <span className="chip mod">{modsLabel(map.mods)}</span>}
		</span>
	);
}

/** Which way, and how hard, a play moves the warm-up bar: the game's own arrows. */
export function Trend({ map }: { map: MapRow }) {
	const trend = warmupTrend(map.lengthMin, map.strained);
	if (!trend) return <span className="trend" />;
	return (
		<span
			className={`trend ${trend > 0 ? 'warm' : 'rest'}`}
			title={trend > 0 ? 'Warms you up' : 'Lets you rest'}
		>
			{(trend > 0 ? '›' : '‹').repeat(Math.abs(trend))}
		</span>
	);
}

/** A map's title and, under it, its difficulty. */
export function MapName({ map, info }: { map: MapRow; info?: MapInfo }) {
	return (
		<div className="map">
			<div className="title">{info ? `${info.artist} - ${info.title}` : `#${map.beatmapId}`}</div>
			<div className="sub">
				{info?.version ?? ''}
				{' · '}{formatTime(map.durationSec)}
			</div>
		</div>
	);
}

/**
 * A number the player types. The field holds what they type while they type it, so
 * clearing it to write another number leaves it empty rather than putting a number
 * back under the cursor, and nothing is applied halfway through ("150" is not a 1
 * then a 15). What they leave it at (Enter or elsewhere) is applied, kept within
 * `min` and `max`; left empty or not a number, it goes back to the value it had.
 */
export function NumberField({ value, onChange, min, max, integer, ...rest }: {
	value: number;
	onChange: (value: number) => void;
	min: number;
	max?: number;
	/** Whole numbers only. */
	integer?: boolean;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'min' | 'max' | 'type'>) {
	const [draft, setDraft] = useState<string>();
	const apply = () => {
		if (draft === undefined) return;
		const typed = Number(draft);
		if (draft.trim() !== '' && Number.isFinite(typed)) {
			const kept = Math.min(max ?? Infinity, Math.max(min, integer ? Math.round(typed) : typed));
			if (kept !== value) onChange(kept);
		}
		setDraft(undefined);
	};
	return (
		<input
			{...rest}
			type="number" inputMode={integer ? 'numeric' : 'decimal'} min={min} max={max} step={integer ? 1 : 'any'}
			value={draft ?? value}
			onChange={e => setDraft(e.target.value)}
			onBlur={apply}
			onKeyDown={e => {
				if (e.key === 'Enter') e.currentTarget.blur();
			}}
		/>
	);
}
