import type { AnalysisResult, BusinessModel, MonthSnapshot, SensitivityItem, Tri } from './types.ts';
import { createRng, normalizeTri, percentiles, point, round2 } from './random.ts';
import { modeScenario, randomScenario, simulate } from './simulate.ts';
import type { SimulationPath } from './simulate.ts';
import { valueAtYear } from './valuation.ts';

export * from './types.ts';
export { tri, point, createRng, sampleTri, percentiles } from './random.ts';
export { simulate, modeScenario, randomScenario, fund, amortizedPayment, loanBalance } from './simulate.ts';
export { valueAtYear } from './valuation.ts';

export interface AnalyzeOptions {
  simulations?: number;
  seed?: number;
}

/** Average monthly owner profit across a year (1-based), most-likely case. */
export function deterministicYearProfit(model: BusinessModel, year: number): number {
  const path = simulate(model, modeScenario(model));
  return avg(path.profit.slice((year - 1) * 12, year * 12));
}

/** Monthly figures for one month in the most-likely case (used by tests and quick checks). */
export function deterministicMonth(model: BusinessModel, month: number) {
  const path = simulate(model, modeScenario(model));
  return { revenue: path.revenue[month - 1], costs: path.costs[month - 1], profit: path.profit[month - 1] };
}

export function analyze(model: BusinessModel, opts: AnalyzeOptions = {}): AnalysisResult {
  const simulations = opts.simulations ?? 2000;
  const seed = opts.seed ?? 42;
  const rng = createRng(seed);
  const horizon = model.horizonMonths ?? 60;

  const collect = { r12: [] as number[], c12: [] as number[], p12: [] as number[], r36: [] as number[], c36: [] as number[], p36: [] as number[], r60: [] as number[], c60: [] as number[], p60: [] as number[] };
  const totals: number[] = [];
  const breakEven: number[] = [];
  const cashLow: number[] = [];
  const v3: number[] = [], v3n: number[] = [], v5: number[] = [], v5n: number[] = [];
  const ret5: number[] = [];
  const hours: number[] = [];
  const methods3: Record<string, number> = {};
  const methods5: Record<string, number> = {};
  let fundableCount = 0;

  for (let i = 0; i < simulations; i++) {
    const sc = randomScenario(model, rng);
    const path = simulate(model, sc);
    const at = (m: number, arr: number[]) => arr[Math.min(m, horizon) - 1] ?? 0;
    collect.r12.push(at(12, path.revenue)); collect.c12.push(at(12, path.costs)); collect.p12.push(at(12, path.profit));
    collect.r36.push(at(36, path.revenue)); collect.c36.push(at(36, path.costs)); collect.p36.push(at(36, path.profit));
    collect.r60.push(at(60, path.revenue)); collect.c60.push(at(60, path.costs)); collect.p60.push(at(60, path.profit));
    totals.push(path.funding.total);
    if (path.funding.fundable) fundableCount++;
    const be = path.profit.findIndex((p) => p > 0);
    breakEven.push(be === -1 ? Infinity : be + 1);
    cashLow.push(cashLowPoint(path));
    hours.push(Math.max(...path.ownerHours));
    const y3 = valueAtYear(model, sc, path, 3);
    const y5 = valueAtYear(model, sc, path, 5);
    v3.push(y3.price); v3n.push(y3.netProceeds); v5.push(y5.price); v5n.push(y5.netProceeds);
    methods3[y3.method] = (methods3[y3.method] ?? 0) + 1;
    methods5[y5.method] = (methods5[y5.method] ?? 0) + 1;
    const profits = path.profit.slice(0, 60).reduce((a, b) => a + b, 0);
    ret5.push(path.funding.equity > 0 ? (profits + y5.netProceeds) / path.funding.equity : 0);
  }

  const snap = (r: number[], c: number[], p: number[]): MonthSnapshot => ({
    revenue: roundP(percentiles(r)),
    costs: roundP(percentiles(c)),
    profit: roundP(percentiles(p)),
  });

  const modePath = simulate(model, modeScenario(model));
  const f = modePath.funding;
  const startupTotal = roundP(percentiles(totals));
  const beSorted = [...breakEven].sort((a, b) => a - b);
  const beMedian = beSorted[Math.floor(beSorted.length / 2)];
  const cl = percentiles(cashLow);
  const hoursP50 = percentiles(hours).p50;
  const limit = model.capacity?.ownerHoursPerMonth ?? null;

  const warnings: string[] = [];
  if (!f.fundable) warnings.push(f.note);
  if (fundableCount / simulations < 0.9 && f.fundable) warnings.push('In some scenarios owner cash does not cover the required equity.');
  if (limit !== null && hoursP50 > limit) warnings.push(`Peak owner workload (${Math.round(hoursP50)} h/month) exceeds the ${limit} h/month a solo operator can sustain.`);
  for (const s of model.streams) {
    // A stream with a single sellable unit is a flat monthly amount, not occupancy.
    if (s.units * s.sellablePerUnitPerMonth <= 1) continue;
    if (normalizeTri(s.matureOccupancy).mode > 0.8) warnings.push(`Mature occupancy for "${s.label}" above 80% is unusually high.`);
  }
  if (cl.p10 < 0) warnings.push(`In a weak case the business needs about $${Math.round(-cl.p10).toLocaleString('en-US')} more cash than planned.`);

  return {
    label: model.label,
    simulations,
    seed,
    startup: {
      total: startupTotal,
      lines: model.startupCosts.map((c, i) => ({ key: c.key, label: c.label, p50: round2(modeScenario(model).startupLines[i]) })),
      contingencyP50: round2(f.contingency),
      workingCapitalP50: round2(f.workingCapital),
      ownerEquityP50: round2(f.equity),
      loanAmountP50: round2(f.loan),
      monthlyDebtPaymentP50: round2(f.monthlyPayment),
      fundable: f.fundable,
      fundingNote: f.note,
    },
    month12: snap(collect.r12, collect.c12, collect.p12),
    month36: snap(collect.r36, collect.c36, collect.p36),
    month60: snap(collect.r60, collect.c60, collect.p60),
    breakEvenMonthP50: Number.isFinite(beMedian) ? beMedian : null,
    cashLowPoint: { p10: round2(cl.p10), p50: round2(cl.p50) },
    valuation: [
      { year: 3, price: roundP(percentiles(v3)), netProceeds: roundP(percentiles(v3n)), method: topKey(methods3) as 'sde' | 'ebitda' | 'asset' },
      { year: 5, price: roundP(percentiles(v5)), netProceeds: roundP(percentiles(v5n)), method: topKey(methods5) as 'sde' | 'ebitda' | 'asset' },
    ],
    totalReturnYear5: roundP(percentiles(ret5)),
    sensitivity: sensitivity(model),
    capacity: { peakOwnerHoursP50: Math.round(hoursP50), limit, exceeded: limit !== null && hoursP50 > limit },
    warnings,
  };
}

