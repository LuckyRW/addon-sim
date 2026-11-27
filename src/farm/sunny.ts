/**
 * Sunny Star Rating (4K/nK mania) — exact port of Dan Estimator Overlay's `sunnySR`.
 * Parses `[HitObjects]` from raw `.osu` text and computes Sunny SR at any rate.
 */

export type SunnyNote = {
	column: number;
	time: number;
	isLn: boolean;
};

export type ParsedChart = {
	notes: SunnyNote[];
	lnRatio: number;
	od: number;
};

/** Parse 4K mania hit objects and OD from raw `.osu` file text. */
export const parseOsuNotes = (osuText: string, keys = 4): ParsedChart => {
	const lines = osuText.split(/\r?\n/);
	let section = '';
	let od = 9;
	const notes: SunnyNote[] = [];
	let lnCount = 0;

	for (const raw of lines) {
		const line = raw.trim();
		if (!line || line.startsWith('//')) continue;
		if (line.startsWith('[') && line.endsWith(']')) {
			section = line.slice(1, -1);
			continue;
		}
		if (section === 'Difficulty' && line.startsWith('OverallDifficulty:')) {
			const v = Number(line.slice('OverallDifficulty:'.length).trim());
			if (Number.isFinite(v)) od = v;
		} else if (section === 'HitObjects') {
			const parts = line.split(',');
			if (parts.length < 4) continue;
			const x = Number(parts[0]);
			const time = Number(parts[2]);
			const type = Number(parts[3]);
			if (!Number.isFinite(x) || !Number.isFinite(time)) continue;
			const column = Math.max(0, Math.min(keys - 1, Math.floor((x * keys) / 512)));
			const isLn = (type & 128) !== 0;
			if (isLn) lnCount++;
			notes.push({ column, time, isLn });
		}
	}

	return {
		notes,
		lnRatio: notes.length ? lnCount / notes.length : 0,
		od,
	};
};

const SR_CROSS: readonly (readonly number[])[] = [
	[-1],
	[0.075, 0.075],
	[0.125, 0.05, 0.125],
	[0.125, 0.125, 0.125, 0.125],
	[0.175, 0.25, 0.05, 0.25, 0.175],
	[0.175, 0.25, 0.175, 0.175, 0.25, 0.175],
	[0.225, 0.35, 0.25, 0.05, 0.25, 0.35, 0.225],
	[0.225, 0.35, 0.25, 0.225, 0.225, 0.25, 0.35, 0.225],
	[0.275, 0.45, 0.35, 0.25, 0.05, 0.25, 0.35, 0.45, 0.275],
	[0.275, 0.45, 0.35, 0.25, 0.275, 0.275, 0.25, 0.35, 0.45, 0.275],
	[0.325, 0.55, 0.45, 0.35, 0.25, 0.05, 0.25, 0.35, 0.45, 0.55, 0.325],
];

const srLeft = (a: Float64Array, v: number): number => {
	let lo = 0, hi = a.length;
	while (lo < hi) { const m = (lo + hi) >> 1; if (a[m]! < v) lo = m + 1; else hi = m; }
	return lo;
};

const srRight = (a: Float64Array, v: number): number => {
	let lo = 0, hi = a.length;
	while (lo < hi) { const m = (lo + hi) >> 1; if (a[m]! <= v) lo = m + 1; else hi = m; }
	return lo;
};

const srClip = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

const srInterp = (newX: Float64Array, oldX: Float64Array, oldV: Float64Array): Float64Array => {
	const n = oldX.length, out = new Float64Array(newX.length);
	for (let i = 0; i < newX.length; i++) {
		const q = newX[i]!;
		if (q <= oldX[0]!) { out[i] = oldV[0]!; continue; }
		if (q >= oldX[n - 1]!) { out[i] = oldV[n - 1]!; continue; }
		const j = srRight(oldX, q) - 1;
		const dx = oldX[j + 1]! - oldX[j]!;
		out[i] = dx === 0 ? oldV[j]! : oldV[j]! + (oldV[j + 1]! - oldV[j]!) * (q - oldX[j]!) / dx;
	}
	return out;
};

const srStepInterp = (newX: Float64Array, oldX: Float64Array, oldV: Float64Array): Float64Array => {
	const out = new Float64Array(newX.length);
	for (let i = 0; i < newX.length; i++) out[i] = oldV[srClip(srRight(oldX, newX[i]!) - 1, 0, oldV.length - 1)]!;
	return out;
};

