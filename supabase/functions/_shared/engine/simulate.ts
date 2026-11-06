import type { BusinessModel, Tri } from './types.ts';
import { correlatedU, normal, normalizeTri, sampleTri, triFromU } from './random.ts';

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
  reservePct: number;
  incomeTaxPct: number;
  hourlyWage: number;
  preOpeningMonths: number;
}

type Pick = (t: Tri) => number;
/** Picks for demand-linked inputs: price and occupancy rise together, ramp-up shortens. */
interface DemandPick {
  price: Pick;
  occupancy: Pick;
  ramp: Pick;
}

function resolve(model: BusinessModel, pick: Pick, demand?: DemandPick): Scenario {
  const d = demand ?? { price: pick, occupancy: pick, ramp: pick };
  const zero = { low: 0, mode: 0, high: 0 };
  const perSale: Record<string, number> = {};
  for (const [k, v] of Object.entries(model.costs.perSaleCost)) perSale[k] = pick(v);
  return {
    startupLines: model.startupCosts.map((c) => pick(c.amount)),
    contingencyPct: pick(model.contingencyPct),
    streams: model.streams.map((s) => ({
      price: d.price(s.price),
      start: clamp01(d.occupancy(s.startOccupancy)),
      mature: clamp01(d.occupancy(s.matureOccupancy)),
      monthsToMature: Math.max(1, d.ramp(s.monthsToMature)),
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
    reservePct: pick(model.costs.reservePctOfRevenue ?? zero),
    incomeTaxPct: pick(model.costs.incomeTaxPct ?? zero),
    hourlyWage: pick(model.costs.hourlyWage ?? zero),
    preOpeningMonths: Math.max(0, Math.round(pick(model.preOpening?.months ?? zero))),
  };
}

/** How strongly price, occupancy and ramp-up move with one shared market-demand factor. */
export const DEMAND_CORRELATION = 0.6;

export function randomScenario(model: BusinessModel, rng: () => number): Scenario {
  // One demand factor per scenario: a strong market lifts price and occupancy
  // together and fills up faster; a weak one does the opposite.
  const common = normal(rng);
  const u = () => correlatedU(common, DEMAND_CORRELATION, rng);
  return resolve(model, (t) => sampleTri(t, rng), {
    price: (t) => triFromU(t, u()),
    occupancy: (t) => triFromU(t, u()),
    ramp: (t) => triFromU(t, 1 - u()),
  });
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
    // The owner injects the lender's minimum equity; everything else is borrowed,
    // up to the most the lender will lend.
    equity = Math.max(total * (f.minEquityPct ?? 0.25), total - (f.maxLoan ?? Infinity));
    loan = total - equity;
  }
  const monthlyPayment = loan > 0 ? amortizedPayment(loan, ratePct, termMonths) : 0;
  // Owner cash vs equity only; the cash dip and the lender test are added in analyze().
  const fundable = f.ownerCash >= equity;
  const note = fundable
    ? f.kind === 'loan'
      ? `Owner injects ${pct(equity / total)} of project cost; the rest is borrowed${f.lender ? ` from ${f.lender}` : ''}.`
      : 'Owner cash covers the project cost.'
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
  /** Operating months, starting on opening day. */
  revenue: number[];
  costs: number[];
  /** Owner profit after debt service, before income tax. */
  profit: number[];
  /** Profit after estimated income tax. */
  takeHome: number[];
  /** Operating profit before loan payments and tax (for the lender test and valuation). */
  operatingProfit: number[];
  debtService: number[];
  ownerHours: number[];
  /** Hours per month covered by paid help because the owner's limit was reached. */
  paidHelpHours: number[];
  paidHelpCost: number[];
  /** Months before opening, and what they cost (rent, running costs, interest). */
  preOpeningMonths: number;
  preOpeningCost: number[];
  funding: Funding;
}

export function simulate(model: BusinessModel, sc: Scenario): SimulationPath {
  const horizon = model.horizonMonths ?? 60;
  const pre = sc.preOpeningMonths;
  const startCal = (model.startCalendarMonth ?? 1) - 1;
  const funding = fund(model, sc);
  const out: SimulationPath = {
    revenue: [], costs: [], profit: [], takeHome: [], operatingProfit: [], debtService: [], ownerHours: [],
    paidHelpHours: [], paidHelpCost: [], preOpeningMonths: pre, preOpeningCost: [], funding,
  };

  // Before opening: rent in full, a share of other running costs, interest only on any loan.
  const share = model.preOpening?.fixedShare ?? 0.3;
  const interestOnly = (funding.loan * funding.ratePct) / 100 / 12;
  for (let m = 1; m <= pre; m++) {
    let fixed = 0;
    model.costs.fixed.forEach((c, i) => {
      fixed += c.key === 'lease' ? sc.fixed[i] : sc.fixed[i] * share;
    });
    out.preOpeningCost.push(fixed + interestOnly);
  }

  const limit = model.capacity?.ownerHoursPerMonth ?? Infinity;
  for (let m = 1; m <= horizon; m++) {
    const cal = (startCal + pre + m - 1) % 12;
    let rev = 0;
    let perSaleCost = 0;
    let hours = (model.capacity?.ownerFixedHoursPerMonth ?? 0) + (model.capacity?.openHoursPerMonth ?? 0);
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
    // Hours beyond what the owner can work are paid for at the hourly wage.
    const helpHours = Number.isFinite(limit) ? Math.max(0, hours - limit) : 0;
    const helpCost = helpHours * sc.hourlyWage;
    const debt = m <= funding.termMonths ? funding.monthlyPayment : 0;
    const operating =
      fixedCostAt(model, sc, pre + m) +
      staffingAt(model, sc, m) +
      helpCost +
      rev * sc.variablePct +
      rev * sc.reservePct +
      perSaleCost +
      rev * sc.revenueTaxPct;
    const profit = rev - operating - debt;
    const tax = Math.max(0, profit) * sc.incomeTaxPct;
    out.revenue.push(rev);
    out.costs.push(operating + debt);
    out.operatingProfit.push(rev - operating);
    out.profit.push(profit);
    out.takeHome.push(profit - tax);
    out.debtService.push(debt);
    out.ownerHours.push(Math.min(hours, limit));
    out.paidHelpHours.push(helpHours);
    out.paidHelpCost.push(helpCost);
  }
  return out;
}
