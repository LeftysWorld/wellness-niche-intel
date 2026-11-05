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
