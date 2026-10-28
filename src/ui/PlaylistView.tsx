import { memo } from 'react';
import type { MapInfo } from '../engine/client.js';
import { type Fatigued, type FarmTarget, type RankedMap } from '../farm/metrics.js';
import { HOLD_HOURS, PEAK_MIDDLE, WARMUP_HOURS, type Forecast } from '../farm/session.js';
import type { PlaylistKind, Settings } from './App.js';
import ForecastChart from './ForecastChart.js';
import { formatRate, formatTime, formatXp, MapName, NumberField, PlayChips } from './parts.js';

const KINDS: { kind: PlaylistKind; label: string }[] = [
	{ kind: 'warmup', label: 'Warm-up' },
	{ kind: 'steady', label: 'Steady' },
	{ kind: 'xp', label: 'More XP' },
	{ kind: 'free', label: 'No hold' },
	{ kind: 'repeat', label: 'Repeats' },
];

/** The playlist, what a session of it earns, and saving it. */
export default memo(function PlaylistView({
	rotation,
	repeats,
	autoSize,
	index,
	target,
	forecast,
	baseline,
	settings,
	update,
	onToggle,
	onSave,
	saveState,
	pending,
}: {
	/** The playlist, each map with how it moves fatigue (the farm worker reads it off the session the maps table uses). */
	rotation: (RankedMap & Partial<Fatigued>)[];
	/** How many times in a row each map plays, by its place in `rotation`. */
	repeats: number[];
	/** The size the farm's playlist has: the one an automatic size found, when it is on. */
	autoSize: number;
	index: Map<number, MapInfo>;
	target: FarmTarget;
	forecast: Forecast;
	baseline: Forecast;
	settings: Settings;
	update: (patch: Partial<Settings>) => void;
	onToggle: (map: RankedMap) => void;
	onSave: () => void;
	saveState: string;
	/** Why the playlist shown is about to change, while it is. */
	pending?: string;
}) {
	const pp = target.kind === 'pp';
	const loopSec = rotation.reduce((sum, map, i) => sum + (map.durationSec + settings.delaySec) * (repeats[i] ?? 1), 0);
	const warmup = !pp && settings.playlistKind === 'warmup';
	const sizeKey = warmup ? 'warmupSize' : 'playlistSize';
	// an automatic size is not for a warm-up, which takes the plays that warm most, nor a playlist picked by hand
	const auto = settings.autoSize && !warmup && !settings.manualRotation;
	const size = auto ? autoSize : settings[sizeKey];
	/** A size set by hand, from the one shown: it turns the automatic size off. */
	const resize = (value: number) => update({ [sizeKey]: Math.max(1, value), ...(auto ? { autoSize: false } : {}) });
	const sessionSec = (warmup ? WARMUP_HOURS : HOLD_HOURS) * 3600;
	const warmPlays =
		forecast.warmAt === undefined
			? 0
			: forecast.samples.findIndex(sample => sample.at >= forecast.warmAt!);
	// the departure is worked out even past the session: a loop that holds may still leave one day
	const holds = forecast.leavesAt === undefined || forecast.leavesAt > sessionSec;
	// neither holds the peak: both play for the most XP wherever the bar goes
	const free = settings.playlistKind === 'free' || settings.playlistKind === 'repeat';
	const warming = (forecast.samples.at(-1)?.bar ?? PEAK_MIDDLE) > PEAK_MIDDLE;

	/** Skills the session earns, most first. */
	const skills = Object.entries(forecast.bySkill ?? {})
		.filter(([, xp]) => xp > 0)
		.sort((a, b) => b[1] - a[1]);

	/** Whether a skill is farmed, fills the gaps, or comes on the side. */
	const roleOf = (skill: string) =>
		target.kind !== 'skills' ||
		(target.weights ? (target.weights[skill] ?? 0) > 0 : (target.skills ?? []).includes(skill))
			? 'main'
			: target.secondary?.includes(skill)
			? 'fill'
			: '';

	return (
		<div className="split">
			<section className="list">
				<div className="list-head">
					{pp ? (
						<h2>Your best pp plays</h2>
					) : (
						<div className="seg" role="group" aria-label="Playlist">
							{KINDS.map(({ kind, label }) => (
								<button
									key={kind}
									className={settings.playlistKind === kind ? 'on' : ''}
									onClick={() => update({ playlistKind: kind, playlistNameTouched: false })}
								>
									{label}
								</button>
							))}
						</div>
					)}
					<span className="hint">
						{pending
							? <><span className="spinner" aria-hidden />{pending}</>
							: `${rotation.length} maps${pp ? '' : ` · loops every ${Math.round(loopSec / 60)} min`}`}
					</span>
					<span className="spacer" />
					{!warmup && !settings.manualRotation && !pp && (
						<button
							className={`size-auto${auto ? ' on' : ''}`}
							aria-pressed={auto}
							title={auto
								? 'The playlist size that does best, found for you. Set a size to choose your own.'
								: 'Find the playlist size that does best'}
							onClick={() => update({ autoSize: !settings.autoSize, playlistSize: size })}
						>
							Auto
						</button>
					)}
					<div className="stepper">
						<button
							aria-label="Fewer maps"
							disabled={size <= 1}
							onClick={() => resize(size - 1)}
						>−</button>
						<NumberField
							aria-label="Maps in the playlist" min={1} integer value={size}
							onChange={resize}
						/>
						<button
							aria-label="More maps"
							onClick={() => resize(size + 1)}
						>
							+
						</button>
					</div>
				</div>
				<div className={pending ? 'rows stale' : 'rows'} aria-busy={!!pending}>
					<div className="row playlist head">
						<span />
						<span>Map</span>
						<span>Plays as</span>
						<span className="num">{pp ? 'pp' : 'XP / s'}</span>
						<span className="num">Warm-up</span>
						<span />
					</div>
					{rotation.map((map, i) => {
						const dSec = Math.round((map.drift ?? 0) * 60);
						const strainRatio = map.strainShare ?? 0;
						const strainPct = Math.round(strainRatio * 100);
						const qualifiesFull = strainPct >= 40;

						return (
							<div className="row playlist" key={`${map.beatmapId}@${map.rate}`}>
								<span className="num muted">{i + 1}</span>
								<MapName map={map} info={index.get(map.beatmapId)} />
								<span className="chips">
									<PlayChips map={map} />
									{(repeats[i] ?? 1) > 1 && (
										<span className="chip repeat" title={`Plays ${repeats[i]} times in a row: saved into the playlist, the game repeats it`}>
											×{repeats[i]}
										</span>
									)}
								</span>
								<span
									className="num strong"
									title={`at peak warm-up, ±${(map.variation * 100).toFixed(0)}% over ${map.runs} run(s)`}
								>
									{pp ? map.pp.toFixed(1) : formatRate(map.xpPerSecond)}
								</span>
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
										{dSec >= 0
											? `+${Math.floor(dSec / 60)}:${String(Math.abs(dSec % 60)).padStart(2, '0')}`
											: `-${Math.floor(Math.abs(dSec) / 60)}:${String(Math.abs(dSec % 60)).padStart(2, '0')}`}
									</span>
									<span
										style={{
											fontSize: '10px',
											padding: '1px 3px',
											borderRadius: '3px',
											background: qualifiesFull ? 'rgba(74, 222, 128, 0.15)' : 'rgba(255, 255, 255, 0.05)',
											color: qualifiesFull ? '#4ade80' : '#888',
											border: qualifiesFull
												? '1px solid rgba(74, 222, 128, 0.3)'
												: '1px solid transparent',
										}}
									>
										{strainPct}%
									</span>
								</span>
								<button
									className="remove"
									aria-label="Take out of the playlist"
									title="Take out"
									onClick={() => onToggle(map)}
								>
									<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
										<path d="M1 1l8 8M9 1l-8 8" />
									</svg>
								</button>
							</div>
						);
					})}
				</div>
				<footer>
					<label className="label" htmlFor="playlist-name">
						Name
					</label>
					<input
						id="playlist-name"
						type="text"
						value={settings.playlistName}
						onChange={e => update({ playlistName: e.target.value, playlistNameTouched: true })}
					/>
					<span className="hint">Each map keeps its rate and mods</span>
					<span className="spacer" />
					<button className="primary" onClick={onSave} disabled={!rotation.length || !!pending || saveState === 'saving'}>
						{saveState === 'saving' ? 'Saving...' : 'Save playlist'}
					</button>
				</footer>
				{saveState && saveState !== 'saving' && <div className="saved">{saveState}</div>}
			</section>

			<aside className="outlook">
				{pp ? (
					<p className="why">
						pp does not build up over a session: only your best score on a map counts. These are
						the plays your character scores most on, at its warm-up peak.
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
								<div className="big">
									{forecast.warmAt === undefined
										? `${WARMUP_HOURS}h+`
										: formatTime(forecast.warmAt / 60)}
								</div>
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
							{forecast.warmAt === undefined ? (
								'None of your maps warms you up faster than the gaps between them rest you. Try a shorter autopilot delay.'
							) : (
								<>
									The maps with the most drift for their length, so the bar climbs fastest. Play
									it from rested until the bar reaches the middle of the peak, then switch to
									your Steady playlist.
								</>
							)}
						</p>
					</>
				) : (
					<>
						<div className="outlook-head">
							<h2>{free ? 'Most XP' : 'Holding your peak'}</h2>
							<span className="hint">
								{HOLD_HOURS} hours AFK, {settings.delaySec}s between maps
							</span>
						</div>
						<div className="stats">
							<div className="stat">
								<div className="label">Average</div>
								<div className="big">
									{formatXp(forecast.xpPerHour ?? forecast.perHour)} <small>XP/h</small>
								</div>
							</div>
							{!free && (
								<div className="stat">
									<div className="label">Stays at peak</div>
									<div className="big">
										{holds
											? `${HOLD_HOURS}h+`
											: formatTime(forecast.leavesAt! / 60)}
									</div>
								</div>
							)}
						</div>
						<figure className="card">
							<figcaption className="label">Warm-up over {HOLD_HOURS} hours</figcaption>
							<ForecastChart forecast={forecast} baseline={baseline} sessionSec={sessionSec} />
							<div className="chart-legend">
								<span>
									<i className="swatch forecast" />
									This playlist
								</span>
								<span>
									<i className="swatch baseline" />
									{rotation.length} best maps alone
									{free
										? ''
										: baseline.leavesAt === undefined
										? ' · hold too'
										: ` · leave the peak after ${formatTime(baseline.leavesAt / 60)}`}
								</span>
							</div>
						</figure>
						{!free && !holds && (
							<p className="why">
								{warming
									? 'No mix of your maps rests you as much as it warms you at this size: it drifts past your peak into fatigue. Try more maps or a longer autopilot delay.'
									: 'No mix of your maps warms you as much as it rests you at this size: it cools off your peak. Try fewer maps or a shorter autopilot delay.'}
							</p>
						)}
						<figure className="card">
							<figcaption className="label">XP per hour</figcaption>
							<ul className="breakdown">
								{skills.map(([skill, xp]) => (
									<li key={skill} className={roleOf(skill)}>
										<span>{skill}</span>
										<span className="bar">
											<i style={{ width: `${(xp / skills[0]![1]) * 100}%` }} />
										</span>
										<span className="num">{formatXp(xp / HOLD_HOURS)}</span>
									</li>
								))}
							</ul>
						</figure>
					</>
				)}
			</aside>
		</div>
	);
});
