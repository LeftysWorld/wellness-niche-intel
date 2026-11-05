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
    items: obj({ key: str, label: str, market: { type: 'string', enum: ['local', 'destination'], description: 'local: people living within ~40 minutes; destination: travellers' }, units: num, sellablePerUnitPerMonth: num, price: tri, startOccupancy: tri, matureOccupancy: tri, monthsToMature: tri, ownerHoursPerSale: num }),
  },
  perSale: { type: 'array', items: obj({ stream: str, usd: tri, scale: { type: 'string', enum: ['price', 'none'] } }) },
  fixed: { type: 'array', items: obj({ key: str, label: str, usd: tri, scale: { type: 'string', enum: ['price', 'none'] }, applies: { type: 'string', enum: ['own', 'lease', 'both'] } }) },
  staffing: { type: 'array', items: obj({ key: str, label: str, wageMultiple: tri, fromMonth: num }) },
  exit: obj({ sdeMultiple: tri, ebitdaMultiple: tri, managerWageMultiple: num }),
  land_acres: num,
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