const srSmooth = (x: Float64Array, f: Float64Array, windowMs: number, scale: number, mode: 'avg' | 'sum'): Float64Array => {
	const n = x.length, F = new Float64Array(n);
	for (let i = 1; i < n; i++) F[i] = F[i - 1]! + f[i - 1]! * (x[i]! - x[i - 1]!);
	const q = (v: number) => {
		const idx = srClip(srLeft(x, v) - 1, 0, n - 2);
		return F[idx]! + f[idx]! * (v - x[idx]!);
	};
	const out = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		const a = srClip(x[i]! - windowMs, x[0]!, x[n - 1]!);
		const b = srClip(x[i]! + windowMs, x[0]!, x[n - 1]!);
		const val = q(b) - q(a);
		out[i] = mode === 'avg' ? (b - a > 0 ? val / (b - a) : 0) : scale * val;
	}
	return out;
};

const srTime = (h: number, rate: number): number => {
	const r = Math.round(rate * 1000) / 1000;
	if (r === 1) return h;
	if (r === 1.5) return Math.floor((h * 2) / 3);
	if (r === 0.75) return Math.floor((h * 4) / 3);
	const v = h / rate, f = Math.floor(v), d = v - f;
	return d < 0.5 ? f : d > 0.5 ? f + 1 : (f % 2 === 0 ? f : f + 1);
};

