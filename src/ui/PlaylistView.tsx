import type { MapInfo } from '../engine/client.js';
import { rankingScore, type FarmTarget, type RankedMap } from '../farm/metrics.js';
import type { Forecast } from '../farm/session.js';
import type { Settings } from './App.js';
import ForecastChart from './ForecastChart.js';
import { formatRate, formatTime, formatXp, MapName, PlayChips, Trend } from './parts.js';

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
	const sessionSec = settings.sessionHours * 3600;

	return (
		<div className="split">
			<section className="list">
				<div className="list-head">
					<h2>{pp ? 'Your best pp plays' : 'Your farm playlist'}</h2>
					<span className="hint">
						{rotation.length} maps{pp ? '' : ` · loops every ${Math.round(loopSec / 60)} min`}
					</span>
					<span className="spacer" />
					<div className="stepper">
						<button
							aria-label="Fewer maps" disabled={settings.playlistSize <= 1}
							onClick={() => update({ playlistSize: settings.playlistSize - 1 })}
						>−</button>
						<span>{settings.playlistSize}</span>
						<button
							aria-label="More maps" disabled={settings.playlistSize >= 20}
							onClick={() => update({ playlistSize: settings.playlistSize + 1 })}
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
							<button className="remove" aria-label="Take out of the playlist" title="Take out" onClick={() => onToggle(map)}>×</button>
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
				) : (
					<>
						<div className="outlook-head">
							<h2>{settings.sessionHours}-hour session</h2>
							<span className="hint">from {settings.startWarm ? 'warm' : 'rested'}, {settings.delaySec}s between maps</span>
						</div>
						<div className="stats">
							<div className="stat">
								<div className="label">Average</div>
								<div className="big">{formatXp(forecast.perHour)} <small>XP/h</small></div>
							</div>
							<div className="stat">
								<div className="label">At peak</div>
								<div className="big">
									{forecast.peakAt === undefined ? 'never' : formatTime(forecast.peakAt / 60)}
									{forecast.peakAt !== undefined && <small> in</small>}
								</div>
							</div>
						</div>
						<figure className="card">
							<figcaption className="label">Warm-up over the session</figcaption>
							<ForecastChart forecast={forecast} baseline={baseline} sessionSec={sessionSec} />
							<div className="chart-legend">
								<span><i className="swatch forecast" />This playlist</span>
								<span><i className="swatch baseline" />{rotation.length} best maps alone · {formatXp(baseline.perHour)} XP/h</span>
							</div>
						</figure>
						<p className="why">
							{heavy} heavy map{heavy === 1 ? '' : 's'} warm you up <span className="trend warm">›››</span>
							{', '}{rotation.length - heavy} lighter one{rotation.length - heavy === 1 ? '' : 's'} let you rest <span className="trend rest">‹‹</span>.
							{' '}A loop that warms you faster than you rest drifts into fatigue, which cuts what the physical skills earn.
						</p>
					</>
				)}
			</aside>
		</div>
	);
}
