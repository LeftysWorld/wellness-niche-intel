// The accuracy fixes: capital costs and lot size per idea, niche season curves,
// price terms, sourced rules, demand label direction, and the red-team check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildModel, capexKeyFor, mergeLedger, seasonCurves, type LedgerValue } from '../supabase/functions/_shared/model-builder.ts';
import { capitalDrivers, PAIRING_KEY } from '../supabase/functions/_shared/drivers.ts';
import { termsProblem } from '../supabase/functions/_shared/price-terms.ts';
import { kindDirectionProblem } from '../supabase/functions/_shared/demand.ts';
import { isOfficialHost, rulesGap } from '../supabase/functions/_shared/rules.ts';
import { compareChecks, GAP_LIMIT, lowerConfidence, redTeamTargets } from '../supabase/functions/_shared/red-team.ts';
import { analyze } from '../supabase/functions/_shared/engine/index.ts';
import { ANSWER_KEY } from '../supabase/functions/_shared/evals/answer-key.ts';
import { ECONOMICS_SCHEMA, toModelAndTemplate } from '../supabase/functions/_shared/niche-schemas.ts';

const data = JSON.parse(readFileSync(new URL('./data/dark-retreat.json', import.meta.url), 'utf8'));
let n = 0;
const row = (key: string, value: number | null, extra: Partial<LedgerValue> = {}): LedgerValue => ({
  id: `a-${++n}`, key, value_num: value, value_text: null, low: null, high: null, confidence: 'medium', source_url: 'https://example.org', written_by: 'agent:pairing-analyst', ...extra,
});
const place = [row('labor.monthly_wage_usd', 2800), row('lease.finca_monthly_usd', 3000), row('land.price_per_acre_usd', 25000), row('tax.income_effective_pct', 0.25)];
const profile = { capital_usd: { min: 100000, max: 150000 }, financing_allowed: ['cash', 'sba', 'lease'], owner_hours_per_month: 220 };
const build = (pairing: LedgerValue[] = [], model = data.card.model) =>
  buildModel({
    niche: { slug: 'x', name: 'x', model },
    template: data.template,
    location: { slug: 'x', name: 'x', country_code: 'US' },
    ledger: mergeLedger([{ scope: 'micro_area', rows: place }, { scope: 'pairing', rows: pairing }]),
    profile,
    tenure: 'own',
    startMonth: 1,
  });

test('capital and lot-size keys are researched per idea', () => {
  assert.ok(PAIRING_KEY.test('capex.saunas_usd'));
  assert.ok(PAIRING_KEY.test('site.acres'));
  assert.ok(!PAIRING_KEY.test('build.cost_per_sqft_usd'));
  assert.equal(capexKeyFor('Hot-Tubs 2'), 'capex.hot_tubs_2_usd');
});

test('a researched lot size and start-up line replace the niche defaults', () => {
  const base = build();
  const item = data.template.items.find((i: { usd?: unknown; leaseMonths?: number }) => i.usd && !i.leaseMonths);
  const key = capexKeyFor(item.key);
  const researched = build([row('site.acres', 4), row(key, 123456)]);
  const land = (b: typeof base) => b.model.startupCosts.find((l) => l.key === 'land')!;
  assert.match(land(researched).label, /4 acres/);
  assert.equal(Math.round(land(researched).amount.mode), 100000);
  assert.equal(Math.round(researched.model.startupCosts.find((l) => l.key === item.key)!.amount.mode), 123456);
  assert.ok(researched.usedAssumptionIds.length > base.usedAssumptionIds.length);
});

test('capital drivers rank start-up lines by size with the keys that set them', () => {
  const b = build();
  const d = capitalDrivers(b.model, { evidence: b.evidence, capexKey: capexKeyFor });
  assert.ok(d.length > 0);
  for (let i = 1; i < d.length; i++) assert.ok(d[i - 1].usd >= d[i].usd);
  const land = d.find((x) => x.keys[0].key === 'land.price_per_acre_usd');
  assert.deepEqual(land?.keys.map((k) => k.key), ['land.price_per_acre_usd', 'site.acres']);
});

