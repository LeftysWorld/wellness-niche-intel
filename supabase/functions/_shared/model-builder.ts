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
  /** Who buys: people living nearby, or travellers. Defaults from requiresPopulation. */
  market?: 'local' | 'destination';
}

/** What kind of site the niche needs, which decides which lease applies. */
export type SiteType = 'house' | 'commercial' | 'estate';

export interface NicheModelSpec {
  basis?: string;
  /** Admin, marketing and upkeep hours per month. */
  ownerFixedHours: number;
  /** Hours per month someone must be on site because the business is open. */
  openHoursPerMonth?: number;
  /** Months from start to opening, by tenure (ground uses own: the structures still get built). */
  buildMonths?: { own?: Tri; lease?: Tri; ground?: Tri };
  /** house: a rentable home with rooms; commercial: public-facing use; estate: large acreage with buildings. */
  siteType?: SiteType;
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
/** own = buy land and build; lease = rent an existing property and convert it; ground = rent land and put up your own structures. */
export type Tenure = 'own' | 'lease' | 'ground';

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
  /** Pay cash even where a loan is allowed (used when a loan fails the lender test). */
  financingOverride?: 'cash';
  /** Calendar month the project would start (1-12). Defaults to the current month. */
  startMonth?: number;
}

/** Where each input came from, so results can say what is sourced and what is guessed. */
export interface Evidence {
  sourced: string[];
  guessed: string[];
  missing: string[];
  /** Share of place inputs that are sourced (0-1). */
  sourcedShare: number;
  /** True when the niche's own economics are an AI draft or starting estimate. */
  nicheGuessed: boolean;
}

/** Rent for the site is always added from the place's ledger value, never from a niche's own cost list. */
const RENT_LINE = /\b(lease|rent|renta|arriendo|alquiler)\b/i;

