// What a business is, in plain terms, and the checks that tie that description
// to the money model. Pure functions (no I/O) so the app page, the drafting
// agent and the tests share them.
import type { AnalysisResult, BusinessModel } from './engine/types.ts';

/** A plain description of the business: what a guest gets, what the owner builds and owns. */
export interface Concept {
  /** One sentence: what the business is. */
  pitch: string;
  /** Two or three sentences: how a visit works and how it makes money. */
  overview: string;
  /** Who the customers are. */
  who: string;
  /** A guest's visit, in 4-6 steps. */
  journey: { title: string; text: string }[];
  /** Physical things the owner builds or buys. */
  assets: { name: string; note: string }[];
  /** What guests get. stream_key names the money-model stream that prices it, or '' when it is not priced yet. */
  features: { name: string; what: string; earns: string; needs: string; stream_key: string }[];
  /** Who drafted it and when. */
  drafted_by?: string;
  drafted_at?: string;
}

export interface FeatureView {
  name: string;
  what: string;
  earns: string;
  needs: string;
  /** true when a stream in the money model prices it. */
  priced: boolean;
}

/**
 * Guest features, with every priced stream listed first. A stream the concept
 * does not mention still appears (from the model), so nothing priced is hidden.
 */
export function featuresFor(concept: Concept | null | undefined, streams: { key: string; label: string; price: { mode: number } }[]): FeatureView[] {
  const keys = new Set(streams.map((s) => s.key));
  const fromConcept = (concept?.features ?? []).map((f) => ({ name: f.name, what: f.what, earns: f.earns, needs: f.needs, priced: Boolean(f.stream_key) && keys.has(f.stream_key), key: f.stream_key }));
  const covered = new Set(fromConcept.filter((f) => f.priced).map((f) => f.key));
  const fromModel = streams
    .filter((s) => !covered.has(s.key))
    .map((s) => ({ name: s.label, what: '', earns: `$${Math.round(s.price.mode).toLocaleString('en-US')} each`, needs: '', priced: true, key: s.key }));
  return [...fromConcept.filter((f) => f.priced), ...fromModel, ...fromConcept.filter((f) => !f.priced)].map(({ key: _key, ...f }) => f);
}

export type Tenure = 'own' | 'lease' | 'ground';

/** What an input is used for under a plan, and whether to show it by default. */
export function inputUse(key: string, tenure: Tenure | undefined, value: number | null | undefined): { use: string; relevant: boolean } {
  const neutral = value === 1 || value === 0;
  switch (key) {
    case 'lease.finca_monthly_usd':
      return tenure === 'lease'
        ? { use: 'Your rent', relevant: true }
        : { use: 'What the property would rent for: values it when you sell', relevant: true };
    case 'lease.commercial_monthly_usd':
    case 'lease.estate_monthly_usd':
      return { use: tenure === 'lease' ? 'Your rent' : 'Lease plan only', relevant: tenure === 'lease' };
    case 'lease.land_monthly_usd_per_acre':
    case 'lease.ground_rent_yield_pct':
      return { use: tenure === 'ground' ? 'Your land rent' : 'Rent-the-land plan only', relevant: tenure === 'ground' };
    case 'land.price_per_acre_usd':
      return { use: tenure === 'own' ? 'Land cost' : tenure === 'ground' ? 'Sets the land rent' : 'Own plan only', relevant: tenure !== 'lease' };
    case 'land.appreciation_pct':
      return { use: 'Land value at sale', relevant: tenure === 'own' };
    case 'build.cost_index':
    case 'price.index':
    case 'price.index_destination':
    case 'tax.revenue_pct':
    case 'exit.country_discount':
      return { use: neutral ? 'Baseline (no adjustment)' : 'Country adjustment', relevant: !neutral };
    case 'finance.seller_down_pct':
    case 'finance.seller_rate_pct':
    case 'finance.seller_term_years':
      return { use: 'Seller financing', relevant: tenure === 'own' };
    case 'finance.rate_pct':
      return { use: 'Loan payment', relevant: true };
    case 'finance.min_equity_pct':
    case 'finance.sba_min_equity_pct':
      return { use: 'Your cash', relevant: true };
    case 'labor.monthly_wage_usd':
      return { use: 'Staff and paid help', relevant: true };
    case 'tax.income_effective_pct':
      return { use: 'Take-home', relevant: true };
    case 'demand.population_40min':
    case 'demand.multiplier':
    case 'demand.competitors_60min':
      return { use: 'Demand', relevant: true };
    case 'demand.seasonality':
      return { use: 'Monthly revenue', relevant: true };
    case 'site.acres':
      return { use: 'Lot size: land cost', relevant: tenure !== 'lease' };
    default:
      if (key.startsWith('capex.')) return { use: 'Start-up cost', relevant: tenure !== 'lease' };
      if (key.startsWith('price.')) return { use: 'Price', relevant: true };
      if (key.startsWith('occupancy.')) return { use: 'Bookings', relevant: true };
      return { use: '', relevant: true };
  }
}

