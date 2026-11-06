import { useEffect, useRef, useState } from 'react';
import { playCountsSince, type CharacterRow } from '@oss-idle/addon-sdk';
import { rateLabel, rateSteps } from '@oss-idle/shared/rate';
import type { Mod } from '@oss-idle/shared/mods';
import { libraryIndex, type MapInfo, type Simulate } from '../engine/client.js';
import { sweepBottlenecks, tally, type BottleneckRow } from '../engine/bottleneck.js';
import { stateOf } from '../engine/samples.js';
import { peakMinutes } from '../farm/session.js';
import { NumberField, skillLabel } from './parts.js';

const STATUS: Record<BottleneckRow['status'], string> = {
	passed: 'passed first try',
	retried: 'passes on retry',
	levels: 'needs levels',
	'out of reach': 'out of reach',
	stopped: 'stopped',
};

/** Every downloaded map: which skill each one needs raised the most to pass, and how many maps each skill holds back. */
export default function BottleneckView({ character, simulate, busy }: {
	character?: CharacterRow;
	simulate: Simulate;
	/** A scan is running: both would share one rate limit. */
	busy: boolean;
}) {
	const [library, setLibrary] = useState<Map<number, MapInfo>>(new Map());
	const [rate, setRate] = useState(1);
	const [hardRock, setHardRock] = useState(false);
	const [retries, setRetries] = useState(10);
	const [share, setShare] = useState(10);
	const [runs, setRuns] = useState(6);
	const [minStars, setMinStars] = useState(0);
	const [rows, setRows] = useState<BottleneckRow[]>([]);
	const [running, setRunning] = useState<{ label: string; calls: number }>();
	const [note, setNote] = useState('');
	const stop = useRef(false);

	useEffect(() => { void libraryIndex().then(setLibrary); }, []);
	const steps = rateSteps(Number(character?.speedUpgrades) || 0);
	const maps = [...library.values()].filter(info => info.difficulty >= minStars).sort((a, b) => a.difficulty - b.difficulty);

	const run = async () => {
		if (!character) return;
		stop.current = false;
		setRows([]);
		setNote('');
		setRunning({ label: 'Starting', calls: 0 });
		try {
			const row = character as unknown as Record<string, unknown>;
			const plays = await playCountsSince(Number(character.id), Number(row.memoryResetAt) || 0);
			const out = await sweepBottlenecks({
				state: stateOf(row),
				mods: (hardRock ? ['HR'] : []) as Mod[],
				minutes: peakMinutes(Number(character.staminaUpgrades) || 0),
				runs,
				maps: maps.map(info => ({ beatmapId: info.beatmapId, rate })),
				mapPlays: id => plays[id] ?? 0,
				retries,
				share: share / 100,
			}, simulate, { onProgress: setRunning, cancelled: () => stop.current }, r => setRows(all => [...all, r]));
			setNote(`${out.error ? `Stopped by the sim API (${out.error}). ` : out.partial ? 'Stopped early. ' : ''}${out.rows.length} of ${maps.length} maps, ${out.calls.toLocaleString()} sim calls.`);
		} catch (e) {
			setNote(e instanceof Error ? e.message : String(e));
		}
		setRunning(undefined);
	};

	const counts = tally(rows);
	const total = counts.reduce((sum, [, n]) => sum + n, 0);

	return (
		<section className="maps target">
			<div className="target-form">
				<p className="hint">
					Plays every downloaded map once at your levels. A failed map is played again; if too few of those pass, it finds the least
					levels to pass it that often, and the skill that has to go up the most is that map&apos;s bottleneck.
				</p>
				<div className="target-row">
					<select aria-label="Rate" className="rate-filter" value={rate} onChange={e => setRate(Number(e.target.value))}>
						{steps.map(step => <option key={step} value={step}>{rateLabel(step)}</option>)}
					</select>
					<label className="check">
						<input type="checkbox" checked={hardRock} onChange={e => setHardRock(e.target.checked)} />
						<span>Hard Rock</span>
					</label>
					<label className="strain-filter" title="Plays again after a failed first play">
						Retries
						<NumberField aria-label="Retries after a fail" min={1} max={200} integer value={retries} onChange={setRetries} />
					</label>
					<label className="strain-filter" title="Share of the retries that have to pass; the least levels are searched to pass this often too">
						Pass rate
						<NumberField aria-label="Pass rate, percent" min={0.1} max={100} value={share} onChange={setShare} />%
					</label>
					<label className="strain-filter" title="Plays each set of levels is judged over in the least levels search">
						Plays each
						<NumberField aria-label="Plays per check" min={1} integer value={runs} onChange={setRuns} />
					</label>
					<label className="strain-filter" title="Skip maps below these stars">
						Stars at least
						<NumberField aria-label="Least stars" min={0} max={20} value={minStars} onChange={setMinStars} />
					</label>
					<span className="spacer" />
					{running
						? <button onClick={() => { stop.current = true; }}>Stop</button>
						: (
							<button className="primary" disabled={!character || busy || !maps.length} onClick={() => void run()}
								title={busy ? 'Waits for the scan to finish' : 'A least levels search can take hundreds of sim calls per map'}
							>Check {maps.length.toLocaleString()} maps</button>
						)}
				</div>
				{running && <p className="hint"><span className="spinner" aria-hidden />{running.label} · {running.calls} sim calls · {rows.length} of {maps.length} done</p>}
				{note && <p className="why">{note}</p>}
			</div>

			{counts.length > 0 && (
				<div className="rows">
					<div className="row target-row-levels head">
						<span>Bottleneck skill</span><span className="num">Maps</span><span className="num">Share</span><span />
					</div>
					{counts.map(([skill, n]) => (
						<div className="row target-row-levels" key={skill}>
							<span>{skillLabel(skill)}</span>
							<span className="num strong">{n}</span>
							<span className="num muted">{Math.round((n / total) * 100)}%</span>
							<span />
						</div>
					))}
					<div className="row target-row-levels">
						<span className="strong">Total</span><span className="num strong">{total}</span><span /><span />
					</div>
				</div>
			)}

			{rows.length > 0 && (
				<div className="rows target-hunt-rows">
					<div className="row target-hunt head">
						<span>Map</span><span className="num">Stars</span><span className="num">Result</span><span className="num">Retries passed</span><span className="num">Bottleneck</span><span />
					</div>
					{rows.map(row => {
						const info = library.get(row.beatmapId);
						return (
							<div className="row target-hunt" key={`${row.beatmapId}@${row.rate}`}>
								<span className="name">{info ? <>{info.artist} - {info.title} <span className="hint">[{info.version}]</span></> : row.beatmapId}</span>
								<span className="num">{info?.difficulty.toFixed(2)}</span>
								<span className="num">{STATUS[row.status]}{row.result?.partial ? ' *' : ''}</span>
								<span className="num muted">{row.retryShare === undefined ? '' : `${Math.round(row.retryShare * 100)}%`}</span>
								<span className="num strong">{row.skill ? `${skillLabel(row.skill)} +${row.ups}` : ''}</span>
								<span />
							</div>
						);
					})}
				</div>
			)}
		</section>
	);
}