export interface BuildOutput {
  model: BusinessModel;
  tenure: Tenure;
  evidence: Evidence;
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

/** Lease key and fallback multiple of the house lease, by the kind of site a niche needs. */
const LEASE_BY_SITE: Record<SiteType, { key: string; vsHouse: number }> = {
  house: { key: 'lease.finca_monthly_usd', vsHouse: 1 },
  commercial: { key: 'lease.commercial_monthly_usd', vsHouse: 1.4 },
  estate: { key: 'lease.estate_monthly_usd', vsHouse: 2.5 },
};

const DEFAULT_BUILD_MONTHS: Record<Tenure, Tri> = {
  own: { low: 6, mode: 10, high: 18 },
  lease: { low: 2, mode: 3, high: 6 },
  // Structures still get built and permitted, but there is no land purchase.
  ground: { low: 5, mode: 8, high: 14 },
};

/** Monthly hours in a full-time job, for turning a monthly wage into an hourly one. */
const HOURS_PER_FTE = 173;

/** Lenders want more equity from a business with no operating history. */

function parseCurve(v: LedgerValue | undefined): number[] | undefined {
  if (!v?.value_text) return undefined;
  try {
    const arr = JSON.parse(v.value_text);
    if (!Array.isArray(arr) || arr.length !== 12 || arr.some((x) => typeof x !== 'number' || x < 0)) return undefined;
    const mean = arr.reduce((a: number, b: number) => a + b, 0) / 12;
    return mean > 0 ? arr.map((x: number) => x / mean) : undefined;
  } catch {
    return undefined;
  }
}

export function isEstimate(v: LedgerValue): boolean {
  return v.written_by.includes('estimate') || !v.source_url;
}

export function buildModel(input: BuildInput): BuildOutput {
  const { niche, template, location, ledger, profile, tenure } = input;
  const spec = niche.model;
  const used = new Set<string>();
  const missing: string[] = [];
  const weak = new Set<string>();
  const sourced = new Set<string>();
  const guessed = new Set<string>();

  const note = (key: string, v: LedgerValue) => {
    used.add(v.id);
    if (v.written_by === 'user' || !isEstimate(v)) sourced.add(key);
    else guessed.add(key);
    if (v.confidence === 'low' || isEstimate(v) || v.is_stale) weak.add(key);
  };
  const read = (key: string, fallback: Tri): Tri => {
    const v = ledger.get(key);
    if (!v || v.value_num === null) {
      missing.push(key);
      return fallback;
    }
    note(key, v);
    return ledgerTri(v);
  };
  const readMode = (key: string, fallback: number) => normalizeTri(read(key, point(fallback))).mode;
  const has = (key: string) => ledger.get(key)?.value_num != null;

  // Prices: what locals pay vs what travellers pay can differ a lot (e.g. Colombia).
  const priceLocal = read('price.index', point(1));
  const priceDestination = has('price.index_destination') ? read('price.index_destination', point(1)) : priceLocal;
  const buildIndex = read('build.cost_index', point(1));
  const equipmentIndex = has('equipment.cost_index') ? read('equipment.cost_index', point(1)) : point(1);
  const wage = read('labor.monthly_wage_usd', point(2800));

  // Demand: travellers vs people living within ~40 minutes.
  const destinationDemand = has('demand.destination_multiplier') ? readMode('demand.destination_multiplier', 1) : readMode('demand.multiplier', 1);
  const population = has('demand.population_40min') ? readMode('demand.population_40min', 0) : null;
  const localDemand = population !== null ? Math.min(1.3, Math.max(0.3, Math.sqrt(population / 400000))) : destinationDemand;
  const curve = parseCurve(ledger.get('demand.seasonality'));
  if (ledger.get('demand.seasonality')) note('demand.seasonality', ledger.get('demand.seasonality')!);
  // Locals are steadier through the year than travellers.
  const localCurve = curve?.map((x) => Math.sqrt(x));

  const scaled = (t: Tri, s: Scale | undefined): Tri =>
    s === 'build' ? mul(t, buildIndex) : s === 'equipment' ? mul(t, equipmentIndex) : s === 'price' ? mul(t, priceLocal) : t;

  // Revenue streams: niche defaults, localised by market, overridden by pairing research.
  const streams: RevenueStream[] = spec.streams.map((s) => {
    const market = s.market ?? (spec.requiresPopulation ? 'local' : 'destination');
    const demand = market === 'local' ? localDemand : destinationDemand;
    const priceIndex = market === 'local' ? priceLocal : priceDestination;
    const priceOverride = ledger.get(`price.${s.key}_usd`);
    const price = priceOverride?.value_num != null ? (note(`price.${s.key}_usd`, priceOverride), ledgerTri(priceOverride)) : mul(s.price, priceIndex);
    const matureOverride = ledger.get(`occupancy.${s.key}.mature`);
    const mature = matureOverride?.value_num != null
      ? (note(`occupancy.${s.key}.mature`, matureOverride), ledgerTri(matureOverride))
      : clampTri(scaleTri(s.matureOccupancy, demand), 0, 0.95);
    const startOverride = ledger.get(`occupancy.${s.key}.start`);
    const start = startOverride?.value_num != null
      ? (note(`occupancy.${s.key}.start`, startOverride), ledgerTri(startOverride))
      : clampTri(scaleTri(s.startOccupancy, demand), 0, 0.95);
    const unitsOverride = ledger.get(`units.${s.key}`);
    const units = unitsOverride?.value_num != null ? (note(`units.${s.key}`, unitsOverride), unitsOverride.value_num) : s.units;
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
      seasonality: s.seasonality ?? (market === 'local' ? localCurve : curve),
      market,
    };
  });
  const unitsByStream: Record<string, number> = Object.fromEntries(streams.map((s) => [s.key, s.units]));

  // Rent for the kind of site this niche needs. Also used as market rent when the site is owned.
  const site = LEASE_BY_SITE[spec.siteType ?? 'house'];
  const house = read('lease.finca_monthly_usd', point(3000));
  const siteRent = site.key === 'lease.finca_monthly_usd' ? house : has(site.key) ? read(site.key, house) : (missing.push(site.key), scaleTri(house, site.vsHouse));

