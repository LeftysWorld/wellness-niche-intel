// Turns ledger values + a niche card + a cost template + a parameter profile
// into an engine BusinessModel. Pure and deterministic: no I/O, so it runs in
// edge functions, the dashboard and tests alike. Every ledger value it reads is
// recorded so the analysis can be traced back to its sources.

import type { BusinessModel, CostLine, MonthlyCost, RevenueStream, Tri } from './engine/types.ts';
import { normalizeTri, point } from './engine/random.ts';

export interface LedgerValue {
  id: string;
  key: string;
  value_num: number | null;
  value_text: string | null;
  low: number | null;
  high: number | null;
  confidence: 'high' | 'medium' | 'low';
  source_url: string | null;
  written_by: string;
  is_stale?: boolean;
  scope?: 'pairing' | 'micro_area' | 'country' | 'global';
}

export type Ledger = Map<string, LedgerValue>;

/** Merge ledger rows so the most specific scope wins: pairing > micro-area > country > global. */
export function mergeLedger(layers: { scope: LedgerValue['scope']; rows: LedgerValue[] }[]): Ledger {
  const order = ['global', 'country', 'micro_area', 'pairing'];
  const sorted = [...layers].sort((a, b) => order.indexOf(a.scope ?? 'global') - order.indexOf(b.scope ?? 'global'));
  const merged: Ledger = new Map();
  for (const layer of sorted) for (const row of layer.rows) merged.set(row.key, { ...row, scope: layer.scope });
  return merged;
}

export interface StreamSpec {
  key: string;
  label: string;
  units: number;
  sellablePerUnitPerMonth: number;
  price: Tri;
  startOccupancy: Tri;
  matureOccupancy: Tri;
  monthsToMature: Tri;
  ownerHoursPerSale?: number;
  seasonality?: number[];
}

export interface NicheModelSpec {
  basis?: string;
  ownerFixedHours: number;
  variablePct: Tri;
  requiresPopulation?: boolean;
  streams: StreamSpec[];
  perSale: Record<string, { usd: Tri; scale: Scale }>;
  fixed: { key: string; label: string; usd: Tri; scale: Scale; applies: Applies }[];
  staffing: { key: string; label: string; wageMultiple: Tri; fromMonth?: number }[];
  exit: { sdeMultiple: Tri; ebitdaMultiple: Tri; managerWageMultiple: number };
}

export interface CostTemplate {
  land_acres: number;
  items: {
    key: string;
    label: string;
    qty?: number;
    qtyFrom?: string;
    usd?: Tri;
    scale?: Scale;
    applies: Applies;
    leaseMonths?: number;
  }[];
}

type Scale = 'build' | 'equipment' | 'price' | 'none';
type Applies = 'own' | 'lease' | 'both';
export type Tenure = 'own' | 'lease';

export interface ProfileParams {
  capital_usd: { min: number; max: number };
  financing_allowed: string[];
  owner_hours_per_month?: number;
  excluded_niche_tags?: string[];
  target_monthly_profit_usd?: number;
  target_year?: number;
  [k: string]: unknown;
}

export interface BuildInput {
  niche: { slug: string; name: string; model: NicheModelSpec };
  template: CostTemplate;
  location: { slug: string; name: string; country_code: string };
  ledger: Ledger;
  profile: ProfileParams;
  tenure: Tenure;
}

export interface BuildOutput {
  model: BusinessModel;
  tenure: Tenure;
  usedAssumptionIds: string[];
  /** Ledger keys the model needed but could not find; a fallback was used. */
  missing: string[];
  /** Keys used whose values are estimates or low confidence. */
  weakInputs: string[];
}

/** Widen a ledger value into a range: explicit low/high, else by confidence. */
export function ledgerTri(v: LedgerValue): Tri {
  const mode = v.value_num ?? 0;
  if (v.low !== null || v.high !== null) {
    return normalizeTri({ low: v.low ?? mode, mode, high: v.high ?? mode });
  }
  const spread = v.confidence === 'high' ? 0 : v.confidence === 'medium' ? 0.1 : 0.25;
  return { low: mode * (1 - spread), mode, high: mode * (1 + spread) };
}

