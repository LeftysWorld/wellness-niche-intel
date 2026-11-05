// Core types for the deterministic calculation engine.
// The engine is pure TypeScript with no runtime dependencies so it runs in
// Supabase Edge Functions (Deno), the dashboard (browser) and tests (Node).
// All money is in USD per month unless a field says otherwise.

/** A three-point estimate: pessimistic, most likely, optimistic. */
export interface Tri {
  low: number;
  mode: number;
  high: number;
}

/** Points to the ledger entry a number came from, so results are traceable. */
export interface Provenance {
  assumptionId?: string;
  sourceUrl?: string;
  note?: string;
}

export interface CostLine extends Provenance {
  key: string;
  label: string;
  /** One-time cost in USD. */
  amount: Tri;
}

export type FinancingKind = 'cash' | 'loan' | 'lease';

export interface Financing {
  kind: FinancingKind;
  /** Owner cash available (USD). */
  ownerCash: number;
  /** Minimum share of total project cost the owner must inject (0..1). */
  minEquityPct?: number;
  /** Annual interest rate, percent (e.g. 8.5). */
  ratePct?: number;
  /** Loan term in years. */
  termYears?: number;
}

export interface RevenueStream extends Provenance {
  key: string;
  label: string;
  /** Number of sellable units (rooms, sauna slots, sites). */
  units: number;
  /** Sellable unit-periods per unit per month (e.g. 25 nights per room). */
  sellablePerUnitPerMonth: number;
  /** Price per unit-period (USD). */
  price: Tri;
  /** Occupancy in month 1 (0..1). */
  startOccupancy: Tri;
  /** Occupancy once mature (0..1). */
  matureOccupancy: Tri;
  /** Months from launch to reach mature occupancy. */
  monthsToMature: Tri;
  /** Optional 12 multipliers, January first. Defaults to 1 for every month. */
  seasonality?: number[];
  /** Owner hours needed per unit-period sold (for the capacity check). */
  ownerHoursPerSale?: number;
}

export interface MonthlyCost extends Provenance {
  key: string;
  label: string;
  amount: Tri;
  /** Month the cost starts (1-based). Defaults to 1. */
  fromMonth?: number;
  /** Optional growth per year as a fraction (e.g. 0.05 for 5% a year). */
  annualGrowth?: number;
}

export interface OperatingCosts {
  /** Fixed monthly costs: rent, insurance, utilities base, software. */
  fixed: MonthlyCost[];
  /** Staffing steps; each applies from its month onward and replaces earlier steps with the same key. */
  staffing: MonthlyCost[];
  /** Variable cost as a share of revenue (commissions, payment fees, supplies). */
  variablePctOfRevenue: Tri;
  /** Cost per unit-period sold, keyed by stream (e.g. food per guest-night). */
  perSaleCost: Record<string, Tri>;
  /** Taxes charged on gross revenue (e.g. simplified regimes), as a share. */
  revenueTaxPct: Tri;
}

export interface ExitAssumptions {
  /** Multiple of annual owner earnings (SDE). */
  sdeMultiple: Tri;
  /** Multiple of annual EBITDA after a market-rate manager. */
  ebitdaMultiple: Tri;
  /** Monthly cost of a market-rate manager, used for EBITDA. */
  managerMonthlyCost: Tri;
  /** Whether land and buildings are owned (adds asset value). */
  ownsProperty: boolean;
  /** Land value at purchase (USD), if owned. */
  landValue: number;
  /** Depreciable build cost (USD), if owned. */
  buildingValue: number;
  /** Annual land appreciation as a fraction. */
  landAppreciation: Tri;
  /** Years over which buildings depreciate to zero. */
  buildingLifeYears: number;
  /** Selling costs (broker, legal) as a share of price. */
  sellingCostPct: number;
  /** Discount for dependence on the owner (0..1). */
  ownerDependenceDiscount: number;
  /** Discount for country risk: thin buyer pool, currency, title (0..1). */
  countryDiscount: number;
}

export interface CapacityLimits {
  /** Hours one operator can work per month. */
  ownerHoursPerMonth: number;
  /** Fixed owner hours per month (admin, marketing, maintenance). */
  ownerFixedHoursPerMonth: number;
}

export interface BusinessModel {
  pairingId?: string;
  label: string;
  startupCosts: CostLine[];
  /** Contingency as a share of startup costs. */
  contingencyPct: Tri;
  /** Months of fixed costs to hold as opening cash. */
  workingCapitalMonths: number;
  financing: Financing;
  streams: RevenueStream[];
  costs: OperatingCosts;
  exit: ExitAssumptions;
  capacity?: CapacityLimits;
  /** First calendar month of operation (1 = January). Defaults to 1. */
  startCalendarMonth?: number;
  /** Months to simulate. Defaults to 60. */
  horizonMonths?: number;
}

export interface Percentiles {
  p10: number;
  p50: number;
  p90: number;
}

export interface MonthSnapshot {
  revenue: Percentiles;
  costs: Percentiles;
  profit: Percentiles;
}

export interface StartupResult {
  /** Total project cost including contingency and working capital. */
  total: Percentiles;
  lines: { key: string; label: string; p50: number }[];
  contingencyP50: number;
  workingCapitalP50: number;
  /** Cash the owner puts in (P50 case). */
  ownerEquityP50: number;
  loanAmountP50: number;
  monthlyDebtPaymentP50: number;
  /** True if owner cash covers the required equity in the P50 case. */
  fundable: boolean;
  fundingNote: string;
}

export interface ValuationResult {
  year: number;
  /** Net proceeds after selling costs and debt payoff. */
  netProceeds: Percentiles;
  price: Percentiles;
  method: 'sde' | 'ebitda' | 'asset';
}

export interface SensitivityItem {
  input: string;
  lowProfit: number;
  highProfit: number;
  swing: number;
}

export interface AnalysisResult {
  label: string;
  simulations: number;
  seed: number;
  startup: StartupResult;
  month12: MonthSnapshot;
  month36: MonthSnapshot;
  month60: MonthSnapshot;
  /** Median month in which monthly profit first turns positive (null if never). */
  breakEvenMonthP50: number | null;
  /** Lowest cumulative cash position, P10 (worst realistic case) and P50. */
  cashLowPoint: { p10: number; p50: number };
  valuation: ValuationResult[];
  /** Total return on owner cash at year 5 (profits taken + net sale) / equity. */
  totalReturnYear5: Percentiles;
  sensitivity: SensitivityItem[];
  capacity: { peakOwnerHoursP50: number; limit: number | null; exceeded: boolean };
  warnings: string[];
}