  // Startup costs.
  const startup: CostLine[] = [];
  let landValue = 0;
  let buildingValue = 0;
  // Building your own structures on rented land uses the same build items as owning.
  const builds = tenure === 'own' || tenure === 'ground';
  const appliesTo = (a: Applies) => a === 'both' || a === (builds ? 'own' : 'lease');
  // Ground rent: scouted rent per acre, else a typical yield on the land's value.
  const groundRent = (): Tri => {
    if (has('lease.land_monthly_usd_per_acre')) return scaleTri(read('lease.land_monthly_usd_per_acre', point(50)), template.land_acres);
    missing.push('lease.land_monthly_usd_per_acre');
    const perAcre = read('land.price_per_acre_usd', point(20000));
    const yieldPct = has('lease.ground_rent_yield_pct') ? read('lease.ground_rent_yield_pct', point(0.06)) : { low: 0.04, mode: 0.06, high: 0.08 };
    return scaleTri(scaleTri(perAcre, normalizeTri(yieldPct).mode / 12), template.land_acres);
  };
  const lease = tenure === 'lease' ? siteRent : tenure === 'ground' ? groundRent() : point(0);
  if (tenure === 'own') {
    const perAcre = read('land.price_per_acre_usd', point(20000));
    const land = scaleTri(perAcre, template.land_acres);
    landValue = normalizeTri(land).mode;
    startup.push({ key: 'land', label: `Land (${template.land_acres} acres)`, amount: land });
  }
  if (tenure === 'ground') startup.push({ key: 'ground_deposit', label: 'Land lease deposit (2 months)', amount: scaleTri(lease, 2) });
  for (const item of template.items) {
    if (!appliesTo(item.applies)) continue;
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
    .filter((f) => appliesTo(f.applies))
    .filter((f) => !RENT_LINE.test(`${f.key} ${f.label}`))
    .map((f) => ({ key: f.key, label: f.label, amount: scaled(f.usd, f.scale) }));
  if (tenure === 'lease') fixed.unshift({ key: 'lease', label: 'Lease', amount: lease });
  if (tenure === 'ground') fixed.unshift({ key: 'ground_rent', label: `Land rent (${template.land_acres} acres)`, amount: lease });
  // A solo owner does the work; any hours beyond their limit are paid for by the hour.
  // A team-run business carries the niche's own staff lines instead.
  const solo = String(profile.operator_model ?? 'solo') === 'solo';
  const staffing: MonthlyCost[] = (solo ? [] : spec.staffing).map((s) => ({
    key: s.key,
    label: s.label,
    amount: mul(s.wageMultiple, wage),
    fromMonth: s.fromMonth ?? 1,
  }));
  const perSaleCost: Record<string, Tri> = {};
  for (const [k, v] of Object.entries(spec.perSale)) perSaleCost[k] = scaled(v.usd, v.scale);
  if (spec.openHoursPerMonth === undefined) missing.push('niche.open_hours');

  // Financing.
  const allowed = profile.financing_allowed;
  const bankLoan = allowed.some((f) => ['sba', 'usda', 'local_bank'].includes(f));
  const isUs = location.country_code === 'US';
  const ownerCash = profile.capital_usd.max;
  let financing: BusinessModel['financing'] = { kind: tenure === 'own' ? 'cash' : 'lease', ownerCash };
  if (input.financingOverride !== 'cash') {
    if (isUs && bankLoan) {
      // Lenders ask start-ups for 10-30% down (SBA's floor is 10%); the ledger holds the typical figure.
      const minEquity = Math.max(has('finance.sba_min_equity_pct') ? readMode('finance.sba_min_equity_pct', 0.1) : 0.1, readMode('finance.min_equity_pct', 0.2));
      financing =
        tenure === 'own'
          ? { kind: 'loan', ownerCash, minEquityPct: minEquity, ratePct: readMode('finance.rate_pct', 8.5), termYears: 25, minDscr: 1.25, lender: 'an SBA or bank loan' }
          : // Fit-out, structures and working capital on leased property: SBA 7(a), up to 10 years.
            { kind: 'loan', ownerCash, minEquityPct: minEquity, ratePct: readMode('finance.rate_pct', 8.5) + 0.5, termYears: 10, minDscr: 1.25, lender: 'an SBA 7(a) loan' };
    } else if (!isUs && tenure === 'own' && allowed.includes('seller') && landValue > 0) {
      // Seller financing (common for land in Latin America) covers part of the land only.
      const down = readMode('finance.seller_down_pct', 0.4);
      financing = {
        kind: 'loan',
        ownerCash,
        minEquityPct: 0,
        maxLoan: landValue * (1 - down),
        ratePct: readMode('finance.seller_rate_pct', 8),
        termYears: readMode('finance.seller_term_years', 7),
        minDscr: 0,
        lender: 'the land seller',
      };
    }
  }

  const exit = spec.exit;
  const startMonth = input.startMonth ?? new Date().getMonth() + 1;
  const model: BusinessModel = {
    label: `${niche.name} · ${tenure === 'own' ? 'owned' : tenure === 'ground' ? 'own structures on rented land' : 'leased'} · ${location.name}`,
    startupCosts: startup,
    contingencyPct: builds ? { low: 0.1, mode: 0.15, high: 0.25 } : { low: 0.1, mode: 0.12, high: 0.2 },
    workingCapitalMonths: 3,
    preOpening: { months: spec.buildMonths?.[tenure] ?? (tenure === 'ground' ? spec.buildMonths?.own : undefined) ?? DEFAULT_BUILD_MONTHS[tenure], fixedShare: 0.3 },
    // Living on site: the housing the owner no longer pays elsewhere.
    ownerHousingSavedMonthly: profile.live_on_site && Number(profile.housing_cost_usd) > 0 ? Number(profile.housing_cost_usd) : undefined,
    startCalendarMonth: startMonth,
    financing,
    streams,
    costs: {
      fixed,
      staffing,
      variablePctOfRevenue: spec.variablePct,
      perSaleCost,
      revenueTaxPct: read('tax.revenue_pct', point(0)),
      reservePctOfRevenue: { low: 0.02, mode: 0.03, high: 0.05 },
      incomeTaxPct: read('tax.income_effective_pct', { low: 0.15, mode: 0.22, high: 0.3 }),
      hourlyWage: solo ? scaleTri(wage, 1 / HOURS_PER_FTE) : undefined,
    },
    exit: {
      sdeMultiple: exit.sdeMultiple,
      ebitdaMultiple: exit.ebitdaMultiple,
      managerMonthlyCost: scaleTri(wage, exit.managerWageMultiple),
      ownsProperty: tenure === 'own',
      landValue,
      buildingValue,
      landAppreciation: has('land.appreciation_pct') ? read('land.appreciation_pct', point(0.03)) : { low: 0.01, mode: 0.03, high: 0.05 },
      buildingLifeYears: 30,
      sellingCostPct: 0.08,
      ownerDependenceDiscount: 0.15,
      countryDiscount: readMode('exit.country_discount', 0.1),
      marketRentMonthly: normalizeTri(tenure === 'ground' ? lease : siteRent).mode,
    },
    capacity: {
      ownerHoursPerMonth: profile.owner_hours_per_month ?? 220,
      ownerFixedHoursPerMonth: spec.ownerFixedHours,
      openHoursPerMonth: spec.openHoursPerMonth ?? 0,
    },
  };
  const uniqMissing = [...new Set(missing)];
  const placeKeys = sourced.size + guessed.size + uniqMissing.filter((k) => !k.startsWith('niche.')).length;
  const nicheGuessed = /draft|estimate|initial defaults/i.test(spec.basis ?? '') || spec.openHoursPerMonth === undefined;
  return {
    model,
    tenure,
    evidence: {
      sourced: [...sourced],
      guessed: [...guessed],
      missing: uniqMissing,
      sourcedShare: placeKeys ? Math.round((sourced.size / placeKeys) * 100) / 100 : 0,
      nicheGuessed,
    },
    usedAssumptionIds: [...used],
    missing: uniqMissing,
    weakInputs: [...weak],
  };
}
