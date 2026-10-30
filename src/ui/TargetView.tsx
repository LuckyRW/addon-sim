import { useEffect, useMemo, useRef, useState } from 'react';
import { playCountsSince, type CharacterRow } from '@oss-idle/addon-sdk';
import { rateLabel, rateSteps } from '@oss-idle/shared/rate';
import type { Mod } from '@oss-idle/shared/mods';
import { libraryIndex, type MapInfo, type Simulate } from '../engine/client.js';
import { findMinimum, PASS_SHARE, type Goal, type MinimumResult } from '../engine/minimum.js';
import { stateOf } from '../engine/samples.js';
import { peakMinutes } from '../farm/session.js';
import { NumberField } from './parts.js';

/** Maps the search box lists. */
const LISTED = 8;

/** The least levels a goal on a map takes, from the character's own. */
export default function TargetView({ character, simulate, busy }: {
	character?: CharacterRow;
	simulate: Simulate;
	/** A scan is running: both would share one rate limit. */
	busy: boolean;
}) {
	const [library, setLibrary] = useState<Map<number, MapInfo>>(new Map());
	const [query, setQuery] = useState('');
	const [map, setMap] = useState<MapInfo>();
	const [rate, setRate] = useState(1);
	const [hardRock, setHardRock] = useState(false);
	const [kind, setKind] = useState<Goal['kind']>('pass');
	const [accuracy, setAccuracy] = useState(95);
	const [runs, setRuns] = useState(6);
	const [running, setRunning] = useState<{ label: string; calls: number }>();
	const [result, setResult] = useState<MinimumResult>();
	const [error, setError] = useState('');
	const stop = useRef(false);

	useEffect(() => { void libraryIndex().then(setLibrary); }, []);

	const steps = rateSteps(Number(character?.speedUpgrades) || 0);
	const found = useMemo(() => {
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		if (!words.length) return [];
		const matches: MapInfo[] = [];
		for (const info of library.values()) {
			const text = `${info.artist} ${info.title} ${info.creator} ${info.version}`.toLowerCase();
			if (words.every(word => text.includes(word))) matches.push(info);
			if (matches.length >= LISTED) break;
		}
		return matches;
	}, [library, query]);

	const find = async () => {
		if (!map || !character) return;
		stop.current = false;
		setError('');
		setResult(undefined);
		setRunning({ label: 'Starting', calls: 0 });
		try {
			const row = character as unknown as Record<string, unknown>;
			const plays = await playCountsSince(Number(character.id), Number(row.memoryResetAt) || 0);
			setResult(await findMinimum({
				state: stateOf(row),
				beatmapId: map.beatmapId,
				rate,
				mods: (hardRock ? ['HR'] : []) as Mod[],
				minutes: peakMinutes(Number(character.staminaUpgrades) || 0),
				mapPlays: plays[map.beatmapId] ?? 0,
				goal: kind === 'pass' ? { kind } : { kind, accuracy: accuracy / 100 },
				runs,
			}, simulate, { onProgress: setRunning, cancelled: () => stop.current }));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
		setRunning(undefined);
	};

	const total = (levels: Record<string, number>) => Object.values(levels).reduce((sum, level) => sum + level, 0);

	return (
		<section className="maps target">
			<div className="target-form">
				<input
					type="search" aria-label="Search maps" placeholder="Search title, artist, mapper"
					value={query} onChange={e => setQuery(e.target.value)}
				/>
				{found.length > 0 && (
					<ul className="target-found">
						{found.map(info => (
							<li key={info.beatmapId}>
								<button onClick={() => { setMap(info); setQuery(''); setResult(undefined); }}>
									{info.artist} - {info.title} <span className="hint">[{info.version}]</span>
								</button>
							</li>
						))}
					</ul>
				)}
				<div className="target-map">
					{map ? <>{map.artist} - {map.title} <span className="hint">[{map.version}]</span></> : <span className="hint">Search for a map above</span>}
				</div>
				<div className="target-row">
					<select aria-label="Rate" className="rate-filter" value={rate} onChange={e => setRate(Number(e.target.value))}>
						{steps.map(step => <option key={step} value={step}>{rateLabel(step)}</option>)}
					</select>
					<label className="check">
						<input type="checkbox" checked={hardRock} onChange={e => setHardRock(e.target.checked)} />
						<span>Hard Rock</span>
					</label>
					<div className="seg" role="group" aria-label="Goal">
						<button className={kind === 'pass' ? 'on' : ''} onClick={() => setKind('pass')}>Pass</button>
						<button className={kind === 'accuracy' ? 'on' : ''} onClick={() => setKind('accuracy')}>Accuracy</button>
					</div>
					{kind === 'accuracy' && (
						<label className="strain-filter">
							<NumberField aria-label="Accuracy, percent" min={1} max={100} value={accuracy} onChange={setAccuracy} />%
						</label>
					)}
					<label className="strain-filter" title="Plays each set of levels is judged over: more is steadier, and asks the sim API more often">
						Plays each
						<NumberField aria-label="Plays per check" min={1} max={20} integer value={runs} onChange={setRuns} />
					</label>
					<span className="spacer" />
					{running
						? <button onClick={() => { stop.current = true; }}>Stop</button>
						: (
							<button className="primary" disabled={!map || !character || busy} onClick={() => void find()}
								title={busy ? 'Waits for the scan to finish' : undefined}
							>Find the least levels</button>
						)}
				</div>
				{running && <p className="hint"><span className="spinner" aria-hidden />{running.label} · {running.calls} sim calls</p>}
				{error && <p className="empty error">{error}</p>}
			</div>

			{result && !result.reachable && (
				<p className="why">Even every skill at level 150 does not meet this goal, at this rate.</p>
			)}
			{result?.reachable && (
				<>
					<p className="why">
						{result.partial
							? 'Stopped early: these levels are as far as it got, and may not be the least.'
							: result.alreadyMet
							? 'You can already do this. Below is the least it takes, each skill lowered with the others as they end up.'
							: 'What it takes from your levels. Other mixes of skills may meet the goal too; this one raises what helps most.'}
						{result.trial && ` At these levels: ${Math.round(result.trial.passShare * 100)}% of plays pass, ${(result.trial.accuracy * 100).toFixed(2)}% accuracy on average.`}
						{` A goal counts as met when ${Math.round(PASS_SHARE * 100)}% of plays pass. ${result.calls} sim calls.`}
					</p>
					<div className="rows">
						<div className="row target-row-levels head">
							<span>Skill</span><span className="num">You</span><span className="num">Needed</span><span className="num">Change</span>
						</div>
						{Object.keys(result.current).map(skill => {
							const change = result.levels[skill]! - result.current[skill]!;
							return (
								<div className="row target-row-levels" key={skill}>
									<span>{skill}</span>
									<span className="num muted">{result.current[skill]}</span>
									<span className="num strong">{result.levels[skill]}</span>
									<span className="num" style={{ color: change > 0 ? '#f43f5e' : change < 0 ? '#4ade80' : '#888' }}>
										{change > 0 ? `+${change}` : change || ''}
									</span>
								</div>
							);
						})}
						<div className="row target-row-levels">
							<span className="strong">Total</span>
							<span className="num muted">{total(result.current)}</span>
							<span className="num strong">{total(result.levels)}</span>
							<span className="num">{total(result.levels) - total(result.current) || ''}</span>
						</div>
					</div>
				</>
			)}
		</section>
	);
}
