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
  /** Debt-service coverage a lender requires: operating profit / loan payment. Defaults to 1.25. */
  minDscr?: number;
  /** Most the lender will lend (e.g. seller financing covers only the land). */
  maxLoan?: number;
  /** Who lends, for the notes (e.g. "SBA 7(a)", "the land seller"). */
  lender?: string;
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
  /** Who buys: people living nearby (local) or travellers (destination). Used by the model builder. */
  market?: 'local' | 'destination';
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
  /** Repairs and replacement reserve as a share of revenue. */
  reservePctOfRevenue?: Tri;
  /** Effective income and self-employment tax on positive monthly profit, as a share. */
  incomeTaxPct?: Tri;
  /** Hourly cost of paid help that covers hours beyond the owner's limit (solo operators). */
  hourlyWage?: Tri;
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
  /** Market rent for the site; an owned business is valued as if it paid this, plus the property. */
  marketRentMonthly?: number;
}

export interface CapacityLimits {
  /** Hours one operator can work per month. */
  ownerHoursPerMonth: number;
  /** Fixed owner hours per month (admin, marketing, maintenance). */
  ownerFixedHoursPerMonth: number;
  /** Hours per month someone must be on site because the business is open. */
  openHoursPerMonth?: number;
}

export interface PreOpening {
  /** Months from start of build or fit-out to opening day. */
  months: Tri;
  /** Share of non-rent fixed costs paid while not yet open (insurance, utilities). */
  fixedShare: number;
}

export interface BusinessModel {
  pairingId?: string;
  label: string;
  startupCosts: CostLine[];
  /** Contingency as a share of startup costs. */
  contingencyPct: Tri;
  /** Months of fixed costs held as an opening buffer (the cash dip is added on top). */
  workingCapitalMonths: number;
  /** Build, permits and fit-out before opening: no revenue, rent and interest still due. */
  preOpening?: PreOpening;
  financing: Financing;
  streams: RevenueStream[];
  costs: OperatingCosts;
  exit: ExitAssumptions;
  capacity?: CapacityLimits;
  /** Calendar month the project starts (1 = January); opening is this plus the pre-opening months. */
  startCalendarMonth?: number;
  /** Months to simulate. Defaults to 60. */
  horizonMonths?: number;
  /** Living on site: the owner's current housing cost that they would no longer pay (USD/month). */
  ownerHousingSavedMonthly?: number;
}

export interface Percentiles {
  p10: number;
  p50: number;
  p90: number;
}

export interface MonthSnapshot {
  /** Monthly averages over one operating year. */
  revenue: Percentiles;
  costs: Percentiles;
  /** After loan payments, before income tax. */
  profit: Percentiles;
  /** After loan payments and estimated income tax: what the owner keeps. */
  takeHome: Percentiles;
  /** Take-home plus the housing cost living on site saves (equals takeHome when not living on site). */
  takeHomeWithHousing: Percentiles;
}

export interface StartupResult {
  /** Project cost: build/fit-out, contingency and an opening buffer. */
  total: Percentiles;
  lines: { key: string; label: string; p50: number }[];
  contingencyP50: number;
  workingCapitalP50: number;
  /** Rent, interest and running costs before opening (P50). */
  preOpeningCostP50: number;
  preOpeningMonthsP50: number;
  /** Cash the owner puts into the project (P50 case). */
  ownerEquityP50: number;
  loanAmountP50: number;
  monthlyDebtPaymentP50: number;
  /** Owner equity plus the cash needed to ride out the dip before profits arrive. */
  cashNeeded: Percentiles;
  /** True if owner cash covers equity plus the P50 cash dip, and any loan passes the lender test. */
  fundable: boolean;
  fundingNote: string;
}

export interface LenderTest {
  applies: boolean;
  /** Years 1-2 average operating profit before loan payments / loan payment (P50). */
  dscrP50: number | null;
  required: number;
  bankable: boolean;
  note: string;
}

export interface ValuationResult {
  year: number;
  /** Net proceeds after selling costs and debt payoff. */
  netProceeds: Percentiles;
  price: Percentiles;
  /** How the business part was valued; property is added on top when owned. */
  method: 'sde' | 'ebitda' | 'asset';
  propertyValueP50: number;
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
  lender: LenderTest;
  /** Monthly averages over operating years 1, 3 and 5 (year 1 starts on opening day). */
  year1: MonthSnapshot;
  year3: MonthSnapshot;
  year5: MonthSnapshot;
  /** Median operating month in which take-home first turns positive (null if never). */
  breakEvenMonthP50: number | null;
  /** Lowest business cash position from project start, P10 (worst realistic case) and P50. */
  cashLowPoint: { p10: number; p50: number };
  valuation: ValuationResult[];
  /** Total return on owner cash at year 5 (take-home + net sale) / cash needed. */
  totalReturnYear5: Percentiles;
  sensitivity: SensitivityItem[];
  capacity: {
    peakOwnerHoursP50: number;
    limit: number | null;
    /** Hours per month paid help covers at maturity (P50); 0 = the owner runs it alone. */
    paidHelpHoursP50: number;
    paidHelpCostP50: number;
    needsHelp: boolean;
  };
  warnings: string[];
}
