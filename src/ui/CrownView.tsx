import { useMemo, useRef, useState } from 'react';
import { playCountsSince, type CharacterRow } from '@oss-idle/addon-sdk';
import { boardTop, liveCatalog, type MapInfo, type Simulate } from '../engine/client.js';
import { findCrowns, type Crown, type CrownRow } from '../engine/crown.js';
import { stateOf } from '../engine/samples.js';
import { peakMinutes } from '../farm/session.js';
import { NumberField } from './parts.js';

type Show = 'wins' | 'close' | 'all';

const percent = (accuracy: number) => `${(accuracy * 100).toFixed(2)}%`;

/** Every live map at x1, no mods: which leaderboards the character would top. */
export default function CrownView({ character, simulate, busy }: {
	character?: CharacterRow;
	simulate: Simulate;
	/** A scan is running: both would share one rate limit. */
	busy: boolean;
}) {
	const [runs, setRuns] = useState(3);
	const [loved, setLoved] = useState(false);
	const [show, setShow] = useState<Show>('wins');
	const [maps, setMaps] = useState<Map<number, MapInfo>>(new Map());
	const [rows, setRows] = useState<CrownRow[]>([]);
	const [running, setRunning] = useState<{ done: number; total: number; calls: number }>();
	const [crown, setCrown] = useState<Crown>();
	const [error, setError] = useState('');
	const stop = useRef(false);

	const run = async () => {
		if (!character) return;
		stop.current = false;
		setError('');
		setCrown(undefined);
		setRows([]);
		setRunning({ done: 0, total: 0, calls: 0 });
		try {
			const row = character as unknown as Record<string, unknown>;
			const [plays, catalog] = await Promise.all([
				playCountsSince(Number(character.id), Number(row.memoryResetAt) || 0),
				liveCatalog(),
			]);
			if (!catalog) throw new Error('Could not read the live maps from the server.');
			const listed = catalog.filter(info => loved || !info.loved);
			setMaps(new Map(listed.map(info => [info.beatmapId, info])));
			setRunning({ done: 0, total: listed.length, calls: 0 });
			setCrown(await findCrowns({
				state: stateOf(row),
				characterId: Number(character.id),
				beatmapIds: listed.map(info => info.beatmapId),
				runs,
				minutes: peakMinutes(Number(character.staminaUpgrades) || 0),
				mapPlays: id => plays[id] ?? 0,
			}, simulate, boardTop, {
				onProgress: progress => {
					setRunning({ done: progress.done, total: progress.total, calls: progress.calls });
					if (progress.rows.length) setRows(rows => [...rows, ...progress.rows]);
				},
				cancelled: () => stop.current,
			}));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
		setRunning(undefined);
	};

	const counts = useMemo(() => ({
		sure: rows.filter(row => !row.yours && row.runs > 0 && row.wins === row.runs).length,
		some: rows.filter(row => !row.yours && row.wins > 0 && row.wins < row.runs).length,
		yours: rows.filter(row => row.yours).length,
		empty: rows.filter(row => !row.top && row.wins > 0).length,
	}), [rows]);

	const listed = useMemo(() => {
		const shown = rows.filter(row => show === 'all' || (show === 'wins' ? row.wins > 0 && !row.yours : !row.yours && row.passes > 0 && row.wins === 0));
		// likeliest first, then by how far the best play gets past (or short of) the top
		const margin = (row: CrownRow) => (row.top ? row.bestScore - row.top.score + (row.bestAccuracy - row.top.accuracy) : Infinity);
		return shown.sort((a, b) => b.wins / (b.runs || 1) - a.wins / (a.runs || 1) || margin(b) - margin(a));
	}, [rows, show]);

	return (
		<section className="maps target">
			<div className="target-form">
				<p className="hint">
					Plays every live 4K map at x1 with no mods, at your warm-up peak, and checks each play against the map's #1.
					Plays rank as the game ranks them: score, then accuracy; a tie stays with whoever set it first.
				</p>
				<div className="target-row">
					<label className="strain-filter" title="Plays each map is simulated over: plays are random, so more shows how often you would take it">
						Plays each
						<NumberField aria-label="Plays per map" min={1} max={20} integer value={runs} onChange={setRuns} />
					</label>
					<label className="check">
						<input type="checkbox" checked={loved} onChange={e => setLoved(e.target.checked)} />
						<span>Include loved maps</span>
					</label>
					<span className="spacer" />
					{running
						? <button onClick={() => { stop.current = true; }}>Stop</button>
						: (
							<button className="primary" disabled={!character || busy} onClick={() => void run()}
								title={busy ? 'Waits for the scan to finish' : undefined}
							>Check every map</button>
						)}
				</div>
				{running && (
					<p className="hint">
						<span className="spinner" aria-hidden />
						{running.total ? `${running.done.toLocaleString()} of ${running.total.toLocaleString()} maps` : 'Reading the live maps'} · {running.calls.toLocaleString()} sim calls
					</p>
				)}
				{error && <p className="empty error">{error}</p>}
			</div>

			{rows.length > 0 && (
				<>
					<p className="why">
						{crown?.error ? `Stopped (${crown.error}). What it finished is below. ` : crown?.partial ? 'Stopped early: ' : ''}
						{`#1 in every play on ${counts.sure.toLocaleString()} maps, in some plays on ${counts.some.toLocaleString()} more`}
						{counts.empty ? ` (${counts.empty.toLocaleString()} of them have no scores yet)` : ''}
						{`. Already yours: ${counts.yours.toLocaleString()}. Out of ${rows.length.toLocaleString()} maps checked.`}
					</p>
					<div className="seg" role="group" aria-label="Show">
						<button className={show === 'wins' ? 'on' : ''} onClick={() => setShow('wins')}>Winnable</button>
						<button className={show === 'close' ? 'on' : ''} onClick={() => setShow('close')}>Passed, not #1</button>
						<button className={show === 'all' ? 'on' : ''} onClick={() => setShow('all')}>All</button>
					</div>
					<div className="rows">
						<div className="row crown head">
							<span>Map</span><span className="num">Stars</span><span className="num">#1 now</span><span className="num">Your best</span><span className="num">#1 in</span>
						</div>
						{listed.map(row => {
							const info = maps.get(row.beatmapId);
							return (
								<div className="row crown" key={row.beatmapId}>
									<span className="name">{info ? <>{info.artist} - {info.title} <span className="hint">[{info.version}]</span></> : row.beatmapId}</span>
									<span className="num">{info?.difficulty.toFixed(2)}</span>
									<span className="num muted" title={row.top ? `set at x${row.top.rate}` : undefined}>
										{row.yours ? 'yours' : row.top ? <>{row.top.score.toLocaleString()} <span className="hint">{percent(row.top.accuracy)}</span></> : 'no scores'}
									</span>
									<span className="num">
										{row.passes ? <>{row.bestScore.toLocaleString()} <span className="hint">{percent(row.bestAccuracy)}</span></> : 'fails'}
									</span>
									<span className="num strong" style={{ color: row.wins === row.runs ? '#4ade80' : row.wins ? '#fbbf24' : '#888' }}>
										{row.wins}/{row.runs}
									</span>
								</div>
							);
						})}
						{!listed.length && <p className="empty">None here yet.</p>}
					</div>
				</>
			)}
		</section>
	);
}
