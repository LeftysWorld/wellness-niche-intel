// Reading and writing the assumption ledger. Values are never edited: a new
// row is inserted and the database trigger supersedes the previous one.
import { db, must } from './db.ts';
import { mergeLedger, type Ledger, type LedgerValue } from './model-builder.ts';
import type { Run } from './runs.ts';

const COLS = 'id,key,value_num,value_text,low,high,confidence,source_url,written_by,is_stale,subject_type,subject_id';

async function rows(subjectType: string, subjectId: string | null): Promise<LedgerValue[]> {
  let q = db().from('current_assumptions').select(COLS).eq('subject_type', subjectType);
  q = subjectId ? q.eq('subject_id', subjectId) : q.is('subject_id', null);
  return must(await q, `ledger ${subjectType}`) as unknown as LedgerValue[];
}

export interface LocationRow {
  id: string;
  slug: string;
  name: string;
  country_code: string;
  level: 'country' | 'micro_area';
  parent_id: string | null;
  profile: Record<string, unknown>;
  favorite?: boolean;
  notes?: string | null;
  origin?: string;
  fit?: { score?: number; summary?: string; pros?: string[]; cons?: string[] } | null;
}

/** Ledger for a micro-area (with its country and global values), optionally a pairing on top. */
export async function loadLedger(location: LocationRow, pairingId?: string): Promise<Ledger> {
  const layers: Parameters<typeof mergeLedger>[0] = [{ scope: 'global', rows: await rows('global', null) }];
  if (location.parent_id) layers.push({ scope: 'country', rows: await rows('location', location.parent_id) });
  layers.push({ scope: location.level === 'country' ? 'country' : 'micro_area', rows: await rows('location', location.id) });
  if (pairingId) layers.push({ scope: 'pairing', rows: await rows('pairing', pairingId) });
  return mergeLedger(layers);
}

export interface NewAssumption {
  subject_type: 'location' | 'pairing' | 'niche' | 'global';
  subject_id: string | null;
  key: string;
  value_num?: number | null;
  value_text?: string | null;
  low?: number | null;
  high?: number | null;
  unit?: string | null;
  currency?: string | null;
  source_url?: string | null;
  source_note?: string | null;
  confidence: 'high' | 'medium' | 'low';
  stale_after?: string;
}

/** Write values to the ledger on behalf of an agent run. */
export async function writeAssumptions(run: Run, agent: string, items: NewAssumption[]): Promise<string[]> {
  if (!items.length) return [];
  const payload = items.map((a) => ({
    ...a,
    written_by: `agent:${agent}`,
    run_id: run.id,
    retrieved_at: new Date().toISOString(),
    stale_after: a.stale_after ?? '180 days',
  }));
  const ids: string[] = [];
  // Insert one at a time so the supersede trigger sees each previous value.
  for (const row of payload) {
    const res = must(await db().from('assumptions').insert(row).select('id').single(), `write ${row.key}`);
    ids.push(res.id);
  }
  run.assumptionIds.push(...ids);
  return ids;
}

/** The keys every location needs before pairings there can be analysed. */
export const REQUIRED_LOCATION_KEYS = [
  'land.price_per_acre_usd',
  'lease.finca_monthly_usd',
  'lease.commercial_monthly_usd',
  'lease.estate_monthly_usd',
  'lease.land_monthly_usd_per_acre',
  'tax.income_effective_pct',
  'labor.monthly_wage_usd',
  'tax.revenue_pct',
  'build.cost_index',
  'price.index',
  'demand.multiplier',
  'demand.population_40min',
  'exit.country_discount',
] as const;

export const KEY_GUIDE: Record<string, string> = {
  'land.price_per_acre_usd': 'Asking price per acre (USD) for rural land of 1-10 acres suitable for a small retreat',
  'lease.land_monthly_usd_per_acre': 'Monthly rent per acre (USD) on a long-term lease of rural land with no buildings (a ground or land lease, e.g. for farming, cabins or glamping); not a sale price',
  'lease.finca_monthly_usd': 'Monthly rent (USD) on a long-term lease (12+ months) for a furnished rural house or finca with 4+ bedrooms and some land; not nightly or weekly vacation rates',
  'lease.commercial_monthly_usd': 'Monthly rent (USD) on a long-term lease for a rural or edge-of-town property where a public-facing business (day visitors, parking) is allowed; not nightly or event rates',
  'lease.estate_monthly_usd': 'Monthly rent (USD) on a long-term lease (12+ months) for a large rural estate (20+ acres) with several buildings; not nightly or weekly vacation rates',
  'tax.income_effective_pct': 'Effective income tax plus self-employment or social-security tax on about $60,000 a year of small-business profit, as a fraction',
  'labor.monthly_wage_usd': 'Fully loaded monthly cost (USD) of one full-time entry-level hospitality worker (housekeeper, attendant, front desk) in rural areas, including employer charges; not an all-industry or professional average',
  'tax.revenue_pct': 'Taxes charged on gross revenue for a small lodging business, as a fraction (0.05 = 5%)',
  'build.cost_index': 'Construction cost relative to rural western North Carolina = 1.0',
  'price.index': 'What visitors pay for comparable wellness lodging relative to western North Carolina = 1.0',
  'demand.multiplier': 'Demand for this kind of destination relative to a typical US mountain area = 1.0',
  'demand.population_40min': 'People living within about a 40-minute drive: the population of each town or city within that drive, reported one per town (code adds them up)',
  'exit.country_discount': 'Discount a buyer would apply for country risk, currency and title (0 to 0.6)',
  'land.appreciation_pct': 'Typical annual rural land appreciation, as a fraction',
  'finance.rate_pct': 'Interest rate (percent) for a small-business real estate loan available to the owner',
  'build.cost_per_sqft_usd': 'Construction cost per square foot (USD) for a simple new cabin or small lodging building, including labor and materials',
  'price.lodging_night_usd': 'Price per night (USD) for a private room or cabin at a wellness retreat, eco-lodge or glamping site',
};

/**
 * Index values are a place's own figure divided by the same figure for the
 * reference place (western North Carolina = 1.0). The scout finds the raw
 * figure for each place; code does the division.
 */
export const INDEX_RAW: Record<string, string> = {
  'build.cost_index': 'build.cost_per_sqft_usd',
  'price.index': 'price.lodging_night_usd',
};
export const INDEX_REFERENCE_SLUG = 'us-nc-madison';

export { PLAUSIBLE, SUMMED_KEYS } from './guards.ts';
