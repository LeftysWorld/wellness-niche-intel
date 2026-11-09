// Demand pull: evidence that people already want this kind of business, in the
// market at large and in this area. The analyst records signals, each with an
// exact quote from a page it saw; the score is computed here from the signals,
// never by the model. Pure functions so tests and the app share them.

export type DemandScope = 'market' | 'area';

export const MARKET_KINDS = ['search_trend', 'operator_growth', 'industry_data', 'media_trend', 'price_power'] as const;
export const AREA_KINDS = ['busy_competitors', 'local_interest', 'population_income', 'tourism', 'adjacent_demand', 'saturation', 'seasonality'] as const;
export type DemandKind = (typeof MARKET_KINDS)[number] | (typeof AREA_KINDS)[number];

export const KIND_LABEL: Record<DemandKind, string> = {
  search_trend: 'Search interest',
  operator_growth: 'Operators expanding',
  industry_data: 'Industry data',
  media_trend: 'Press and trend coverage',
  price_power: 'Pricing power',
  busy_competitors: 'Nearby operators are busy',
  local_interest: 'Local interest',
  population_income: 'Population and income',
  tourism: 'Visitors',
  adjacent_demand: 'Related demand nearby',
  saturation: 'Crowded market',
  seasonality: 'Seasonality',
};

export interface DemandSignal {
  scope: DemandScope;
  kind: DemandKind;
  /** Does it point toward people wanting this (for) or away (against)? */
  direction: 'for' | 'against';
  /** 1 = a hint, 2 = clear, 3 = strong and specific (numbers, sell-outs, waitlists). */
  strength: 1 | 2 | 3;
  /** One plain sentence: what the evidence shows. */
  finding: string;
  url: string;
  host: string;
}

export interface DemandScore {
  /** 0-10; 5 means no net evidence either way. */
  score: number;
  level: 'strong' | 'moderate' | 'weak' | 'unclear';
  signals: number;
  sources: number;
  confidence: 'low' | 'medium' | 'high';
}

/** At most this many signals from one website count toward a score. */
export const MAX_PER_HOST = 2;

export function kindsFor(scope: DemandScope): readonly DemandKind[] {
  return scope === 'market' ? MARKET_KINDS : AREA_KINDS;
}

/**
 * Score one scope. Net evidence (for minus against, by strength) over the
 * evidence seen, with a floor of 6 points so a couple of hints cannot reach
 * the extremes. Each website counts at most twice.
 */
export function scoreDemand(all: DemandSignal[], scope: DemandScope): DemandScore {
  const perHost = new Map<string, number>();
  const counted = all.filter((s) => {
    if (s.scope !== scope) return false;
    const n = (perHost.get(s.host) ?? 0) + 1;
    perHost.set(s.host, n);
    return n <= MAX_PER_HOST;
  });
  const sources = new Set(counted.map((s) => s.host)).size;
  if (!counted.length) return { score: 5, level: 'unclear', signals: 0, sources: 0, confidence: 'low' };
  const pro = counted.filter((s) => s.direction === 'for').reduce((a, s) => a + s.strength, 0);
  const con = counted.filter((s) => s.direction === 'against').reduce((a, s) => a + s.strength, 0);
  const score = Math.round((5 + (5 * (pro - con)) / Math.max(pro + con, 6)) * 10) / 10;
  const confidence = sources >= 4 ? 'high' : sources >= 2 ? 'medium' : 'low';
  const level = sources < 2 && counted.length < 2 ? 'unclear' : score >= 7 ? 'strong' : score >= 4.5 ? 'moderate' : 'weak';
  return { score, level, signals: counted.length, sources, confidence };
}

export interface DemandPull {
  market: DemandScore;
  area: DemandScore;
  /** Area weighs more: the business lives on the people within reach. */
  overall: number;
  level: DemandScore['level'];
}

export function demandPull(signals: DemandSignal[]): DemandPull {
  const market = scoreDemand(signals, 'market');
  const area = scoreDemand(signals, 'area');
  const overall = Math.round((market.score * 0.4 + area.score * 0.6) * 10) / 10;
  const level = market.level === 'unclear' && area.level === 'unclear' ? 'unclear' : overall >= 7 ? 'strong' : overall >= 4.5 ? 'moderate' : 'weak';
  return { market, area, overall, level };
}

/** Why the analyst may not finish yet: demand must be researched in both scopes and assessed after the last signal. */
export function demandGaps(signals: DemandSignal[], assessedCount: number | undefined): string | null {
  const missing = (['market', 'area'] as const).filter((s) => !signals.some((x) => x.scope === s));
  if (missing.length) return `Research demand pull first: record at least one ${missing.join(' and one ')} signal with record_demand_signal, then call assess_demand.`;
  if (assessedCount !== signals.length) return 'Call assess_demand after your last demand signal, then finish.';
  return null;
}