/** Lowest point of business cash: opening working capital plus cumulative profit. */
function cashLowPoint(path: SimulationPath): number {
  let cash = path.funding.workingCapital;
  let low = cash;
  for (const p of path.profit) {
    cash += p;
    if (cash < low) low = cash;
  }
  return low;
}

interface TriInput {
  name: string;
  get: (m: BusinessModel) => Tri;
  set: (m: BusinessModel, t: Tri) => void;
}

function triInputs(model: BusinessModel): TriInput[] {
  const inputs: TriInput[] = [];
  model.streams.forEach((s, i) => {
    inputs.push({ name: `${s.label}: price`, get: (m) => m.streams[i].price, set: (m, t) => { m.streams[i].price = t; } });
    inputs.push({ name: `${s.label}: mature occupancy`, get: (m) => m.streams[i].matureOccupancy, set: (m, t) => { m.streams[i].matureOccupancy = t; } });
    inputs.push({ name: `${s.label}: months to mature`, get: (m) => m.streams[i].monthsToMature, set: (m, t) => { m.streams[i].monthsToMature = t; } });
  });
  model.costs.fixed.forEach((c, i) => {
    inputs.push({ name: c.label, get: (m) => m.costs.fixed[i].amount, set: (m, t) => { m.costs.fixed[i].amount = t; } });
  });
  model.costs.staffing.forEach((c, i) => {
    inputs.push({ name: c.label, get: (m) => m.costs.staffing[i].amount, set: (m, t) => { m.costs.staffing[i].amount = t; } });
  });
  inputs.push({ name: 'Variable costs (% of revenue)', get: (m) => m.costs.variablePctOfRevenue, set: (m, t) => { m.costs.variablePctOfRevenue = t; } });
  inputs.push({ name: 'Revenue taxes', get: (m) => m.costs.revenueTaxPct, set: (m, t) => { m.costs.revenueTaxPct = t; } });
  for (const k of Object.keys(model.costs.perSaleCost)) {
    inputs.push({ name: `Cost per sale: ${k}`, get: (m) => m.costs.perSaleCost[k], set: (m, t) => { m.costs.perSaleCost[k] = t; } });
  }
  return inputs;
}

/** Which inputs move year-3 monthly profit most (one-at-a-time swings, most-likely case otherwise). */
export function sensitivity(model: BusinessModel, top = 8): SensitivityItem[] {
  const items: SensitivityItem[] = [];
  for (const input of triInputs(model)) {
    const t = normalizeTri(input.get(model));
    if (t.low === t.high) continue;
    const lowModel = structuredClone(model);
    input.set(lowModel, point(t.low));
    const highModel = structuredClone(model);
    input.set(highModel, point(t.high));
    const lowProfit = deterministicYearProfit(lowModel, 3);
    const highProfit = deterministicYearProfit(highModel, 3);
    items.push({ input: input.name, lowProfit: round2(lowProfit), highProfit: round2(highProfit), swing: round2(Math.abs(highProfit - lowProfit)) });
  }
  return items.sort((a, b) => b.swing - a.swing).slice(0, top);
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function roundP(p: { p10: number; p50: number; p90: number }) {
  return { p10: round2(p.p10), p50: round2(p.p50), p90: round2(p.p90) };
}

function topKey(counts: Record<string, number>): string {
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'sde';
}
