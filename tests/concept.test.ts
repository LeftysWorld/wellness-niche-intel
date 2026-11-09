import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildModel, mergeLedger, type LedgerValue } from '../supabase/functions/_shared/model-builder.ts';
import { analyze } from '../supabase/functions/_shared/engine/index.ts';
import { cashWithHome, featuresFor, ideaChecks, inputUse, PUBLIC_BATHING_MIN_BUILD, type Concept } from '../supabase/functions/_shared/concept.ts';
import { CONCEPT_SCHEMA } from '../supabase/functions/_shared/niche-schemas.ts';

const data = JSON.parse(readFileSync(new URL('./data/dark-retreat.json', import.meta.url), 'utf8'));
let n = 0;
const row = (key: string, value: number): LedgerValue => ({ id: `c-${++n}`, key, value_num: value, value_text: null, low: null, high: null, confidence: 'medium', source_url: 'https://example.org', written_by: 'test' });
const ledger = mergeLedger([{ scope: 'country', rows: [row('labor.monthly_wage_usd', 2800), row('lease.finca_monthly_usd', 3000), row('land.price_per_acre_usd', 25000), row('tax.income_effective_pct', 0.25)] }]);
const profile = { capital_usd: { min: 100000, max: 150000 }, financing_allowed: ['cash', 'sba', 'lease'], owner_hours_per_month: 220 };
const build = (openHoursPerMonth?: number) => {
  const niche = { slug: 'x', name: 'x', model: { ...data.card.model, openHoursPerMonth } };
  const b = buildModel({ niche, template: data.template, location: { slug: 'x', name: 'x', country_code: 'US' }, ledger, profile, tenure: 'own', startMonth: 1 });
  return { model: b.model, result: analyze(b.model, { simulations: 200, seed: 3, sensitivity: false }) };
};
const { model, result } = build(60);

const concept: Concept = {
  pitch: 'p', overview: 'o', who: 'w', journey: [], assets: [],
  features: [
    { name: 'Hot tubs', what: '', earns: 'Included', needs: '', stream_key: '' },
    { name: 'Main offer', what: '', earns: '$100', needs: '', stream_key: model.streams[0].key },
  ],
};

test('priced features come first, and a priced offer the concept skips still shows', () => {
  const f = featuresFor(concept, model.streams);
  assert.equal(f[0].name, 'Main offer');
  assert.ok(f[0].priced);
  assert.equal(f.filter((x) => x.priced).length, model.streams.length);
  assert.equal(f.at(-1)!.name, 'Hot tubs');
  assert.equal(f.at(-1)!.priced, false);
});

test('without a concept, the model offers are listed', () => {
  assert.equal(featuresFor(null, model.streams).length, model.streams.length);
});

test('a feature pointing at an unknown offer is not shown as priced', () => {
  const f = featuresFor({ ...concept, features: [{ name: 'Ghost', what: '', earns: '', needs: '', stream_key: 'nope' }] }, model.streams);
  assert.equal(f.find((x) => x.name === 'Ghost')!.priced, false);
});

test('inputs: the house lease values an owned property; country adjustments at baseline are hidden', () => {
  assert.match(inputUse('lease.finca_monthly_usd', 'own', 3000).use, /sell/);
  assert.equal(inputUse('lease.commercial_monthly_usd', 'own', 4000).relevant, false);
  assert.equal(inputUse('lease.commercial_monthly_usd', 'lease', 4000).relevant, true);
  assert.equal(inputUse('build.cost_index', 'own', 1).relevant, false);
  assert.equal(inputUse('build.cost_index', 'own', 0.7).relevant, true);
  assert.equal(inputUse('land.price_per_acre_usd', 'lease', 25000).relevant, false);
});

test('living on site without a home budget is flagged; with one it is not', () => {
  const base = { tenure: 'own' as const, model, result, card: {} };
  assert.match(ideaChecks({ ...base, profile: { live_on_site: true, housing_cost_usd: 1500 } }).join(' '), /home/);
  assert.equal(ideaChecks({ ...base, profile: { live_on_site: true, housing_cost_usd: 1500, home_build_usd: 200000 } }).length, 0);
  assert.equal(ideaChecks({ ...base, tenure: 'lease', profile: { live_on_site: true } }).length, 0);
});

test('an attended business with no opening hours is flagged; long hours are covered by paid help', () => {
  const card = { staffing: 'Attendant during open hours' };
  const none = build(undefined);
  assert.match(ideaChecks({ tenure: 'own', ...none, card, profile: {} }).join(' '), /opening hours/);
  const busy = build(2000);
  assert.ok(busy.result.capacity.paidHelpHoursP50 > 0);
  assert.equal(ideaChecks({ tenure: 'own', ...busy, card, profile: {} }).some((w) => /on duty/.test(w)), false);
  assert.equal(ideaChecks({ tenure: 'own', model, result, card, profile: {} }).length, 0);
});

test('public bathing with a light build is flagged', () => {
  const card = { structures: 'Saunas, cold plunges, changing rooms and showers', permits: ['public bathing or pool rules'] };
  const build = result.startup.lines.filter((l) => l.key !== 'land').reduce((a, l) => a + l.p50, 0);
  const flagged = ideaChecks({ tenure: 'own', model, result, card, profile: {} }).some((w) => /look light/.test(w));
  assert.equal(flagged, build < PUBLIC_BATHING_MIN_BUILD);
  assert.equal(ideaChecks({ tenure: 'lease', model, result, card, profile: {} }).some((w) => /look light/.test(w)), false);
});

test('cash with your home is only for owning and living on site', () => {
  assert.equal(cashWithHome(70000, 'own', { live_on_site: true, home_build_usd: 150000 }), 220000);
  assert.equal(cashWithHome(70000, 'lease', { live_on_site: true, home_build_usd: 150000 }), null);
  assert.equal(cashWithHome(70000, 'own', { live_on_site: false, home_build_usd: 150000 }), null);
});

test('the concept schema requires every field', () => {
  assert.deepEqual([...CONCEPT_SCHEMA.required].sort(), ['assets', 'features', 'journey', 'overview', 'pitch', 'who']);
});
