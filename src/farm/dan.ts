/**
 * 4K Dan estimation (from Dan Estimator Overlay) + accuracy-based Dan credit
 * (from mania-tracker.com/dan-estimates, 4K regular 96% pass bar).
 */

const SR_CURVE: readonly [number, number][] = [
	[2.4, 1.10], [2.8, 1.69], [3.2, 2.30], [3.6, 2.98], [4.0, 3.76], [4.4, 4.63], [4.8, 5.58], [5.2, 6.64],
	[5.6, 7.86], [6.0, 9.21], [6.4, 10.56], [6.8, 11.81], [7.2, 12.86], [7.6, 13.61], [8.0, 14.04], [8.4, 14.37],
	[8.8, 14.84], [9.2, 15.42], [9.6, 16.04], [10.0, 16.67], [10.4, 17.32], [10.8, 17.97],
];

const HIGH_DAN_SCALE: readonly [number, number][] = [
	[17, 17],
	[17.95, 18.20],
	[18.65, 18.15],
	[19.65, 19.27],
	[21.00, 19.95],
	[21.60, 20.40],
	[23.00, 20.55],
	[25.00, 21.15],
	[30.00, 21.20],
	[35.00, 21.25],
	[40.00, 21.25],
	[80.00, 21.30],
	[200.00, 21.35],
	[800.00, 21.51],
	[1500.00, 0],
];

const OFFICIAL_NAMES = [
	'alpha', 'beta', 'gamma', 'delta',
	'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda',
] as const;

export const DAN_LABELS = [
	'1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th',
	'Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa', 'Lambda',
] as const;

/** Official Reform Dan course detection from map title. */
export const officialDan = (title?: string): number | undefined => {
	const t = String(title || '');
	if (!/dan\s*~\s*reform\s*~/i.test(t)) return undefined;
	const m = /^.*?dan\s*~\s*reform\s*~\s*(.+?)\s*$/i.exec(t);
	if (!m) return undefined;
	const name = m[1]!.trim().toLowerCase();
	let n = /^(\d{1,2})(?:st|nd|rd|th)\b/.exec(name);
	if (n) {
		const dan = Number(n[1]);
		return dan >= 1 && dan <= 10 ? dan : undefined;
	}
	n = /^(?:(?:extra|final)[\s-]*)?(alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda)\b/.exec(name);
	if (!n) return undefined;
	const idx = OFFICIAL_NAMES.indexOf(n[1] as typeof OFFICIAL_NAMES[number]);
	return idx >= 0 ? 11 + idx : undefined;
};

const danFromSRRaw = (sr: number): number => {
	const c = SR_CURVE;
	const n = c.length;
	if (sr <= c[0]![0]) return c[0]![1] + ((c[1]![1] - c[0]![1]) / (c[1]![0] - c[0]![0])) * (sr - c[0]![0]);
	if (sr >= c[n - 1]![0]) return c[n - 1]![1] + ((c[n - 1]![1] - c[n - 2]![1]) / (c[n - 1]![0] - c[n - 2]![0])) * (sr - c[n - 1]![0]);
	for (let i = 1; i < n; i++) {
		if (sr <= c[i]![0]) return c[i - 1]![1] + ((c[i]![1] - c[i - 1]![1]) * (sr - c[i - 1]![0])) / (c[i]![0] - c[i - 1]![0]);
	}
	return 0;
};

const highDan = (d: number): number => {
	const s = HIGH_DAN_SCALE;
	const n = s.length;
	if (!(d > s[0]![0])) return d;
	let i = 1;
	while (i < n - 1 && d > s[i]![0]) i++;
	return s[i - 1]![1] + ((d - s[i - 1]![0]) * (s[i]![1] - s[i - 1]![1])) / (s[i]![0] - s[i - 1]![0]);
};

/** Estimated 4K Reform Dan level from star rating (at the played rate). */
export const danFromSR = (sr: number): number => (sr > 0 ? Math.max(0, highDan(danFromSRRaw(sr))) : 0);

/** Estimated 4K Dan level for a chart at a given star rating (official Reform courses override SR). */
export const chartDan = (sr: number, title?: string): number => officialDan(title) ?? danFromSR(sr);

/**
 * Mania Tracker 4K regular accuracy credit table (96% pass bar).
 * Below 91% earns no credit.
 */
const CREDIT_CURVE: readonly [number, number][] = [
	[0.91, -1.50],
	[0.92, -1.25],
	[0.94, -0.76],
	[0.95, -0.51],
	[0.955, -0.25],
	[0.96, 0.0],
	[0.97, 0.0],
	[0.975, 0.06],
	[0.98, 0.12],
	[0.987, 0.20],
	[0.99, 0.70],
	[0.995, 1.10],
	[1.00, 1.50],
];

/** Dan level offset earned for a given accuracy (0..1), or undefined when below 91%. */
export const danAccuracyBonus = (accuracy: number): number | undefined => {
	if (accuracy < CREDIT_CURVE[0]![0]) return undefined;
	if (accuracy >= 1) return CREDIT_CURVE.at(-1)![1];
	for (let i = 1; i < CREDIT_CURVE.length; i++) {
		const [a1, v1] = CREDIT_CURVE[i]!;
		if (accuracy <= a1) {
			const [a0, v0] = CREDIT_CURVE[i - 1]!;
			return v0 + ((v1 - v0) * (accuracy - a0)) / (a1 - a0);
		}
	}
	return 0;
};

/** Credited Dan level of a play, using Mania Tracker's 96% bar. Fails or <91% acc earn 0. */
export const danCredit = (chartDanLevel: number, accuracy: number, failRate = 0): number => {
	if (failRate >= 1 || chartDanLevel <= 0) return 0;
	const bonus = danAccuracyBonus(accuracy);
	if (bonus === undefined) return 0;
	return Math.max(0, chartDanLevel + bonus);
};

/** Format a numeric Dan level with 5-step sub-tier signs (--, -, '', +, ++). */
export const formatDan = (d: number): string => {
	if (!Number.isFinite(d) || d <= 0) return '—';
	const clamped = Math.min(DAN_LABELS.length + 0.49, Math.max(0.51, d));
	const tier = Math.max(1, Math.min(DAN_LABELS.length, Math.round(clamped)));
	const offset = clamped - tier; // -0.5 .. +0.5
	const sign = offset < -0.3 ? '--' : offset < -0.1 ? '-' : offset > 0.3 ? '++' : offset > 0.1 ? '+' : '';
	return `${DAN_LABELS[tier - 1]}${sign}`;
};
