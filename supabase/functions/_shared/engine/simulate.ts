import type { BusinessModel, Tri } from './types.ts';
import { normalizeTri, sampleTri } from './random.ts';

/** Every uncertain input resolved to one concrete value for a single simulation. */
export interface Scenario {
  startupLines: number[];
  contingencyPct: number;
  streams: { price: number; start: number; mature: number; monthsToMature: number }[];
  fixed: number[];
  staffing: number[];
  variablePct: number;
  perSale: Record<string, number>;
  revenueTaxPct: number;
  sdeMultiple: number;
  ebitdaMultiple: number;
  managerMonthlyCost: number;
  landAppreciation: number;
}

type Pick = (t: Tri) => number;

function resolve(model: BusinessModel, pick: Pick): Scenario {
  const perSale: Record<string, number> = {};
  for (const [k, v] of Object.entries(model.costs.perSaleCost)) perSale[k] = pick(v);
  return {
    startupLines: model.startupCosts.map((c) => pick(c.amount)),
    contingencyPct: pick(model.contingencyPct),
    streams: model.streams.map((s) => ({
      price: pick(s.price),
      start: clamp01(pick(s.startOccupancy)),
      mature: clamp01(pick(s.matureOccupancy)),
      monthsToMature: Math.max(1, pick(s.monthsToMature)),
    })),
    fixed: model.costs.fixed.map((c) => pick(c.amount)),
    staffing: model.costs.staffing.map((c) => pick(c.amount)),
    variablePct: pick(model.costs.variablePctOfRevenue),
    perSale,
    revenueTaxPct: pick(model.costs.revenueTaxPct),
    sdeMultiple: pick(model.exit.sdeMultiple),
    ebitdaMultiple: pick(model.exit.ebitdaMultiple),
    managerMonthlyCost: pick(model.exit.managerMonthlyCost),
    landAppreciation: pick(model.exit.landAppreciation),
  };
}

export function randomScenario(model: BusinessModel, rng: () => number): Scenario {
  return resolve(model, (t) => sampleTri(t, rng));
}

/** The most-likely case: every input at its mode. */
export function modeScenario(model: BusinessModel): Scenario {
  return resolve(model, (t) => normalizeTri(t).mode);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export interface Funding {
  base: number;
  contingency: number;
  workingCapital: number;
  total: number;
  equity: number;
  loan: number;
  monthlyPayment: number;
  ratePct: number;
  termMonths: number;
  fundable: boolean;
  note: string;
}

export function fixedCostAt(model: BusinessModel, sc: Scenario, m: number): number {
  let total = 0;
  model.costs.fixed.forEach((c, i) => {
    if (m < (c.fromMonth ?? 1)) return;
    total += sc.fixed[i] * Math.pow(1 + (c.annualGrowth ?? 0), (m - 1) / 12);
  });
  return total;
}

/** Staffing steps: for each key, the step with the latest fromMonth <= m applies. */
export function staffingAt(model: BusinessModel, sc: Scenario, m: number): number {
  const active = new Map<string, { from: number; amount: number }>();
  model.costs.staffing.forEach((c, i) => {
    const from = c.fromMonth ?? 1;
    if (m < from) return;
    const prev = active.get(c.key);
    if (!prev || from >= prev.from) {
      active.set(c.key, { from, amount: sc.staffing[i] * Math.pow(1 + (c.annualGrowth ?? 0), (m - 1) / 12) });
    }
  });
  let total = 0;
  for (const v of active.values()) total += v.amount;
  return total;
}

export function fund(model: BusinessModel, sc: Scenario): Funding {
  const base = sc.startupLines.reduce((a, b) => a + b, 0);
  const contingency = base * sc.contingencyPct;
  const workingCapital = model.workingCapitalMonths * (fixedCostAt(model, sc, 1) + staffingAt(model, sc, 1));
  const total = base + contingency + workingCapital;
  const f = model.financing;
  const ratePct = f.ratePct ?? 0;
  const termMonths = Math.round((f.termYears ?? 0) * 12);
  let equity = total;
  let loan = 0;
  if (f.kind === 'loan') {
    // The owner injects the lender's minimum equity and keeps the rest of
    // their cash as a personal reserve; everything else is borrowed.
    equity = total * (f.minEquityPct ?? 0.1);
    loan = total - equity;
  }
  const monthlyPayment = loan > 0 ? amortizedPayment(loan, ratePct, termMonths) : 0;
  const fundable = f.ownerCash >= equity;
  const note = fundable
    ? f.kind === 'loan'
      ? `Owner injects ${pct(f.minEquityPct ?? 0.1)} of project cost; the rest is borrowed.`
      : 'Owner cash covers the full project cost.'
    : `Short by about $${Math.round(equity - f.ownerCash).toLocaleString('en-US')} of owner cash.`;
  return { base, contingency, workingCapital, total, equity, loan, monthlyPayment, ratePct, termMonths, fundable, note };
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function amortizedPayment(principal: number, ratePct: number, months: number): number {
  if (principal <= 0 || months <= 0) return 0;
  const r = ratePct / 100 / 12;
  if (r === 0) return principal / months;
  return (principal * r) / (1 - Math.pow(1 + r, -months));
}

export function loanBalance(principal: number, ratePct: number, months: number, paid: number): number {
  if (principal <= 0 || months <= 0) return 0;
  if (paid >= months) return 0;
  const r = ratePct / 100 / 12;
  if (r === 0) return principal * (1 - paid / months);
  const pmt = amortizedPayment(principal, ratePct, months);
  return principal * Math.pow(1 + r, paid) - (pmt * (Math.pow(1 + r, paid) - 1)) / r;
}

export interface SimulationPath {
  revenue: number[];
  costs: number[];
  /** Owner profit after debt service, before owner pay and income tax. */
  profit: number[];
  debtService: number[];
  ownerHours: number[];
  funding: Funding;
}

export function simulate(model: BusinessModel, sc: Scenario): SimulationPath {
  const horizon = model.horizonMonths ?? 60;
  const startCal = (model.startCalendarMonth ?? 1) - 1;
  const funding = fund(model, sc);
  const revenue: number[] = [];
  const costs: number[] = [];
  const profit: number[] = [];
  const debtService: number[] = [];
  const ownerHours: number[] = [];

  for (let m = 1; m <= horizon; m++) {
    const cal = (startCal + m - 1) % 12;
    let rev = 0;
    let perSaleCost = 0;
    let hours = model.capacity?.ownerFixedHoursPerMonth ?? 0;
    model.streams.forEach((s, i) => {
      const st = sc.streams[i];
      const progress = st.monthsToMature <= 1 ? 1 : Math.min(1, (m - 1) / (st.monthsToMature - 1));
      const occ = st.start + (st.mature - st.start) * progress;
      const season = s.seasonality?.[cal] ?? 1;
      const capacity = s.units * s.sellablePerUnitPerMonth;
      const sold = Math.min(capacity, capacity * occ * season);
      rev += sold * st.price;
      perSaleCost += sold * (sc.perSale[s.key] ?? 0);
      hours += sold * (s.ownerHoursPerSale ?? 0);
    });
    const debt = m <= funding.termMonths ? funding.monthlyPayment : 0;
    const cost =
      fixedCostAt(model, sc, m) +
      staffingAt(model, sc, m) +
      rev * sc.variablePct +
      perSaleCost +
      rev * sc.revenueTaxPct +
      debt;
    revenue.push(rev);
    costs.push(cost);
    profit.push(rev - cost);
    debtService.push(debt);
    ownerHours.push(hours);
  }
  return { revenue, costs, profit, debtService, ownerHours, funding };
}
