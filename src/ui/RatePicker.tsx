import {
	useEffect,
	useRef,
	useState,
	type PointerEvent,
} from 'react';
import {
	MAX_RATE,
	MIN_RATE,
	rateLabel,
} from '@oss-idle/shared/rate';

/** A bar's height as a share of the ruler: taller is faster. */
const height = (rate: number) => 0.25 + 0.75 * (rate - MIN_RATE) / (MAX_RATE - MIN_RATE);

const tone = (rate: number) => (rate < 1 ? 'slow' : 'fast');

/** Label the ends, x1 and the hovered rate, unless a label would crowd the hovered one. */
const labelled = (steps: number[], index: number, hovered: number | undefined) => {
	const rate = steps[index]!;
	if (rate === hovered) return true;
	const landmark = index === 0 || index === steps.length - 1 || rate === 1;
	return landmark && (hovered === undefined || Math.abs(steps.indexOf(hovered) - index) > 2);
};

/**
 * Which unlocked rates to simulate, as a ruler of bars: click or drag across
 * them to pick a range.
 *
 * Holds the rates left *out*, so a rate the character unlocks later is picked
 * without anyone ticking it.
 */
export default function RatePicker({
	steps,
	excluded,
	onChange,
}: {
	/** Every rate the character has unlocked, slowest first. */
	steps: number[];
	excluded: number[];
	onChange: (excluded: number[]) => void;
}) {
	const [open, setOpen] = useState(false);
	const [hovered, setHovered] = useState<number | undefined>(undefined);
	const root = useRef<HTMLDivElement>(null);
	const ruler = useRef<HTMLDivElement>(null);
	/** While dragging: whether the bars passed over get picked or dropped. */
	const paint = useRef<boolean | undefined>(undefined);

	const isPicked = (rate: number) => !excluded.includes(rate);
	const picked = steps.filter(isPicked);

	const set = (rate: number, on: boolean) => {
		if (isPicked(rate) === on) return;
		onChange(on ? excluded.filter(other => other !== rate) : [...excluded, rate]);
	};

	useEffect(() => {
		if (!open) return;
		const away = (e: Event) => {
			if (root.current && !e.composedPath().includes(root.current)) setOpen(false);
		};
		const escape = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
		window.addEventListener('pointerdown', away);
		window.addEventListener('keydown', escape);
		return () => {
			window.removeEventListener('pointerdown', away);
			window.removeEventListener('keydown', escape);
		};
	}, [open]);

	/** The step under the pointer, from its position along the ruler. */
	const stepAt = (e: PointerEvent) => {
		const box = ruler.current!.getBoundingClientRect();
		const index = Math.floor(((e.clientX - box.left) / box.width) * steps.length);
		return steps[Math.max(0, Math.min(steps.length - 1, index))]!;
	};

	const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
		e.currentTarget.setPointerCapture(e.pointerId);
		const rate = stepAt(e);
		paint.current = !isPicked(rate);
		set(rate, paint.current);
	};

	const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
		const rate = stepAt(e);
		setHovered(rate);
		if (paint.current !== undefined) set(rate, paint.current);
	};

	const presets: [string, number[]][] = [
		['All', []],
		['x1 and faster', steps.filter(rate => rate < 1)],
		['None', steps],
	];

	return (
		<div className="rates" ref={root}>
			<button
				className="rates-trigger"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
			>
				<span className="mini" aria-hidden>
					{steps.map(rate => (
						<i
							key={rate}
							className={isPicked(rate) ? tone(rate) : undefined}
							style={{ height: `${height(rate) * 100}%` }}
						/>
					))}
				</span>
				{picked.length === steps.length ? 'All rates' : `${picked.length} of ${steps.length}`}
			</button>

			{open && (
				<div className="rates-menu">
					<div
						className="ruler"
						ref={ruler}
						onPointerDown={onPointerDown}
						onPointerMove={onPointerMove}
						onPointerUp={() => { paint.current = undefined; }}
						onPointerCancel={() => { paint.current = undefined; }}
						onPointerLeave={() => setHovered(undefined)}
					>
						{steps.map(rate => (
							<button
								key={rate}
								className={[
									'bar',
									isPicked(rate) ? tone(rate) : '',
									rate === hovered ? 'hover' : '',
								].join(' ')}
								aria-pressed={isPicked(rate)}
								aria-label={rateLabel(rate)}
								// the ruler handles pointer picks; this is for the keyboard
								onClick={e => e.detail === 0 && set(rate, !isPicked(rate))}
							>
								<span style={{ height: `${height(rate) * 100}%` }} />
							</button>
						))}
					</div>

					<div className="scale" aria-hidden>
						{steps.map((rate, index) => (
							<span key={rate} className={rate === hovered ? 'readout' : undefined}>
								{labelled(steps, index, hovered) ? rateLabel(rate) : ''}
							</span>
						))}
					</div>

					<div className="presets">
						{presets.map(([label, out]) => (
							<button key={label} onClick={() => onChange(out)}>{label}</button>
						))}
						<span className="legend"><i className="slow" />slower, less score</span>
					</div>
				</div>
			)}
		</div>
	);
}