export interface CheckInput {
  tenure: Tenure | undefined;
  model: BusinessModel;
  result: AnalysisResult;
  /** The niche's write-up. */
  card: { staffing?: string; permits?: string[]; prerequisites?: string[]; structures?: string };
  /** The owner's parameters. */
  profile: { live_on_site?: boolean; housing_cost_usd?: number; home_build_usd?: number };
}

const PUBLIC_BATHING = /public (bathing|showers?|pool|spa)|bathing|bathhouse|pool rules|showers/i;
const ATTENDED = /attendant|lifeguard|on duty|staffed|during open hours/i;
/** Below this, a build with public showers, changing rooms and wet areas is unlikely (USD, excluding land). */
export const PUBLIC_BATHING_MIN_BUILD = 350_000;

/** Checks that compare the model with what the business needs. Each returns a plain warning. */
export function ideaChecks(i: CheckInput): string[] {
  const out: string[] = [];
  const { model, result: r, card, profile } = i;

  // Living on site: the saving is counted; the home must be too.
  if (i.tenure === 'own' && profile.live_on_site && !(Number(profile.home_build_usd) > 0)) {
    out.push(
      Number(profile.housing_cost_usd) > 0
        ? 'The lender test counts the rent you save by living on site, but not the cost of building your home. Add your home budget in Settings.'
        : 'You plan to live on site, but your home is not budgeted. Add your home budget in Settings.',
    );
  }

  // Attended opening hours.
  if (ATTENDED.test(card.staffing ?? '')) {
    const open = model.capacity?.openHoursPerMonth ?? 0;
    const wage = 173; // hours in one full-time month
    const staffHours = model.costs.staffing.length * wage;
    const covered = (r.capacity.limit ?? model.capacity?.ownerHoursPerMonth ?? 220) + r.capacity.paidHelpHoursP50 + staffHours;
    if (open <= 0) out.push('Someone must be on duty whenever it is open, but the model has no opening hours, so staff cost may be missing.');
    else if (covered < open) out.push(`It needs someone on duty ${Math.round(open)} hours a month; you plus paid help cover about ${Math.round(covered)}.`);
  }

  // Public bathing facilities cost more than a private build.
  const text = [card.structures ?? '', ...(card.permits ?? []), ...(card.prerequisites ?? [])].join(' ');
  if (i.tenure !== 'lease' && PUBLIC_BATHING.test(text)) {
    const build = r.startup.lines.filter((l) => l.key !== 'land').reduce((a, l) => a + l.p50, 0);
    if (build < PUBLIC_BATHING_MIN_BUILD) {
      out.push(`Building costs of $${Math.round(build).toLocaleString('en-US')} look light for public showers, changing rooms and wet areas; commercial plumbing, septic and accessible restrooms usually cost more.`);
    }
  }
  return out;
}

/** Your total cash when you also build your home on the land (personal, not part of the business). */
export function cashWithHome(cashNeeded: number, tenure: Tenure | undefined, profile: { live_on_site?: boolean; home_build_usd?: number }): number | null {
  const home = Number(profile.home_build_usd);
  if (tenure !== 'own' || !profile.live_on_site || !(home > 0)) return null;
  return cashNeeded + home;
}
