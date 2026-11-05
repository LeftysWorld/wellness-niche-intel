import type { AnalysisResult, BusinessModel, MonthSnapshot, SensitivityItem, Tri } from './types.ts';
import { createRng, normalizeTri, percentiles, point, round2 } from './random.ts';
import { modeScenario, randomScenario, simulate } from './simulate.ts';
import type { SimulationPath } from './simulate.ts';
import { valueAtYear } from './valuation.ts';

export * from './types.ts';
export { tri, point, createRng, sampleTri, percentiles } from './random.ts';
export { simulate, modeScenario, randomScenario, fund, amortizedPayment, loanBalance, DEMAND_CORRELATION } from './simulate.ts';
export { valueAtYear } from './valuation.ts';

export interface AnalyzeOptions {
  simulations?: number;
  seed?: number;
  /** Skip the one-at-a-time sensitivity sweep (used when screening many ideas). */
  sensitivity?: boolean;
}

/** Average monthly owner profit across an operating year (1-based), most-likely case. */
export function deterministicYearProfit(model: BusinessModel, year: number): number {
  const path = simulate(model, modeScenario(model));
  return avg(path.profit.slice((year - 1) * 12, year * 12));
}

/** Monthly figures for one operating month in the most-likely case (used by tests and quick checks). */
export function deterministicMonth(model: BusinessModel, month: number) {
  const path = simulate(model, modeScenario(model));
  return { revenue: path.revenue[month - 1], costs: path.costs[month - 1], profit: path.profit[month - 1], takeHome: path.takeHome[month - 1] };
}

const yearAvg = (xs: number[], year: number) => avg(xs.slice((year - 1) * 12, year * 12));