test('a niche season curve leads; the place curve only adjusts it', () => {
  const winter = [1.35, 1.3, 1.1, 0.95, 0.8, 0.7, 0.65, 0.7, 0.85, 1.05, 1.2, 1.35];
  const summerPlace = [0.6, 0.65, 0.85, 1.0, 1.1, 1.2, 1.25, 1.2, 1.1, 1.35, 1.0, 0.7];
  const { curve, localCurve } = seasonCurves(winter, summerPlace);
  assert.ok(localCurve![0] > localCurve![6], 'locals still busiest in winter');
  assert.ok(curve![0] > curve![6], 'travellers too');
  assert.ok(Math.abs(curve!.reduce((a, b) => a + b, 0) / 12 - 1) < 0.01);
  assert.deepEqual(seasonCurves(undefined, summerPlace).curve, summerPlace);
  assert.equal(seasonCurves([1, 2], summerPlace).curve, summerPlace, 'a malformed niche curve is ignored');
});

test('the niche curve reaches the model streams', () => {
  const winter = [1.35, 1.3, 1.1, 0.95, 0.8, 0.7, 0.65, 0.7, 0.85, 1.05, 1.2, 1.35];
  const b = build([], { ...data.card.model, seasonality: winter });
  const s = b.model.streams.find((x) => !data.card.model.streams.find((y: { key: string; seasonality?: number[] }) => y.key === x.key)?.seasonality);
  if (s) assert.ok(s.seasonality![0] > s.seasonality![6]);
});

test('price terms: product, unit, date; the unit must match the offer', () => {
  const units = ['per_person', 'per_booking'];
  assert.match(termsProblem(undefined, { units })!, /terms/);
  assert.match(termsProblem({ product: 'Sauna Cabana', unit: 'per_person', seen: 'undated' }, { unit: 'per_booking', units })!, /per booking/);
  assert.match(termsProblem({ product: 'Sauna Cabana', unit: 'per_booking' }, { unit: 'per_booking', units })!, /seen/);
  assert.equal(termsProblem({ product: 'Sauna Cabana', unit: 'per_booking', party_size: 4, seen: '2026-11-10' }, { unit: 'per_booking', units }), null);
  assert.equal(termsProblem({ product: 'Pass', unit: 'per_person', seen: 'undated' }, { units }), null, 'no unit set on the offer: any listed unit');
});

test('a crowded-market signal can only count against', () => {
  assert.ok(kindDirectionProblem('saturation', 'for'));
  assert.equal(kindDirectionProblem('saturation', 'against'), null);
  assert.equal(kindDirectionProblem('busy_competitors', 'for'), null);
});

test('rules come from official hosts', () => {
  for (const h of ['des.sc.gov', 'www.scdhec.gov', 'greenvillecounty.org', 'cityofmarshall.com', 'library.municode.com', 'hacienda.go.cr', 'www.dian.gov.co', 'mh.gob.sv']) assert.ok(isOfficialHost(h), h);
  for (const h of ['permitmint.com', 'blogspot.com', 'saunahouse.com', 'gov.example.com', 'countrysidecabins.com']) assert.ok(!isOfficialHost(h), h);
  assert.match(rulesGap(true, [])!, /record_rule/);
  assert.equal(rulesGap(true, [{ topic: 'health', agency: 'SCDES', requirement: 'x', url: 'u', quote: 'q' }]), null);
  assert.equal(rulesGap(false, []), null);
});

