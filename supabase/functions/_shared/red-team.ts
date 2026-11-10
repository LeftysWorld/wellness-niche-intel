// Comparing an independent re-check with what an analysis used. Pure (no I/O)
// so the agent, the app page and the tests agree on what counts as a gap.
// deno-lint-ignore-file no-explicit-any
import { capitalDrivers, driverKeys } from './drivers.ts';
import type { BusinessModel } from './engine/types.ts';
import { capexKeyFor, type NicheModelSpec } from './model-builder.ts';

export interface RedTeamCheck {
  key: string;
  value: number;
  url: string;
  host: string;
  quote: string;
  note?: string;
}

export interface RedTeamTarget {
  key: string;
  label: string;
  /** What the analysis used. */
  current: number;
  unit: string;
  why: string;
}

export interface RedTeamFinding {
  key: string;
  label: string;
  current: number;
  /** Median of what the red team found; null when it found nothing. */
  found: number | null;
  figures: number;
  sites: number;
  /** Relative difference |found − current| / current. */
  gap: number | null;
  flagged: boolean;
  urls: string[];
}

/** A gap this large on an input that moves cash or profit is worth a second look. */
export const GAP_LIMIT = 0.25;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function compareChecks(targets: RedTeamTarget[], checks: RedTeamCheck[]): RedTeamFinding[] {
  return targets.map((t) => {
    const mine = checks.filter((c) => c.key === t.key);
    if (!mine.length) return { key: t.key, label: t.label, current: t.current, found: null, figures: 0, sites: 0, gap: null, flagged: false, urls: [] };
    const found = Math.round(median(mine.map((c) => c.value)) * 1000) / 1000;
    const gap = t.current ? Math.round((Math.abs(found - t.current) / Math.abs(t.current)) * 1000) / 1000 : null;
    return {
      key: t.key,
      label: t.label,
      current: t.current,
      found,
      figures: mine.length,
      sites: new Set(mine.map((c) => c.host)).size,
      gap,
      flagged: gap !== null && gap > GAP_LIMIT,
      urls: [...new Set(mine.map((c) => c.url))].slice(0, 4),
    };
  });
}

/** One step lower when the red team flags a gap: high → medium → low. */
export function lowerConfidence(c: string, findings: RedTeamFinding[]): string {
  if (!findings.some((f) => f.flagged)) return c;
  return c === 'high' ? 'medium' : 'low';
}

/** The inputs worth an independent check: every price, the biggest booking rates, and the biggest start-up costs. */
export function redTeamTargets(model: BusinessModel, result: Record<string, any>, spec: NicheModelSpec | undefined): RedTeamTarget[] {
  const out: RedTeamTarget[] = [];
  const unitOf = (k: string) => spec?.streams.find((s) => s.key === k)?.priceUnit ?? 'per_unit';
  for (const s of model.streams) {
    if (s.units * s.sellablePerUnitPerMonth <= 1) continue;
    out.push({ key: `price.${s.key}_usd`, label: `${s.label}: price`, current: s.price.mode, unit: `USD ${unitOf(s.key).replace('_', ' ')}`, why: 'Sets revenue directly' });
  }
  const drivers = driverKeys(model, result.sensitivity ?? [], { tenure: result.tenure ?? 'own', siteType: spec?.siteType, evidence: result.evidence ?? { sourced: [], guessed: [], missing: [], sourcedShare: 0, nicheGuessed: true } });
  for (const d of drivers) {
    const m = d.key?.match(/^occupancy\.([a-z0-9_]+)\.mature$/);
    if (!m || out.some((t) => t.key === d.key)) continue;
    const s = model.streams.find((x) => x.key === m[1]);
    if (s) out.push({ key: d.key!, label: `${s.label}: share booked once established`, current: s.matureOccupancy.mode, unit: 'fraction 0-1', why: 'Moves profit most' });
  }
  const capital = capitalDrivers(model, { evidence: result.evidence ?? { sourced: [], guessed: [], missing: [], sourcedShare: 0, nicheGuessed: true }, capexKey: capexKeyFor }).slice(0, 3);
  for (const c of capital) {
    if (c.keys[0].key === 'land.price_per_acre_usd') {
      const acres = Number(c.line.match(/\(([\d.]+) acres?\)/)?.[1] ?? 0);
      if (acres > 0) out.push({ key: 'land.price_per_acre_usd', label: 'Land price per acre', current: Math.round(c.usd / acres), unit: 'USD per acre', why: `Land is ${acres} acres in the model` });
    } else {
      out.push({ key: c.keys[0].key, label: c.line, current: c.usd, unit: 'USD for the whole line', why: 'A large start-up cost' });
    }
  }
  return out.slice(0, 8);
}

