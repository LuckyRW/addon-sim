/**
 * 4K Dan estimation (from Dan Estimator Overlay, using Sunny SR) + accuracy-based
 * Dan credit (from mania-tracker.com/dan-estimates, 4K regular 96% pass bar).
 */

import { parseOsuNotes, sunnySR, type ParsedChart } from './sunny.js';

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

const LN_LIMIT = 0.45;
const LN_CURVE = { a: -5.39, b: 2.85 };
const LN_HIGH_SCALE: readonly [number, number][] = [
	[13, 13],
	[14.02, 13.70],
	[14.65, 14.15],
	[15.22, 14.65],
	[16.04, 15.70],
	[17.04, 16.00],
	[19.20, 16.75],
];

const highLnDan = (d: number): number => {
	const s = LN_HIGH_SCALE;
	const n = s.length;
	if (!(d > s[0]![0])) return d;
	let i = 1;
	while (i < n - 1 && d > s[i]![0]) i++;
	return s[i - 1]![1] + ((d - s[i - 1]![0]) * (s[i]![1] - s[i - 1]![1])) / (s[i]![0] - s[i - 1]![0]);
};

/** Estimated 4K LN Dan level from Sunny SR. */
export const lnDanFromSR = (sr: number): number => (sr > 0 ? Math.max(0, highLnDan(LN_CURVE.a + LN_CURVE.b * sr)) : 0);

/** Estimated 4K Reform Dan level from star rating (at the played rate). */
export const danFromSR = (sr: number): number => (sr > 0 ? Math.max(0, highDan(danFromSRRaw(sr))) : 0);

/** Estimated 4K Dan level for a chart at a given star rating (official Reform courses override SR). */
export const chartDan = (sr: number, title?: string): number => officialDan(title) ?? danFromSR(sr);

export type DanOffsetRule = {
	t?: string | null;
	v?: string | null;
	rmin?: number | null;
	rmax?: number | null;
	off: number;
	scale?: number | null;
};

export type DanFixes = {
	offsets: CompiledOffset[];
	blocked: Set<number>;
};

type CompiledOffset = {
	tr: RegExp | null;
	vr: RegExp | null;
	rmin: number | null;
	rmax: number | null;
	off: number;
	scale: number | null;
	gen: boolean;
};

const RANK_API = 'https://dan-ranking.pickle97x.workers.dev';

const safeRe = (pattern: string): RegExp | null => {
	try { return new RegExp(pattern, 'i'); } catch { return null; }
};

export const compileDanFixes = (offsets: readonly DanOffsetRule[] = [], blocked: readonly number[] = []): DanFixes => {
	const compiled: CompiledOffset[] = [];
	for (const r of offsets) {
		if (!r || typeof r.off !== 'number' || !Number.isFinite(r.off)) continue;
		const tr = r.t ? safeRe(r.t) : null;
		const vr = r.v ? safeRe(r.v) : null;
		if ((r.t && !tr) || (r.v && !vr) || (!tr && !vr)) continue;
		compiled.push({
			tr,
			vr,
			rmin: r.rmin ?? null,
			rmax: r.rmax ?? null,
			off: r.off,
			scale: typeof r.scale === 'number' && r.scale > 0 ? r.scale : null,
			gen: r.rmin == null && r.rmax == null,
		});
	}
	return { offsets: compiled, blocked: new Set(blocked) };
};

/** Fetch the live Dan Overlay offset & blocked-map rules from `dan-ranking.pickle97x.workers.dev/fixes`. */
export const fetchDanFixes = async (): Promise<DanFixes> => {
	try {
		const res = await fetch(`${RANK_API}/fixes`, { cache: 'no-store' });
		if (!res.ok) return { offsets: [], blocked: new Set() };
		const json = await res.json() as { offsets?: DanOffsetRule[]; blocked?: number[] };
		return compileDanFixes(json.offsets, json.blocked);
	} catch {
		return { offsets: [], blocked: new Set() };
	}
};