test('red team: gaps over the limit are flagged and lower confidence one step', () => {
  const targets = [
    { key: 'price.private_sessions_usd', label: 'Private room', current: 225, unit: 'USD per booking', why: '' },
    { key: 'land.price_per_acre_usd', label: 'Land', current: 25000, unit: 'USD per acre', why: '' },
    { key: 'capex.saunas_usd', label: 'Saunas', current: 44000, unit: 'USD', why: '' },
  ];
  const f = compareChecks(targets, [
    { key: 'price.private_sessions_usd', value: 200, url: 'https://a.com/1', host: 'a.com', quote: '' },
    { key: 'price.private_sessions_usd', value: 188, url: 'https://b.com/1', host: 'b.com', quote: '' },
    { key: 'land.price_per_acre_usd', value: 37967, url: 'https://c.com/1', host: 'c.com', quote: '' },
    { key: 'land.price_per_acre_usd', value: 35613, url: 'https://c.com/2', host: 'c.com', quote: '' },
  ]);
  assert.equal(f[0].found, 194);
  assert.equal(f[0].flagged, false, `${f[0].gap} <= ${GAP_LIMIT}`);
  assert.equal(f[1].flagged, true);
  assert.equal(f[1].sites, 1);
  assert.equal(f[2].found, null);
  assert.equal(lowerConfidence('high', f), 'medium');
  assert.equal(lowerConfidence('medium', f), 'low');
  assert.equal(lowerConfidence('high', [f[0]]), 'high');
});

test('red team targets: every price, the biggest booking rates and start-up costs, with the land price per acre', () => {
  const b = build();
  const r = analyze(b.model, { simulations: 200, seed: 2 });
  const t = redTeamTargets(b.model, { ...r, tenure: 'own', evidence: b.evidence }, data.card.model);
  assert.ok(t.some((x) => x.key.startsWith('price.')));
  const land = t.find((x) => x.key === 'land.price_per_acre_usd');
  assert.ok(land && Math.abs(land.current - 25000) < 1);
  assert.ok(t.length <= 8);
});

test('new niche drafts carry price units, a season curve and a real lot size', () => {
  const streams = (ECONOMICS_SCHEMA.properties.streams as { items: { required: string[] } }).items;
  assert.ok(streams.required.includes('priceUnit'));
  assert.ok(ECONOMICS_SCHEMA.required.includes('seasonality'));
  const out = toModelAndTemplate({ ...minimalEconomics(), seasonality: Array(12).fill(1) });
  assert.equal(out.model.seasonality?.length, 12);
  assert.equal(toModelAndTemplate({ ...minimalEconomics(), seasonality: [1, 2] }).model.seasonality, undefined);
});

test('answer key: idea-level entries name a niche, place entries do not', () => {
  const idea = ANSWER_KEY.filter((e) => e.niche);
  assert.ok(idea.length >= 2);
  for (const e of idea) assert.match(e.key, /^price\./);
  assert.ok(ANSWER_KEY.some((e) => e.id === 'us-sc-upstate-land-2026' && !e.niche));
});

test('playbooks: the analyst researches capital costs, terms and rules; the red team has its own', () => {
  const analyst = readFileSync(new URL('../supabase/functions/agents/pairing-analyst.md', import.meta.url), 'utf8');
  for (const w of ['capex.', 'site.acres', 'record_rule', 'terms']) assert.ok(analyst.includes(w), w);
  const red = readFileSync(new URL('../supabase/functions/agents/red-team.md', import.meta.url), 'utf8');
  assert.match(red, /record_check/);
});

function minimalEconomics() {
  return {
    ownerFixedHours: 40, openHoursPerMonth: 0, buildMonthsOwn: { low: 6, mode: 9, high: 12 }, buildMonthsLease: { low: 2, mode: 3, high: 5 },
    siteType: 'house', variablePct: { low: 0.05, mode: 0.08, high: 0.12 }, requiresPopulation: false, streams: [], perSale: [], fixed: [], staffing: [],
    exit: { sdeMultiple: { low: 1, mode: 2, high: 3 }, ebitdaMultiple: { low: 3, mode: 4, high: 5 }, managerWageMultiple: 1.5 }, land_acres: 3, startup_items: [],
  };
}
