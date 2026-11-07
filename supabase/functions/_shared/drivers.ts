// Which ledger value stands behind each input the sensitivity sweep reports,
// so the analyst agent can research the inputs that move profit most.
// Pure (no I/O), so it is tested.
import type { BusinessModel, SensitivityItem } from './engine/types.ts';
import type { Evidence, SiteType, Tenure } from './model-builder.ts';

export interface Driver {
  input: string;
  /** Monthly year-3 profit swing between the input's low and high (USD). */
  swing: number;
  /** Ledger key to research, or null when it is part of the niche's own economics. */
  key: string | null;
  /** pairing: researched for this idea only; place: belongs to the location (or its country). */
  scope: 'pairing' | 'place' | null;
  status: 'sourced' | 'guessed' | 'missing' | 'niche';
}

export const LEASE_KEY_BY_SITE: Record<SiteType, string> = {
  house: 'lease.finca_monthly_usd',
  commercial: 'lease.commercial_monthly_usd',
  estate: 'lease.estate_monthly_usd',
};

/** Keys researched for one idea only: comparable prices and occupancy. */
export const PAIRING_KEY = /^(price\.[a-z0-9_]+_usd|occupancy\.[a-z0-9_]+\.(mature|start)|demand\.competitors_60min)$/;

export function driverKeys(
  model: BusinessModel,
  items: SensitivityItem[],
  opts: { tenure: Tenure; siteType?: SiteType; evidence: Evidence },
): Driver[] {
  const byLabel = new Map(model.streams.map((s) => [s.label, s.key]));
  const staffing = new Set(model.costs.staffing.map((c) => c.label));
  const fixedByLabel = new Map(model.costs.fixed.map((c) => [c.label, c.key]));
  const status = (key: string | null): Driver['status'] => {
    if (!key) return 'niche';
    if (opts.evidence.sourced.includes(key)) return 'sourced';
    if (opts.evidence.guessed.includes(key)) return 'guessed';
    return 'missing';
  };
  return items.map((it) => {
    let key: string | null = null;
    let scope: Driver['scope'] = null;
    const m = it.input.match(/^(.*): (price|mature occupancy|months to mature)$/);
    if (m && byLabel.has(m[1])) {
      const stream = byLabel.get(m[1])!;
      if (m[2] === 'price') key = `price.${stream}_usd`;
      if (m[2] === 'mature occupancy') key = `occupancy.${stream}.mature`;
      scope = key ? 'pairing' : null;
    } else if (fixedByLabel.get(it.input) === 'lease') {
      key = LEASE_KEY_BY_SITE[opts.siteType ?? 'house'];
      scope = 'place';
    } else if (fixedByLabel.get(it.input) === 'ground_rent') {
      key = 'lease.land_monthly_usd_per_acre';
      scope = 'place';
    } else if (staffing.has(it.input) || it.input === 'Paid help hourly cost') {
      key = 'labor.monthly_wage_usd';
      scope = 'place';
    } else if (it.input === 'Revenue taxes') {
      key = 'tax.revenue_pct';
      scope = 'place';
    }
    // A price or occupancy with no idea-specific value falls back to the place's index: still worth researching.
    const s = status(key);
    return { input: it.input, swing: it.swing, key, scope, status: key && scope === 'pairing' && s === 'missing' ? 'guessed' : s };
  });
}

/**
 * Width of the year-3 take-home range relative to its middle: (P90 − P10) / |P50|.
 * Small values mean the inputs pin the answer down. A P50 near zero uses $500 as the floor.
 */
export function uncertaintyBand(p: { p10: number; p50: number; p90: number }): number {
  return Math.round(((p.p90 - p.p10) / Math.max(Math.abs(p.p50), 500)) * 100) / 100;
}
