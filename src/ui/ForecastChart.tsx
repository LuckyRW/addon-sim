import { BAR_ZONES } from '@oss-idle/shared/fatigue';
import type { Forecast } from '../farm/session.js';

const W = 370;
const H = 150;
const LEFT = 34;
const TOP = 6;
const PLOT_H = 124;

/** The game's warm-up bar zones, coldest first, in its HUD colours. */
const ZONES = [
	{ label: 'Cold', color: '#4da3ff' },
	{ label: 'Peak', color: '#ffd34d' },
	{ label: 'Push', color: '#ff9a4d' },
	{ label: 'Tired', color: '#b48cff' },
];
const EDGES = [0, ...BAR_ZONES, 1];

const y = (bar: number) => TOP + PLOT_H * (1 - bar);

/** Where the warm-up bar sits over a session: this playlist, and the best maps alone for comparison. */
export default function ForecastChart({ forecast, baseline, sessionSec }: {
	forecast: Forecast;
	baseline?: Forecast;
	sessionSec: number;
}) {
	const x = (at: number) => LEFT + (W - LEFT - 6) * Math.min(1, at / sessionSec);
	const line = (f: Forecast) => f.samples.map(s => `${x(s.at).toFixed(1)},${y(s.bar).toFixed(1)}`).join(' ');
	const hours = Math.round(sessionSec / 3600);
	const step = hours > 48 ? 24 : hours > 8 ? 6 : 1;
	return (
		<svg
			className="chart" width="100%" viewBox={`0 0 ${W} ${H + 18}`}
			role="img" aria-label="Warm-up bar over the session"
		>
			{ZONES.map((zone, i) => (
				<g key={zone.label}>
					<rect
						x={LEFT} y={y(EDGES[i + 1]!)} width={W - LEFT - 6} height={y(EDGES[i]!) - y(EDGES[i + 1]!)}
						fill={zone.color} opacity={0.13}
					/>
					<text x={LEFT - 4} y={(y(EDGES[i]!) + y(EDGES[i + 1]!)) / 2 + 3} fill={zone.color} textAnchor="end">
						{zone.label}
					</text>
				</g>
			))}
			{baseline && <polyline className="baseline" points={line(baseline)} />}
			<polyline className="forecast" points={line(forecast)} />
			{Array.from({ length: hours / step + 1 }, (_, i) => i * step).map(h => (
				<text key={h} x={x(h * 3600)} y={H + 14} textAnchor={h === 0 ? 'start' : h === hours ? 'end' : 'middle'}>
					{h}h
				</text>
			))}
		</svg>
	);
}