export function analyze(model: BusinessModel, opts: AnalyzeOptions = {}): AnalysisResult {
  const simulations = opts.simulations ?? 2000;
  const seed = opts.seed ?? 42;
  const rng = createRng(seed);

  type Year = { r: number[]; c: number[]; p: number[]; t: number[] };
  const years: Record<1 | 3 | 5, Year> = { 1: { r: [], c: [], p: [], t: [] }, 3: { r: [], c: [], p: [], t: [] }, 5: { r: [], c: [], p: [], t: [] } };
  const totals: number[] = [];
  const breakEven: number[] = [];
  const cashLow: number[] = [];
  const cashNeeded: number[] = [];
  const dscr: number[] = [];
  const preMonths: number[] = [];
  const preCost: number[] = [];
  const v3: number[] = [], v3n: number[] = [], v5: number[] = [], v5n: number[] = [], prop5: number[] = [];
  const ret5: number[] = [];
  const hours: number[] = [];
  const helpHours: number[] = [];
  const helpCost: number[] = [];
  const methods3: Record<string, number> = {};
  const methods5: Record<string, number> = {};

  for (let i = 0; i < simulations; i++) {
    const sc = randomScenario(model, rng);
    const path = simulate(model, sc);
    for (const y of [1, 3, 5] as const) {
      years[y].r.push(yearAvg(path.revenue, y));
      years[y].c.push(yearAvg(path.costs, y));
      years[y].p.push(yearAvg(path.profit, y));
      years[y].t.push(yearAvg(path.takeHome, y));
    }
    totals.push(path.funding.total);
    const be = path.takeHome.findIndex((p) => p > 0);
    breakEven.push(be === -1 ? Infinity : be + 1);
    const low = cashLowPoint(path);
    cashLow.push(low);
    const needed = path.funding.equity + Math.max(0, -low);
    cashNeeded.push(needed);
    if (path.funding.monthlyPayment > 0) dscr.push(avg(path.operatingProfit.slice(0, 24)) / path.funding.monthlyPayment);
    preMonths.push(path.preOpeningMonths);
    preCost.push(path.preOpeningCost.reduce((a, b) => a + b, 0));
    hours.push(Math.max(...path.ownerHours));
    helpHours.push(yearAvg(path.paidHelpHours, 3));
    helpCost.push(yearAvg(path.paidHelpCost, 3));
    const y3 = valueAtYear(model, sc, path, 3);
    const y5 = valueAtYear(model, sc, path, 5);
    v3.push(y3.price); v3n.push(y3.netProceeds); v5.push(y5.price); v5n.push(y5.netProceeds); prop5.push(y5.propertyValue);
    methods3[y3.method] = (methods3[y3.method] ?? 0) + 1;
    methods5[y5.method] = (methods5[y5.method] ?? 0) + 1;
    const kept = path.takeHome.slice(0, 60).reduce((a, b) => a + b, 0);
    ret5.push(needed > 0 ? (kept + y5.netProceeds - needed) / needed : 0);
  }

  const snap = (y: Year): MonthSnapshot => ({
    revenue: roundP(percentiles(y.r)),
    costs: roundP(percentiles(y.c)),
    profit: roundP(percentiles(y.p)),
    takeHome: roundP(percentiles(y.t)),
  });

  const modePath = simulate(model, modeScenario(model));
  const f = modePath.funding;
  const beSorted = [...breakEven].sort((a, b) => a - b);
  const beMedian = beSorted[Math.floor(beSorted.length / 2)];
  const cl = percentiles(cashLow);
  const need = percentiles(cashNeeded);
  const hoursP50 = percentiles(hours).p50;
  const helpP50 = percentiles(helpHours).p50;
  const limit = model.capacity?.ownerHoursPerMonth ?? null;

  // Lender test: operating profit in the first two years should cover the loan payment with margin.
  const required = model.financing.minDscr ?? 1.25;
  const isLoan = f.loan > 0;
  const dscrP50 = isLoan ? percentiles(dscr).p50 : null;
  const bankable = !isLoan || (dscrP50 ?? 0) >= required;
  const lenderNote = !isLoan
    ? 'No loan.'
    : bankable
      ? `Profit covers the loan payment ${dscrP50!.toFixed(2)}x in years 1-2; lenders look for ${required}x.`
      : `A lender is unlikely to approve: profit covers the payment only ${dscrP50!.toFixed(2)}x in years 1-2 (lenders look for ${required}x).`;

  const ownerCash = model.financing.ownerCash;
  const cashOk = ownerCash >= need.p50;
  const fundable = cashOk && bankable;
  const fundingNote = !bankable
    ? lenderNote
    : !cashOk
      ? `Needs about $${Math.round(need.p50).toLocaleString('en-US')} of your cash (equity plus the dip before profits arrive); you have $${Math.round(ownerCash).toLocaleString('en-US')}.`
      : `${f.note} Cash needed including the early dip: about $${Math.round(need.p50).toLocaleString('en-US')}.`;

  const warnings: string[] = [];
  if (!bankable) warnings.push(lenderNote);
  if (!cashOk) warnings.push(fundingNote);
  if (cashOk && need.p90 > ownerCash) warnings.push(`In a weak case you would need about $${Math.round(need.p90).toLocaleString('en-US')} of cash, more than you have.`);
  if (helpP50 > 0.5) warnings.push(`You can't cover all the hours alone: about ${Math.round(helpP50)} hours a month of paid help (≈$${Math.round(percentiles(helpCost).p50).toLocaleString('en-US')}/month) is included.`);
  for (const s of model.streams) {
    if (s.units * s.sellablePerUnitPerMonth <= 1) continue;
    if (normalizeTri(s.matureOccupancy).mode > 0.8) warnings.push(`Mature occupancy for "${s.label}" above 80% is unusually high.`);
  }

  return {
    label: model.label,
    simulations,
    seed,
    startup: {
      total: roundP(percentiles(totals)),
      lines: model.startupCosts.map((c, i) => ({ key: c.key, label: c.label, p50: round2(modeScenario(model).startupLines[i]) })),
      contingencyP50: round2(f.contingency),
      workingCapitalP50: round2(f.workingCapital),
      preOpeningCostP50: round2(percentiles(preCost).p50),
      preOpeningMonthsP50: Math.round(percentiles(preMonths).p50),
      ownerEquityP50: round2(f.equity),
      loanAmountP50: round2(f.loan),
      monthlyDebtPaymentP50: round2(f.monthlyPayment),
      cashNeeded: roundP(need),
      fundable,
      fundingNote,
    },
    lender: { applies: isLoan, dscrP50: dscrP50 === null ? null : round2(dscrP50), required, bankable, note: lenderNote },
    year1: snap(years[1]),
    year3: snap(years[3]),
    year5: snap(years[5]),
    breakEvenMonthP50: Number.isFinite(beMedian) ? beMedian : null,
    cashLowPoint: { p10: round2(cl.p10), p50: round2(cl.p50) },
    valuation: [
      { year: 3, price: roundP(percentiles(v3)), netProceeds: roundP(percentiles(v3n)), method: topKey(methods3) as 'sde' | 'ebitda' | 'asset', propertyValueP50: 0 },
      { year: 5, price: roundP(percentiles(v5)), netProceeds: roundP(percentiles(v5n)), method: topKey(methods5) as 'sde' | 'ebitda' | 'asset', propertyValueP50: round2(percentiles(prop5).p50) },
    ],
    totalReturnYear5: roundP(percentiles(ret5)),
    sensitivity: opts.sensitivity === false ? [] : sensitivity(model),
    capacity: {
      peakOwnerHoursP50: Math.round(hoursP50),
      limit,
      paidHelpHoursP50: Math.round(helpP50),
      paidHelpCostP50: round2(percentiles(helpCost).p50),
      needsHelp: helpP50 > 0.5,
    },
    warnings,
  };
}

/** Lowest point of business cash from project start: opening buffer, minus pre-opening costs, plus take-home. */
function cashLowPoint(path: SimulationPath): number {
  let cash = path.funding.workingCapital;
  let low = cash;
  for (const c of path.preOpeningCost) {
    cash -= c;
    if (cash < low) low = cash;
  }
  for (const p of path.takeHome) {
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
  if (model.costs.hourlyWage) inputs.push({ name: 'Paid help hourly cost', get: (m) => m.costs.hourlyWage!, set: (m, t) => { m.costs.hourlyWage = t; } });
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
