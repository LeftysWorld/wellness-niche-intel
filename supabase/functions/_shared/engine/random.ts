import type { Percentiles, Tri } from './types.ts';

/** Seeded pseudo-random generator (mulberry32) so every run is reproducible. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draw from a triangular distribution defined by a three-point estimate. */
export function sampleTri(t: Tri, rng: () => number): number {
  const { low, mode, high } = normalizeTri(t);
  if (high === low) return mode;
  const u = rng();
  const c = (mode - low) / (high - low);
  return u < c
    ? low + Math.sqrt(u * (high - low) * (mode - low))
    : high - Math.sqrt((1 - u) * (high - low) * (high - mode));
}

/** Ensure low <= mode <= high, tolerating inputs entered in the wrong order. */
export function normalizeTri(t: Tri): Tri {
  const low = Math.min(t.low, t.high);
  const high = Math.max(t.low, t.high);
  const mode = Math.min(Math.max(t.mode, low), high);
  return { low, mode, high };
}

export function tri(low: number, mode: number, high: number): Tri {
  return { low, mode, high };
}

/** A point value expressed as a degenerate three-point estimate. */
export function point(v: number): Tri {
  return { low: v, mode: v, high: v };
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function percentiles(values: number[]): Percentiles {
  const s = [...values].sort((a, b) => a - b);
  return { p10: percentile(s, 0.1), p50: percentile(s, 0.5), p90: percentile(s, 0.9) };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Triangular draw from a given uniform u in (0,1), so draws can be correlated. */
export function triFromU(t: Tri, u: number): number {
  const { low, mode, high } = normalizeTri(t);
  if (high === low) return mode;
  const c = (mode - low) / (high - low);
  return u < c ? low + Math.sqrt(u * (high - low) * (mode - low)) : high - Math.sqrt((1 - u) * (high - low) * (high - mode));
}

/** Standard normal draw (Box-Muller). */
export function normal(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Standard normal cumulative distribution (Abramowitz-Stegun 7.1.26 via erf). */
export function normCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/**
 * Uniform draw that shares a common factor with other draws (Gaussian copula).
 * rho = 0 is independent; rho = 1 moves in lockstep with the common factor.
 */
export function correlatedU(common: number, rho: number, rng: () => number): number {
  const z = rho * common + Math.sqrt(1 - rho * rho) * normal(rng);
  return Math.min(1 - 1e-9, Math.max(1e-9, normCdf(z)));
}
