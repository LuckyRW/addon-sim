import type { MapInfo } from '../engine/client.js';
import { rankingScore, type FarmTarget, type RankedMap } from '../farm/metrics.js';
import { HOLD_HOURS, PEAK_MIDDLE, WARMUP_HOURS, type Forecast } from '../farm/session.js';
import type { PlaylistKind, Settings } from './App.js';
import ForecastChart from './ForecastChart.js';
import { formatRate, formatTime, formatXp, MapName, PlayChips, Trend } from './parts.js';

const KINDS: { kind: PlaylistKind; label: string }[] = [
	{ kind: 'warmup', label: 'Warm-up' },
	{ kind: 'steady', label: 'Steady' },
	{ kind: 'xp', label: 'More XP' },
];

/** The playlist, what a session of it earns, and saving it. */
export default function PlaylistView({
	rotation, index, target, forecast, baseline, settings, update, onToggle, onSave, saveState,
}: {
	rotation: RankedMap[];
	index: Map<number, MapInfo>;
	target: FarmTarget;
	forecast: Forecast;
	baseline: Forecast;
	settings: Settings;
	update: (patch: Partial<Settings>) => void;
	onToggle: (map: RankedMap) => void;
	onSave: () => void;
	saveState: string;
}) {
	const pp = target.kind === 'pp';
	const loopSec = rotation.reduce((sum, map) => sum + map.durationSec + settings.delaySec, 0);
	const heavy = rotation.filter(map => map.strained >= map.lengthMin / 2).length;
	const warmup = !pp && settings.playlistKind === 'warmup';
	const sizeKey = warmup ? 'warmupSize' : 'playlistSize';
	const size = settings[sizeKey];
	const sessionSec = (warmup ? WARMUP_HOURS : HOLD_HOURS) * 3600;
	const warmPlays = forecast.warmAt === undefined ? 0 : forecast.samples.findIndex(sample => sample.at >= forecast.warmAt!);
	const holds = forecast.leavesAt === undefined;
	const warming = (forecast.samples.at(-1)?.bar ?? PEAK_MIDDLE) > PEAK_MIDDLE;

	return (
		<div className="split">
			<section className="list">
				<div className="list-head">
					{pp ? <h2>Your best pp plays</h2> : (
						<div className="seg" role="group" aria-label="Playlist">
							{KINDS.map(({ kind, label }) => (
								<button
									key={kind} className={settings.playlistKind === kind ? 'on' : ''}
									onClick={() => update({ playlistKind: kind, playlistNameTouched: false })}
								>{label}</button>
							))}
						</div>
					)}
					<span className="hint">
						{rotation.length} maps{pp ? '' : ` · loops every ${Math.round(loopSec / 60)} min`}
					</span>
					<span className="spacer" />
					<div className="stepper">
						<button
							aria-label="Fewer maps" disabled={size <= 1}
							onClick={() => update({ [sizeKey]: size - 1 })}
						>−</button>
						<span>{size}</span>
						<button
							aria-label="More maps" disabled={size >= 20}
							onClick={() => update({ [sizeKey]: size + 1 })}
						>+</button>
					</div>
				</div>
				<div className="rows">
					<div className="row playlist head">
						<span /><span>Map</span><span>Plays as</span>
						<span className="num">{pp ? 'pp' : 'XP / s'}</span><span className="num">Warm-up</span><span />
					</div>
					{rotation.map((map, i) => (
						<div className="row playlist" key={`${map.beatmapId}@${map.rate}`}>
							<span className="num muted">{i + 1}</span>
							<MapName map={map} info={index.get(map.beatmapId)} />
							<PlayChips map={map} />
							<span className="num strong" title={`at peak warm-up, ±${(map.variation * 100).toFixed(0)}% over ${map.runs} run(s)`}>
								{pp ? map.pp.toFixed(1) : formatRate(rankingScore(map, target))}
							</span>
							<Trend map={map} />
							<button className="remove" aria-label="Take out of the playlist" title="Take out" onClick={() => onToggle(map)}>
								<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1l8 8M9 1l-8 8" /></svg>
							</button>
						</div>
					))}
				</div>
				<footer>
					<label className="label" htmlFor="playlist-name">Name</label>
					<input
						id="playlist-name" type="text" value={settings.playlistName}
						onChange={e => update({ playlistName: e.target.value, playlistNameTouched: true })}
					/>
					<span className="hint">Each map keeps its rate and mods</span>
					<span className="spacer" />
					<button className="primary" onClick={onSave} disabled={!rotation.length || saveState === 'saving'}>
						{saveState === 'saving' ? 'Saving...' : 'Save playlist'}
					</button>
				</footer>
				{saveState && saveState !== 'saving' && <div className="saved">{saveState}</div>}
			</section>

			<aside className="outlook">
				{pp ? (
					<p className="why">
						pp does not build up over a session: only your best score on a map counts.
						These are the plays your character scores most on, at its warm-up peak.
					</p>
				) : warmup ? (
					<>
						<div className="outlook-head">
							<h2>Warming up</h2>
							<span className="hint">from rested, {settings.delaySec}s between maps</span>
						</div>
						<div className="stats">
							<div className="stat">
								<div className="label">At the peak in</div>
								<div className="big">{forecast.warmAt === undefined ? `${WARMUP_HOURS}h+` : formatTime(forecast.warmAt / 60)}</div>
							</div>
							<div className="stat">
								<div className="label">Plays</div>
								<div className="big">{forecast.warmAt === undefined ? '-' : warmPlays}</div>
							</div>
						</div>
						<figure className="card">
							<figcaption className="label">Warm-up over {WARMUP_HOURS} hours</figcaption>
							<ForecastChart forecast={forecast} sessionSec={sessionSec} />
						</figure>
						<p className="why">
							{forecast.warmAt === undefined
								? 'None of your maps warms you up faster than the gaps between them rest you. Try a shorter autopilot delay.'
								: <>The maps that strain you most for their length <span className="trend warm">›››</span>, so the bar climbs fastest.
									{' '}Play it from rested until the bar reaches the middle of the peak, then switch to your Steady playlist.</>}
						</p>
					</>
				) : (
					<>
						<div className="outlook-head">
							<h2>Holding your peak</h2>
							<span className="hint">{HOLD_HOURS} hours AFK, {settings.delaySec}s between maps</span>
						</div>
						<div className="stats">
							<div className="stat">
								<div className="label">Average</div>
								<div className="big">{formatXp(forecast.perHour)} <small>XP/h</small></div>
							</div>
							<div className="stat">
								<div className="label">Stays at peak</div>
								<div className="big">{holds ? `${HOLD_HOURS}h+` : formatTime(forecast.leavesAt! / 60)}</div>
							</div>
						</div>
						<figure className="card">
							<figcaption className="label">Warm-up over {HOLD_HOURS} hours</figcaption>
							<ForecastChart forecast={forecast} baseline={baseline} sessionSec={sessionSec} />
							<div className="chart-legend">
								<span><i className="swatch forecast" />This playlist</span>
								<span>
									<i className="swatch baseline" />{rotation.length} best maps alone
									{baseline.leavesAt === undefined ? ' · hold too' : ` · leave the peak after ${formatTime(baseline.leavesAt / 60)}`}
								</span>
							</div>
						</figure>
						<p className="why">
							{holds ? (
								<>
									{heavy} heavy map{heavy === 1 ? '' : 's'} warm you up <span className="trend warm">›››</span> as much as
									{' '}{rotation.length - heavy} lighter one{rotation.length - heavy === 1 ? '' : 's'} and the gaps between maps let you rest <span className="trend rest">‹‹</span>.
									{settings.playlistKind === 'xp'
										? ' More XP lets the bar drift a little within the peak over 24 hours for more XP.'
										: ' Steady keeps the bar as flat as your maps allow, so it can run as long as you like.'}
									{' '}Start it at your peak: from rested, play the Warm-up playlist first.
								</>
							) : warming
								? 'No mix of your maps rests you as much as it warms you at this size: it drifts past your peak into fatigue. Try more maps or a longer autopilot delay.'
								: 'No mix of your maps warms you as much as it rests you at this size: it cools off your peak. Try fewer maps or a shorter autopilot delay.'}
						</p>
					</>
				)}
			</aside>
		</div>
	);
}