const offMatch = (r: CompiledOffset, t: string, v: string) => (!r.tr || r.tr.test(t)) && (!r.vr || r.vr.test(v));

const offRateOk = (r: CompiledOffset, rate: number) =>
	rate >= (r.rmin ?? -Infinity) - 0.005 && rate <= (r.rmax ?? Infinity) + 0.005;

export const danOffset = (fixes: DanFixes | undefined, title: string, version: string, rate: number): number => {
	if (!fixes?.offsets.length) return 0;
	let generic: number | null = null;
	for (const r of fixes.offsets) {
		if (!offMatch(r, title, version)) continue;
		if (!r.gen) { if (offRateOk(r, rate)) return r.off; }
		else if (generic === null) generic = r.off;
	}
	return generic ?? 0;
};

export const danScale = (fixes: DanFixes | undefined, title: string, version: string): number => {
	if (!fixes?.offsets.length) return 1;
	for (const r of fixes.offsets) {
		if (r.scale !== null && offMatch(r, title, version)) return r.scale;
	}
	return 1;
};

/** Exact Sunny-SR Dan level from a parsed chart at `rate`, matching Dan Estimator Overlay (including live /fixes). */
export const sunnyChartDan = (
	parsed: ParsedChart,
	rate: number,
	title = '',
	version = '',
	fixes?: DanFixes,
): number | undefined => {
	if (Math.abs(rate - 1) < 0.005) {
		const off = officialDan(title);
		if (off !== undefined) return off;
	}
	const sr = sunnySR(parsed.notes, 4, rate, parsed.od);
	if (sr == null) return undefined;
	const fromSR = parsed.lnRatio >= LN_LIMIT ? lnDanFromSR : danFromSR;
	let d = fromSR(sr);
	const sc = danScale(fixes, title, version);
	if (sc !== 1 && Math.abs(rate - 1) >= 0.005) {
		const sr1 = sunnySR(parsed.notes, 4, 1, parsed.od);
		if (sr1 != null) {
			const d1 = fromSR(sr1);
			d = d1 + (d - d1) * sc;
		}
	}
	return Math.max(0, d + danOffset(fixes, title, version, rate));
};

export { parseOsuNotes, type ParsedChart };

/**
 * Read exact Sunny-SR Dan values cached by Dan Estimator Overlay (`dan-estimator:alt-maps:v1`).
 * Returns a map keyed by `${beatmapId}@${rate}` -> numeric Dan level.
 */
export const readDanOverlayCache = (): Record<string, number> => {
	const out: Record<string, number> = {};
	try {
		const raw = localStorage.getItem('dan-estimator:alt-maps:v1');
		if (!raw) return out;
		const data = JSON.parse(raw) as Record<string, { r?: Record<string, number>; d?: Record<string, number> }>;
		for (const [id, entry] of Object.entries(data)) {
			if (!entry) continue;
			const table = entry.r ?? entry.d;
			if (!table) continue;
			for (const [rk, val] of Object.entries(table)) {
				if (typeof val !== 'number' || !Number.isFinite(val)) continue;
				const rate = Math.round(Number(rk)) / 1000;
				if (rate > 0) out[`${id}@${rate}`] = Math.max(0, Math.min(40, val));
			}
		}
	} catch {
		// localStorage unavailable or malformed
	}
	return out;
};

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

/** Format a numeric Dan level with 5-step sub-tier signs (--, -, '', +, ++), matching Dan Estimator Overlay (floor-based: 14.0..14.99 = Delta). */
export const formatDan = (d: number): string => {
	if (!Number.isFinite(d) || d < 1) return '—';
	const tier = Math.max(1, Math.min(DAN_LABELS.length, Math.floor(d)));
	const frac = Math.max(0, Math.min(0.9999, d - tier));
	const sign = frac < 0.2 ? '--' : frac < 0.4 ? '-' : frac < 0.6 ? '' : frac < 0.8 ? '+' : '++';
	return `${DAN_LABELS[tier - 1]}${sign}`;
};
