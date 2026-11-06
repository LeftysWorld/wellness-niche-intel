// How a niche × place idea is scored. Pure functions (no I/O) so they are tested.
// Ranking in the app is money-first; this score is a secondary, explainable
// summary whose parts and weights the owner can see and change.
import type { AnalysisResult } from './engine/types.ts';
import type { Evidence } from './model-builder.ts';

export interface ScoreParts {
  /** Target-year monthly take-home vs the owner's target. */
  money: number;
  /** Year-3 monthly take-home vs the target: does it keep growing? */
  growth: number;
  /** Can the owner fund it (cash and, if borrowing, the lender test)? */
  capital: number;
  /** How much of the work the owner can do alone. */
  workload: number;
  /** Evidence that people buy this kind of thing (AI-judged with sources). */
  demand: number;
  /** How well the place matches the owner's own description (only once given). */
  place?: number;
  /** Residency route for the owner in that country. */
  visa: number;
  /** Country, currency and safety risk. */
  risk: number;
  /** How much of the input data is sourced rather than guessed. */
  evidence: number;
}

export type Weights = Record<keyof ScoreParts, number>;

export const DEFAULT_WEIGHTS: Weights = {
  money: 0.3,
  growth: 0.15,
  capital: 0.15,
  workload: 0.05,
  demand: 0.1,
  place: 0.1,
  visa: 0.05,
  risk: 0.05,
  evidence: 0.05,
};

/** after_tax = take-home; pre_tax = profit; with_housing = take-home plus the housing living on site saves. */
export type TargetBasis = 'after_tax' | 'pre_tax' | 'with_housing';

export function snapshotFor(r: AnalysisResult, year: number) {
  return year <= 1 ? r.year1 : year <= 3 ? r.year3 : r.year5;
}

/** The monthly figure compared to the owner's target: take-home (after tax) or profit (before tax). */
export function targetFigure(r: AnalysisResult, year: number, basis: TargetBasis): number {
  const s = snapshotFor(r, year);
  if (basis === 'pre_tax') return s.profit.p50;
  if (basis === 'with_housing') return (s.takeHomeWithHousing ?? s.takeHome).p50;
  return s.takeHome.p50;
}

const VISA: Record<string, number> = { citizen: 10, spouse_visa_eligible: 9, digital_nomad: 6, needs_investor_residency: 5, unclear: 3, not_allowed: 0 };
const clamp = (n: number) => Math.max(0, Math.min(10, n));

export interface ScoreInput {
  result: AnalysisResult;
  evidence: Evidence;
  target: number;
  targetYear: number;
  basis: TargetBasis;
  /** 0-10 from the niche card, or null to fall back on example counts. */
  nicheDemand: number | null;
  signalScore: number;
  placeFit: number | null;
  visaRoute: string | undefined;
  countryDiscount: number;
  advisoryLevel: number;
}

export function scoreIdea(i: ScoreInput, weights: Partial<Weights> = {}): { parts: ScoreParts; total: number } {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const r = i.result;
  const target = Math.max(1, i.target);
  const parts: ScoreParts = {
    money: clamp((targetFigure(r, i.targetYear, i.basis) / target) * 10),
    growth: clamp((targetFigure(r, 3, i.basis) / target) * 10),
    capital: r.startup.fundable ? 10 : r.lender.applies && !r.lender.bankable ? 2 : 0,
    workload: clamp(10 - r.capacity.paidHelpHoursP50 / 25),
    // Example counts mostly measure what the searches happened to find, so they count for less.
    demand: i.nicheDemand !== null ? clamp(i.nicheDemand) : clamp(Math.min(10, i.signalScore) * 0.6),
    visa: VISA[i.visaRoute ?? 'unclear'] ?? 3,
    risk: clamp(10 - i.countryDiscount * 10 - Math.max(0, i.advisoryLevel - 1) * 2),
    evidence: clamp(i.evidence.sourcedShare * 10 - (i.evidence.nicheGuessed ? 3 : 0)),
  };
  if (i.placeFit !== null) parts.place = clamp(i.placeFit);
  let sum = 0;
  let weight = 0;
  for (const [k, v] of Object.entries(parts) as [keyof ScoreParts, number][]) {
    if (v === undefined) continue;
    sum += v * (w[k] ?? 0);
    weight += w[k] ?? 0;
  }
  return { parts, total: weight ? Math.round((sum / weight) * 100) / 100 : 0 };
}

/** Money-first order: fundable ideas first, then by target-year figure, then by year 3. */
export function moneyRank(a: { fundable: boolean; target: number; year3: number }, b: { fundable: boolean; target: number; year3: number }): number {
  if (a.fundable !== b.fundable) return a.fundable ? -1 : 1;
  if (b.target !== a.target) return b.target - a.target;
  return b.year3 - a.year3;
}
