import { rateLabel } from '@osu-idle/shared/rate';

/**
 * Which unlocked rates to simulate.
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
	const picked = steps.filter(rate => !excluded.includes(rate));
	const summary = picked.length === steps.length
		? 'All'
		: picked.length === 0
			? 'None'
			: picked.length <= 3 ? picked.map(rateLabel).join(', ') : `${picked.length} rates`;

	return (
		<details className="rates">
			<summary>{summary}</summary>
			<div className="menu">
				<div className="all-none">
					<button onClick={() => onChange([])}>All</button>
					<button onClick={() => onChange(steps)}>None</button>
				</div>
				{steps.map(rate => (
					<label key={rate} className="check">
						<input
							type="checkbox"
							checked={!excluded.includes(rate)}
							onChange={e => onChange(e.target.checked
								? excluded.filter(other => other !== rate)
								: [...excluded, rate])}
						/>
						{rateLabel(rate)}
					</label>
				))}
			</div>
		</details>
	);
}
