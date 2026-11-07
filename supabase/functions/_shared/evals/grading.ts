// Graders for the evaluation suite. Pure (no I/O), so they are unit tested;
// the evals agent gathers the inputs and stores the scores.
import type { HeldOutNiche } from './held-out-niches.ts';

export interface Graded {
  id: string;
  value: number | null;
  range: [number, number] | null;
  pass: boolean;
  /** How far outside the range, as a share of the nearest bound (0 when inside). */
  miss: number;
}

/** Grade values against accepted ranges. A missing value fails. */
export function gradeRanges(items: { id: string; value: number | null; range: [number, number] | null }[]): Graded[] {
  return items.map(({ id, value, range }) => {
    if (value === null || !Number.isFinite(value) || !range) return { id, value, range, pass: false, miss: 1 };
    const [lo, hi] = range;
    if (value >= lo && value <= hi) return { id, value, range, pass: true, miss: 0 };
    const bound = value < lo ? lo : hi;
    return { id, value, range, pass: false, miss: Math.round((Math.abs(value - bound) / Math.max(Math.abs(bound), 1e-9)) * 1000) / 1000 };
  });
}

export function share(xs: boolean[]): number {
  return xs.length ? Math.round((xs.filter(Boolean).length / xs.length) * 1000) / 1000 : 0;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Which held-out formats the library covers: any phrase found in a niche's name, aliases or description. */
export function recall(heldOut: HeldOutNiche[], library: { name: string; aliases?: string[]; description?: string }[]) {
  const texts = library.map((n) => ` ${norm([n.name, ...(n.aliases ?? []), n.description ?? ''].join(' '))} `);
  const found = heldOut.map((h) => ({ name: h.name, covered: h.match.some((m) => texts.some((t) => t.includes(` ${norm(m)}`))) }));
  return { value: share(found.map((f) => f.covered)), found };
}

export interface BacktestPrediction {
  id: string;
  /** Actual annual revenue (USD). */
  actual: number;
  /** Predicted annual revenue at maturity (USD), P10/P50/P90. */
  predicted: { p10: number; p50: number; p90: number };
  /** Asking price ÷ annual SDE, when both are stated. */
  multiple?: number | null;
  /** The niche's SDE multiple range. */
  multipleRange?: { low: number; high: number } | null;
}

/**
 * Calibration: a trustworthy model's 80% range (P10–P90) contains about 80%
 * of real outcomes. Also the median absolute log error of the P50, and how
 * often stated sale multiples fall inside the niche's range.
 */
export function calibration(preds: BacktestPrediction[]) {
  const inside = preds.map((p) => p.actual >= p.predicted.p10 && p.actual <= p.predicted.p90);
  const logErr = preds
    .filter((p) => p.actual > 0 && p.predicted.p50 > 0)
    .map((p) => Math.abs(Math.log(p.predicted.p50 / p.actual)))
    .sort((a, b) => a - b);
  const medianLogError = logErr.length ? Math.round(logErr[Math.floor(logErr.length / 2)] * 1000) / 1000 : null;
  const withMultiple = preds.filter((p) => p.multiple && p.multipleRange);
  const multipleInside = withMultiple.map((p) => p.multiple! >= p.multipleRange!.low && p.multiple! <= p.multipleRange!.high);
  const above = preds.filter((p) => p.actual > p.predicted.p90).length;
  const below = preds.filter((p) => p.actual < p.predicted.p10).length;
  return {
    coverage: share(inside),
    medianLogError,
    multipleCoverage: withMultiple.length ? share(multipleInside) : null,
    /** More real outcomes above P90 than below P10 means the model is too pessimistic, and the reverse. */
    bias: above > below ? 'pessimistic' : below > above ? 'optimistic' : 'balanced',
    n: preds.length,
  };
}
