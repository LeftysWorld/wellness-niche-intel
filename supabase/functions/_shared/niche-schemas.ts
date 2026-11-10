// Schemas for the niche write-up (structured outputs) and the mapping from the
// economics reply to the engine's model card. No I/O, so tests can import it.
import type { CostTemplate, NicheModelSpec } from './model-builder.ts';

export const tri = { type: 'object', properties: { low: { type: 'number' }, mode: { type: 'number' }, high: { type: 'number' } }, required: ['low', 'mode', 'high'] };

export const str = { type: 'string' };
export const strs = { type: 'array', items: str };
export const num = { type: 'number' };
export const obj = (properties: Record<string, unknown>) => ({ type: 'object' as const, properties, required: Object.keys(properties) });

// Two compact schemas instead of one large one: structured outputs compile
// each schema to a grammar, and every field required keeps that grammar small.
export const DESCRIBE_SCHEMA = obj({
  summary: { ...str, description: 'Two or three plain sentences: what the guest gets and how the business makes money' },
  why_interesting: { ...str, description: 'Why this could work now: demand, trend, gap in supply' },
  unique_angle: { ...str, description: 'One sentence: what makes it different from an ordinary retreat or spa' },
  structures: str,
  revenue_units: str,
  price_model: str,
  staffing: str,
  permits: strs,
  demand_drivers: strs,
  competitor_terms: strs,
  risk_tags: { ...strs, description: 'Include psychedelic or medical_license if the business needs them; otherwise empty' },
  prerequisites: { ...strs, description: 'Physical or legal things a site must have, e.g. "natural hot spring or permitted geothermal well", "at least 20 acres", "commercial or agritourism use allowed". Empty if any rural house works.' },
  demand_score: { ...num, description: '0-10: how strong the evidence is that people pay for this (10 = many busy, well-reviewed operators)' },
  demand_evidence: { ...str, description: 'One or two sentences citing what in the results shows demand' },
  operating_examples: {
    type: 'array',
    items: obj({ name: str, locality: str, country: str, source_index: { type: 'integer' }, matches_definition: { type: 'boolean', description: 'true only if this is genuinely this kind of business, not a loosely related one' }, note: str }),
  },
});

/** What the business is, in plain terms: the guest's visit, what the owner builds, what guests get. */
export const CONCEPT_SCHEMA = obj({
  pitch: { ...str, description: 'One sentence a friend would understand: what the business is and where guests spend their time' },
  overview: { ...str, description: 'Two or three sentences: how a visit works and how the business makes money. Say whether guests stay overnight.' },
  who: { ...str, description: 'Who the customers are, in one short line' },
  journey: { type: 'array', description: '4 to 6 steps of a typical guest visit, in order', items: obj({ title: str, text: str }) },
  assets: { type: 'array', description: 'Physical things the owner builds or buys (land, buildings, equipment, utilities), 5 to 10 items', items: obj({ name: str, note: str }) },
  features: {
    type: 'array',
    description: 'What guests get, 5 to 10 items: every priced offer, plus the facilities and add-ons that make this a complete business of its kind rather than a single amenity',
    items: obj({
      name: str,
      what: { ...str, description: 'One sentence' },
      earns: { ...str, description: 'How it makes money, e.g. "$35 a visit", "included; lifts ticket price", "commission per massage"' },
      needs: { ...str, description: 'What it takes to offer it' },
      stream_key: { ...str, description: 'The key of the priced offer this feature is, from the list given; empty when it is not one of them' },
    }),
  },
});

