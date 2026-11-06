// Plausibility guards for scouted values. Pure, so tests and the scout share them.
import { consensus, type Observation } from './consensus.ts';

/**
 * Plausible ranges per value. A scouted figure outside its range is a
 * different quantity (an annual figure read as monthly, a nightly rate read as
 * a lease, a professional wage) and is never written.
 */
export const PLAUSIBLE: Record<string, [number, number]> = {
  'labor.monthly_wage_usd': [150, 6000],
  'lease.finca_monthly_usd': [150, 15000],
  'lease.commercial_monthly_usd': [150, 20000],
  'lease.estate_monthly_usd': [300, 20000],
  'lease.land_monthly_usd_per_acre': [1, 2000],
  'land.price_per_acre_usd': [300, 2_000_000],
  'demand.population_40min': [3000, 15_000_000],
  'price.lodging_night_usd': [15, 2000],
  'build.cost_per_sqft_usd': [15, 800],
  'finance.rate_pct': [1, 35],
  'tax.revenue_pct': [0, 0.5],
  'tax.income_effective_pct': [0, 0.6],
};

/** Values whose figures are parts of a total (towns in a catchment): code adds them up. */
export const SUMMED_KEYS = new Set(['demand.population_40min']);

export function inRange(key: string, v: number) {
  const r = PLAUSIBLE[key];
  return !r || (v >= r[0] && v <= r[1]);
}

/**
 * A total made of parts: the largest confirmed figure per part, added up.
 * Confidence follows how many parts were confirmed and from how many sites.
 */
export function sumParts(observations: Observation[]): ReturnType<typeof consensus> {
  const confirmed = observations.filter((o) => o.confirmed && o.part);
  if (confirmed.length < 2) return null;
  const byPart = new Map<string, Observation>();
  for (const o of confirmed) if (!byPart.has(o.part!) || o.value > byPart.get(o.part!)!.value) byPart.set(o.part!, o);
  const kept = [...byPart.values()];
  const total = kept.reduce((a, o) => a + o.value, 0);
  const sites = new Set(kept.map((o) => new URL(o.url).host)).size;
  return {
    value: total,
    // Missing towns make the real total higher, not lower.
    low: total,
    high: total * 1.3,
    kept,
    dropped: [],
    sources: sites,
    confidence: kept.length >= 3 && sites >= 2 ? 'medium' : 'low',
  };
}