/** Compute Sunny Star Rating for a chart's notes at `rate`. */
export const sunnySR = (notes: readonly SunnyNote[], keys = 4, rate = 1, od = 9): number | null => {
	const K = keys;
	const cc = SR_CROSS[K];
	if (!cc || !notes || notes.length < 2) return null;
	rate = rate > 0 ? rate : 1;
	const seq: [number, number][] = notes.map(n => [n.column, srTime(Math.round(n.time), rate)]);
	seq.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
	let x = 0.3 * Math.sqrt((64.5 - Math.ceil(od * 3)) / 500);
	x = Math.min(x, 0.6 * (x - 0.09) + 0.09);
	const byCol: [number, number][][] = Array.from({ length: K }, () => []);
	for (const n of seq) if (n[0] >= 0 && n[0] < K) byCol[n[0]]!.push(n);
	let T = 0;
	for (const n of seq) if (n[1] > T) T = n[1];
	T += 1;
	const N = seq.length;
	const sb = new Set([0, T]), sa = new Set([0, T]);
	for (const [, h] of seq) {
		for (const v of [h, h + 501, h - 499, h + 1]) if (v >= 0 && v <= T) sb.add(v);
		for (const v of [h, h + 1000, h - 1000]) if (v >= 0 && v <= T) sa.add(v);
	}
	const bc = Float64Array.from([...sb].sort((a, b) => a - b));
	const ac = Float64Array.from([...sa].sort((a, b) => a - b));
	const all = Float64Array.from(new Set([...bc, ...ac])).sort();
	const nb = bc.length;
	const usage = Array.from({ length: K }, () => new Uint8Array(nb));
	for (let k = 0; k < K; k++) {
		for (const n of byCol[k]!) {
			const li = srLeft(bc, Math.max(n[1] - 150, 0));
			const ri = srLeft(bc, Math.min(n[1] + 150, T - 1));
			for (let i = li; i < ri; i++) usage[k]![i] = 1;
		}
	}
	const usage400 = Array.from({ length: K }, () => new Float64Array(nb));
	const inv = 3.75 / 160000;
	for (let k = 0; k < K; k++) {
		const arr = usage400[k]!;
		for (const n of byCol[k]!) {
			const h = Math.max(n[1], 0);
			const li = srLeft(bc, h - 400), ri = srLeft(bc, h + 400), mid = srLeft(bc, h);
			arr[mid]! += 3.75;
			for (let i = li; i < mid; i++) { const d = bc[i]! - h; arr[i]! += 3.75 - inv * d * d; }
			for (let i = mid + 1; i < ri; i++) { const d = bc[i]! - h; arr[i]! += 3.75 - inv * d * d; }
		}
	}
	const active = (c: number, i: number) => c >= 0 && c < K && usage[c]![i] === 1;
	const activeCols = (i: number) => { const r: number[] = []; for (let c = 0; c < K; c++) if (usage[c]![i]) r.push(c); return r; };
	const anchor = new Float64Array(nb);
	{
		const row = new Float64Array(K);
		for (let i = 0; i < nb; i++) {
			for (let k = 0; k < K; k++) row[k] = usage400[k]![i]!;
			row.sort(); row.reverse();
			let nz = 0, walk = 0, maxWalk = 0;
			for (let k = 0; k < K; k++) if (row[k]! > 0) nz++;
			for (let k = 0; k < K - 1; k++) {
				const c0 = row[k]!, c1 = row[k + 1]!;
				if (c0 > 0 && c1 > 0) {
					const ratio = c1 / c0;
					walk += c0 * (1 - 4 * (0.5 - ratio) * (0.5 - ratio));
					maxWalk += c0;
				}
			}
			const raw = nz > 1 ? walk / Math.max(maxWalk, 1e-9) : 0;
			anchor[i] = 1 + Math.min(raw - 0.18, 5 * Math.pow(raw - 0.22, 3));
		}
	}
	const nerf = (d: number) => 1 - 7e-5 * Math.pow(0.15 + Math.abs(d - 0.08), -4);
	const J = Array.from({ length: K }, () => new Float64Array(nb));
	const dK = Array.from({ length: K }, () => new Float64Array(nb).fill(1e9));
	for (let k = 0; k < K; k++) {
		const c = byCol[k]!;
		for (let i = 0; i + 1 < c.length; i++) {
			const s = c[i]![1], e = c[i + 1]![1];
			const d = 0.001 * (e - s);
			const v = (1 / d) * (1 / (d + 0.11 * Math.pow(x, 0.25))) * nerf(d);
			const li = srLeft(bc, s), ri = srLeft(bc, e);
			if (ri > li) for (let j = li; j < ri; j++) { J[k]![j] = v; dK[k]![j] = d; }
		}
	}
	const Jk = J.map(a => srSmooth(bc, a, 500, 0.001, 'sum'));
	const Jbar0 = new Float64Array(nb);
	for (let i = 0; i < nb; i++) {
		let num = 0, den = 0;
		for (let k = 0; k < K; k++) {
			const w = 1 / dK[k]![i]!;
			num += Math.pow(Math.max(Jk[k]![i]!, 0), 5) * w;
			den += w;
		}
		Jbar0[i] = Math.pow(num / Math.max(den, 1e-9), 0.2);
	}
	const Xk = Array.from({ length: K + 1 }, () => new Float64Array(nb));
	const fast = Array.from({ length: K + 1 }, () => new Float64Array(nb));
	for (let k = 0; k <= K; k++) {
		let pair: [number, number][];
		if (k === 0) pair = byCol[0]!;
		else if (k === K) pair = byCol[K - 1]!;
		else pair = byCol[k - 1]!.concat(byCol[k]!).sort((a, b) => a[1] - b[1]);
		if (pair.length < 2) continue;
		for (let i = 0; i + 1 < pair.length; i++) {
			const s = pair[i]![1], e = pair[i + 1]![1];
			const d = 0.001 * (e - s);
			let val = 0.16 * Math.pow(Math.max(x, d), -2);
			const fc = Math.max(0, 0.4 * Math.pow(Math.max(d, Math.max(0.06, 0.75 * x)), -2) - 80);
			const li = srLeft(bc, s), ri = srLeft(bc, e);
			if (ri <= li) continue;
			const leftInactive = !active(k - 1, li) && !active(k - 1, ri);
			const rightInactive = !active(k, li) && !active(k, ri);
			if (leftInactive || rightInactive) val *= 1 - cc[k]!;
			for (let j = li; j < ri; j++) { Xk[k]![j] = val; fast[k]![j] = fc; }
		}
	}
	const Xbase = new Float64Array(nb);
	for (let i = 0; i < nb; i++) {
		let s = 0;
		for (let k = 0; k <= K; k++) s += Xk[k]![i]! * cc[k]!;
		for (let k = 0; k < K; k++) s += Math.sqrt(fast[k]![i]! * cc[k]! * fast[k + 1]![i]! * cc[k + 1]!);
		Xbase[i] = s;
	}
	const Xbar0 = srSmooth(bc, Xbase, 500, 0.001, 'sum');
	const booster = (d: number) => {
		const bpm = srClip(7.5 / d, 0, 420);
		const primary = 0.10 / (1 + Math.exp(-0.06 * (bpm - 175)));
		const secondary = bpm >= 200 && bpm <= 350 ? 0.30 * (1 - Math.exp(-0.02 * (bpm - 200))) : 0;
		return 1 + primary + secondary;
	};
	const P = new Float64Array(nb);
	{
		const baseInc = Math.pow((0.08 / x) * (1 - (24 / x) * (x / 6) * (x / 6)), 0.25);
		const spike = 1000 * Math.pow(0.02 * (4 / x - 24), 0.25);
		for (let i = 0; i + 1 < N; i++) {
			const hl = seq[i]![1], hr = seq[i + 1]![1], dt = hr - hl;
			const li = srLeft(bc, hl);
			if (dt < 1e-9) {
				const rs = srRight(bc, hl);
				if (rs > li) for (let j = li; j < rs; j++) P[j]! += spike;
				continue;
			}
			const ri = srLeft(bc, hr);
			if (ri <= li) continue;
			const d = 0.001 * dt;
			const b = Math.max(booster(d), 1);
			const inc = d < (2 * x) / 3
				? (1 / d) * Math.pow((0.08 / x) * (1 - (24 / x) * (d - x / 2) * (d - x / 2)), 0.25) * b
				: (1 / d) * baseInc * b;
			const alt = Math.max(inc, inc * 2 - 10);
			for (let j = li; j < ri; j++) P[j]! += Math.min(inc * anchor[j]!, alt);
		}
	}
	const Pbar0 = srSmooth(bc, P, 500, 0.001, 'sum');
	const dks = Array.from({ length: Math.max(K - 1, 1) }, () => new Float64Array(nb));
	for (let i = 0; i < nb; i++) {
		const cols = activeCols(i);
		for (let j = 0; j + 1 < cols.length; j++) {
			const k0 = cols[j]!, k1 = cols[j + 1]!;
			dks[k0]![i] = Math.abs(dK[k0]![i]! - dK[k1]![i]!) + 0.4 * Math.max(0, Math.max(dK[k0]![i]!, dK[k1]![i]!) - 0.11);
		}
	}
	const A = new Float64Array(ac.length).fill(1);
	for (let i = 0; i < ac.length; i++) {
		const idx = srClip(srLeft(bc, ac[i]!), 0, nb - 1);
		const cols = activeCols(idx);
		for (let j = 0; j + 1 < cols.length; j++) {
			const k0 = cols[j]!, k1 = cols[j + 1]!;
			const dv = dks[k0]![idx]!, a0 = dK[k0]![idx]!, a1 = dK[k1]![idx]!;
			if (dv < 0.02) A[i]! *= Math.min(0.75 + 0.5 * Math.max(a0, a1), 1);
			else if (dv < 0.07) A[i]! *= Math.min(0.65 + 5 * dv + 0.5 * Math.max(a0, a1), 1);
		}
	}
	const Abar0 = srSmooth(ac, A, 250, 1, 'avg');
	const times = Float64Array.from(seq.map(n => n[1])).sort();
	const Cstep = new Float64Array(nb), Ksstep = new Float64Array(nb);
	for (let i = 0; i < nb; i++) {
		Cstep[i] = srLeft(times, bc[i]! + 500) - srLeft(times, bc[i]! - 500);
		let c = 0;
		for (let k = 0; k < K; k++) c += usage[k]![i]!;
		Ksstep[i] = Math.max(c, 1);
	}
	const Jbar = srInterp(all, bc, Jbar0), Xbar = srInterp(all, bc, Xbar0), Pbar = srInterp(all, bc, Pbar0);
	const Abar = srInterp(all, ac, Abar0);
	const C = srStepInterp(all, bc, Cstep), Ks = srStepInterp(all, bc, Ksstep);
	const M = all.length, D = new Float64Array(M);
	for (let i = 0; i < M; i++) {
		const a3 = Math.pow(Abar[i]!, 3 / Ks[i]!);
		const S = Math.pow(
			0.4 * Math.pow(a3 * Math.min(Jbar[i]!, 8 + 0.85 * Jbar[i]!), 1.5) +
			0.6 * Math.pow(Math.pow(Abar[i]!, 2 / 3) * (0.8 * Pbar[i]!), 1.5),
			2 / 3,
		);
		const Tt = (a3 * Xbar[i]!) / (Xbar[i]! + S + 1);
		D[i] = 2.7 * Math.sqrt(S) * Math.pow(Tt, 1.5) + S * 0.27;
	}
	const w = new Float64Array(M);
	for (let i = 0; i < M; i++) {
		const gap = i === 0 ? (all[1]! - all[0]!) / 2 : i === M - 1 ? (all[M - 1]! - all[M - 2]!) / 2 : (all[i + 1]! - all[i - 1]!) / 2;
		w[i] = C[i]! * gap;
	}
	const order = Array.from({ length: M }, (_, i) => i).sort((a, b) => D[a]! - D[b]!);
	const Ds = new Float64Array(M), ws = new Float64Array(M), cum = new Float64Array(M);
	let acc = 0;
	for (let i = 0; i < M; i++) { Ds[i] = D[order[i]!]!; ws[i] = w[order[i]!]!; acc += ws[i]!; cum[i] = acc; }
	for (let i = 0; i < M; i++) cum[i]! /= acc;
	const pick = (t: number) => Ds[Math.min(srLeft(cum, t), M - 1)]!;
	const p93 = (pick(0.945) + pick(0.935) + pick(0.925) + pick(0.915)) / 4;
	const p83 = (pick(0.845) + pick(0.835) + pick(0.825) + pick(0.815)) / 4;
	let num = 0, den = 0;
	for (let i = 0; i < M; i++) { num += Math.pow(Ds[i]!, 5) * ws[i]!; den += ws[i]!; }
	const wmean = Math.pow(num / den, 0.2);
	let sr = 0.88 * p93 * 0.25 + 0.94 * p83 * 0.2 + wmean * 0.55;
	sr *= N / (N + 60);
	if (sr > 9) sr = 9 + (sr - 9) / 1.2;
	return sr * 0.975;
};