function mul(a: Tri, b: Tri): Tri {
  return normalizeTri({ low: a.low * b.low, mode: a.mode * b.mode, high: a.high * b.high });
}

function scaleTri(a: Tri, k: number): Tri {
  return { low: a.low * k, mode: a.mode * k, high: a.high * k };
}

function clampTri(a: Tri, lo: number, hi: number): Tri {
  const c = (n: number) => Math.min(hi, Math.max(lo, n));
  return { low: c(a.low), mode: c(a.mode), high: c(a.high) };
}

export function buildModel(input: BuildInput): BuildOutput {
  const { niche, template, location, ledger, profile, tenure } = input;
  const spec = niche.model;
  const used = new Set<string>();
  const missing: string[] = [];
  const weak = new Set<string>();

  const read = (key: string, fallback: Tri): Tri => {
    const v = ledger.get(key);
    if (!v || v.value_num === null) {
      missing.push(key);
      return fallback;
    }
    used.add(v.id);
    if (v.confidence === 'low' || v.written_by.includes('estimate') || v.is_stale) weak.add(key);
    return ledgerTri(v);
  };
  const readMode = (key: string, fallback: number) => normalizeTri(read(key, point(fallback))).mode;

  const priceIndex = read('price.index', point(1));
  const buildIndex = read('build.cost_index', point(1));
  const equipmentIndex = read('equipment.cost_index', point(1));
  const wage = read('labor.monthly_wage_usd', point(2800));
  const demand = readMode('demand.multiplier', 1);
  const scaled = (t: Tri, s: Scale | undefined): Tri =>
    s === 'build' ? mul(t, buildIndex) : s === 'equipment' ? mul(t, equipmentIndex) : s === 'price' ? mul(t, priceIndex) : t;

  // Revenue streams: niche defaults, localised by price index and demand, overridden by pairing research.
  const streams: RevenueStream[] = spec.streams.map((s) => {
    const priceOverride = ledger.get(`price.${s.key}_usd`);
    const price = priceOverride?.value_num != null ? (used.add(priceOverride.id), ledgerTri(priceOverride)) : mul(s.price, priceIndex);
    const matureOverride = ledger.get(`occupancy.${s.key}.mature`);
    const mature = matureOverride?.value_num != null
      ? (used.add(matureOverride.id), ledgerTri(matureOverride))
      : clampTri(scaleTri(s.matureOccupancy, demand), 0, 0.95);
    const startOverride = ledger.get(`occupancy.${s.key}.start`);
    const start = startOverride?.value_num != null
      ? (used.add(startOverride.id), ledgerTri(startOverride))
      : clampTri(scaleTri(s.startOccupancy, demand), 0, 0.95);
    const unitsOverride = ledger.get(`units.${s.key}`);
    const units = unitsOverride?.value_num != null ? (used.add(unitsOverride.id), unitsOverride.value_num) : s.units;
    const flat = s.units * s.sellablePerUnitPerMonth <= 1;
    return {
      key: s.key,
      label: s.label,
      units,
      sellablePerUnitPerMonth: s.sellablePerUnitPerMonth,
      price,
      // A flat monthly stream (one unit) is not scaled by demand.
      startOccupancy: flat ? s.startOccupancy : start,
      matureOccupancy: flat ? s.matureOccupancy : mature,
      monthsToMature: s.monthsToMature,
      ownerHoursPerSale: s.ownerHoursPerSale,
      seasonality: s.seasonality,
    };
  });
  const unitsByStream: Record<string, number> = Object.fromEntries(streams.map((s) => [s.key, s.units]));

  // Startup costs.
  const startup: CostLine[] = [];
  let landValue = 0;
  let buildingValue = 0;
  const lease = tenure === 'lease' ? read('lease.finca_monthly_usd', point(3000)) : point(0);
  if (tenure === 'own') {
    const perAcre = read('land.price_per_acre_usd', point(20000));
    const land = scaleTri(perAcre, template.land_acres);
    landValue = normalizeTri(land).mode;
    startup.push({ key: 'land', label: `Land (${template.land_acres} acres)`, amount: land });
  }
  for (const item of template.items) {
    if (item.applies !== 'both' && item.applies !== tenure) continue;
    if (item.leaseMonths) {
      startup.push({ key: item.key, label: item.label, amount: scaleTri(lease, item.leaseMonths) });
      continue;
    }
    if (!item.usd) continue;
    const qty = item.qtyFrom ? unitsByStream[item.qtyFrom] ?? 1 : item.qty ?? 1;
    const amount = scaleTri(scaled(item.usd, item.scale), qty);
    if (tenure === 'own' && item.scale === 'build') buildingValue += normalizeTri(amount).mode;
    startup.push({ key: item.key, label: item.label, amount });
  }

  // Monthly costs.
  const fixed: MonthlyCost[] = spec.fixed
    .filter((f) => f.applies === 'both' || f.applies === tenure)
    .map((f) => ({ key: f.key, label: f.label, amount: scaled(f.usd, f.scale) }));
  if (tenure === 'lease') fixed.unshift({ key: 'lease', label: 'Lease', amount: lease });
  const staffing: MonthlyCost[] = spec.staffing.map((s) => ({
    key: s.key,
    label: s.label,
    amount: mul(s.wageMultiple, wage),
    fromMonth: s.fromMonth ?? 1,
  }));
  const perSaleCost: Record<string, Tri> = {};
  for (const [k, v] of Object.entries(spec.perSale)) perSaleCost[k] = scaled(v.usd, v.scale);

  // Financing.
  const loanAllowed = profile.financing_allowed.some((f) => ['sba', 'usda', 'local_bank'].includes(f));
  const isUs = location.country_code === 'US';
  const ownerCash = profile.capital_usd.max;
  let financing: BusinessModel['financing'] = { kind: tenure === 'lease' ? 'lease' : 'cash', ownerCash };
  if (tenure === 'own' && loanAllowed && isUs) {
    financing = {
      kind: 'loan',
      ownerCash,
      minEquityPct: readMode('finance.min_equity_pct', 0.2),
      ratePct: readMode('finance.rate_pct', 8.5),
      termYears: 25,
    };
  }

  const exit = spec.exit;
  const model: BusinessModel = {
    label: `${niche.name} · ${tenure === 'own' ? 'owned' : 'leased'} · ${location.name}`,
    startupCosts: startup,
    contingencyPct: tenure === 'own' ? { low: 0.1, mode: 0.15, high: 0.25 } : { low: 0.1, mode: 0.12, high: 0.2 },
    workingCapitalMonths: 6,
    financing,
    streams,
    costs: {
      fixed,
      staffing,
      variablePctOfRevenue: spec.variablePct,
      perSaleCost,
      revenueTaxPct: read('tax.revenue_pct', point(0)),
    },
    exit: {
      sdeMultiple: exit.sdeMultiple,
      ebitdaMultiple: exit.ebitdaMultiple,
      managerMonthlyCost: scaleTri(wage, exit.managerWageMultiple),
      ownsProperty: tenure === 'own',
      landValue,
      buildingValue,
      landAppreciation: read('land.appreciation_pct', { low: 0.01, mode: 0.03, high: 0.05 }),
      buildingLifeYears: 30,
      sellingCostPct: 0.08,
      ownerDependenceDiscount: 0.15,
      countryDiscount: readMode('exit.country_discount', 0.1),
    },
    capacity: { ownerHoursPerMonth: profile.owner_hours_per_month ?? 220, ownerFixedHoursPerMonth: spec.ownerFixedHours },
  };
  // land.appreciation_pct and equipment.cost_index are optional refinements, not gaps.
  const optional = new Set(['land.appreciation_pct', 'equipment.cost_index']);
  return {
    model,
    tenure,
    usedAssumptionIds: [...used],
    missing: missing.filter((k) => !optional.has(k)),
    weakInputs: [...weak],
  };
}