export const ECONOMICS_SCHEMA = obj({
  ownerFixedHours: { ...num, description: 'Admin, marketing, bookings and upkeep hours per month' },
  openHoursPerMonth: { ...num, description: 'Hours per month someone must be on site because the business is open (e.g. 6 days x 8 hours = 208); 0 if guests self-serve' },
  buildMonthsOwn: { ...tri, description: 'Months from buying land to opening (build, permits)' },
  buildMonthsLease: { ...tri, description: 'Months from signing a lease to opening (fit-out, permits)' },
  siteType: { type: 'string', enum: ['house', 'commercial', 'estate'], description: 'house: a rentable home with rooms; commercial: public-facing use with parking; estate: large acreage with buildings' },
  variablePct: tri,
  requiresPopulation: { type: 'boolean', description: 'true if most revenue is local day visits' },
  streams: {
    type: 'array',
    items: obj({ key: str, label: str, market: { type: 'string', enum: ['local', 'destination'], description: 'local: people living within ~40 minutes; destination: travellers' }, units: num, sellablePerUnitPerMonth: num, price: tri, startOccupancy: tri, matureOccupancy: tri, monthsToMature: tri, ownerHoursPerSale: num, priceUnit: { type: 'string', enum: ['per_person', 'per_booking', 'per_night', 'per_month', 'per_unit'], description: 'What one price buys: per_person (a ticket), per_booking (a room or group, whatever the size), per_night, per_month (a membership)' } }),
  },
  seasonality: {
    type: 'array',
    items: num,
    description: 'How busy this kind of business is in each month, January to December, around 1 (busiest about 1.3, quietest about 0.7). Think about the activity, not tourism in general: a sauna is busiest in winter, an outdoor pool in summer.',
  },
  perSale: { type: 'array', items: obj({ stream: str, usd: tri, scale: { type: 'string', enum: ['price', 'none'] } }) },
  fixed: { type: 'array', items: obj({ key: str, label: str, usd: tri, scale: { type: 'string', enum: ['price', 'none'] }, applies: { type: 'string', enum: ['own', 'lease', 'both'] } }) },
  staffing: { type: 'array', items: obj({ key: str, label: str, wageMultiple: tri, fromMonth: num }) },
  exit: obj({ sdeMultiple: tri, ebitdaMultiple: tri, managerWageMultiple: num }),
  land_acres: { ...num, description: 'Acres the business really needs: buildings, parking, septic field, outdoor areas, and the owner\'s home when they live on site' },
  startup_items: {
    type: 'array',
    description: 'One-off costs. qty: count, or 0 when qtyFrom names a stream whose unit count sets it. leaseMonths: only for the lease deposit item (usd ignored), else 0.',
    items: obj({
      key: str,
      label: str,
      qty: num,
      qtyFrom: str,
      usd: tri,
      scale: { type: 'string', enum: ['build', 'equipment', 'none'] },
      applies: { type: 'string', enum: ['own', 'lease', 'both'] },
      leaseMonths: num,
    }),
  },
});

export type Describe = {
  summary: string; why_interesting: string; unique_angle: string; structures: string; revenue_units: string; price_model: string; staffing: string;
  permits: string[]; demand_drivers: string[]; competitor_terms: string[]; risk_tags: string[];
  prerequisites: string[]; demand_score: number; demand_evidence: string;
  operating_examples: { name: string; locality: string; country: string; source_index: number; matches_definition: boolean; note: string }[];
};
// deno-lint-ignore no-explicit-any
export type Economics = any;

/** Map the flat economics reply onto the model card and cost template the engine uses. */
export function toModelAndTemplate(e: Economics): { model: NicheModelSpec; template: CostTemplate } {
  const model: NicheModelSpec = {
    ownerFixedHours: e.ownerFixedHours,
    openHoursPerMonth: Math.max(0, Number(e.openHoursPerMonth ?? 0)),
    buildMonths: { own: e.buildMonthsOwn, lease: e.buildMonthsLease },
    siteType: e.siteType,
    variablePct: e.variablePct,
    requiresPopulation: e.requiresPopulation,
    streams: e.streams,
    ...(Array.isArray(e.seasonality) && e.seasonality.length === 12 ? { seasonality: e.seasonality } : {}),
    perSale: Object.fromEntries((e.perSale ?? []).map((p: { stream: string; usd: unknown; scale: string }) => [p.stream, { usd: p.usd, scale: p.scale }])),
    fixed: e.fixed,
    staffing: (e.staffing ?? []).map((s: { fromMonth: number }) => ({ ...s, fromMonth: Math.max(1, Math.round(s.fromMonth || 1)) })),
    exit: e.exit,
  };
  const template: CostTemplate = {
    land_acres: e.land_acres,
    items: (e.startup_items ?? []).map((i: { key: string; label: string; qty: number; qtyFrom: string; usd: unknown; scale: string; applies: string; leaseMonths: number }) =>
      i.leaseMonths > 0
        ? { key: i.key, label: i.label, applies: i.applies, leaseMonths: i.leaseMonths }
        : { key: i.key, label: i.label, applies: i.applies, usd: i.usd, scale: i.scale, ...(i.qtyFrom ? { qtyFrom: i.qtyFrom } : { qty: i.qty || 1 }) },
    ),
  };
  return { model, template };
}

