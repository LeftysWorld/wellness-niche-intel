import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildModel, mergeLedger, type LedgerValue } from '../supabase/functions/_shared/model-builder.ts';
import { analyze } from '../supabase/functions/_shared/engine/index.ts';
import { DEFAULT_WEIGHTS, moneyRank, scoreIdea, targetFigure } from '../supabase/functions/_shared/scoring.ts';

const data = JSON.parse(readFileSync(new URL('./data/dark-retreat.json', import.meta.url), 'utf8'));
const niche = { slug: 'dark-retreat', name: 'Dark retreat', model: { ...data.card.model, openHoursPerMonth: 60 } };
const profile = { capital_usd: { min: 100000, max: 150000 }, financing_allowed: ['cash', 'lease'], owner_hours_per_month: 220, operator_model: 'solo' };
let n = 0;
const row = (key: string, value: number | null, extra: Partial<LedgerValue> = {}): LedgerValue => ({
  id: `id-${++n}`, key, value_num: value, value_text: null, low: null, high: null, confidence: 'medium', source_url: 'https://example.org', written_by: 'agent:location-scout', ...extra,
});
const ledger = mergeLedger([{ scope: 'country', rows: [row('labor.monthly_wage_usd', 2800), row('lease.finca_monthly_usd', 3000), row('tax.income_effective_pct', 0.25)] }]);
const built = buildModel({ niche, template: data.template, location: { slug: 'x', name: 'x', country_code: 'US' }, ledger, profile, tenure: 'lease', startMonth: 1 });
const result = analyze(built.model, { simulations: 300, seed: 1, sensitivity: false });

const input = {
  result, evidence: built.evidence, target: 5000, targetYear: 1, basis: 'after_tax' as const,
  nicheDemand: 5, signalScore: 9, placeFit: null, visaRoute: 'citizen', countryDiscount: 0.1, advisoryLevel: 1,
};

test('weights sum to 1', () => {
  const sum = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('place match is left out of the score until the owner describes what they want', () => {
  const none = scoreIdea(input);
  assert.equal(none.parts.place, undefined);
  const low = scoreIdea({ ...input, placeFit: 0 });
  const high = scoreIdea({ ...input, placeFit: 10 });
  assert.ok(high.total > none.total && none.total > low.total);
});

test('after-tax target uses take-home; pre-tax uses profit', () => {
  assert.equal(targetFigure(result, 1, 'after_tax'), result.year1.takeHome.p50);
  assert.equal(targetFigure(result, 1, 'pre_tax'), result.year1.profit.p50);
  assert.ok(result.year3.takeHome.p50 < result.year3.profit.p50);
});

test('owner-set weights change the total', () => {
  const a = scoreIdea(input).total;
  const b = scoreIdea(input, { money: 0, growth: 0, capital: 0, demand: 1 }).total;
  assert.notEqual(a, b);
});

test('money-first order: fundable first, then target-year figure', () => {
  const xs = [
    { fundable: false, target: 9000, year3: 9000 },
    { fundable: true, target: 1000, year3: 5000 },
    { fundable: true, target: 3000, year3: 2000 },
  ].sort(moneyRank);
  assert.deepEqual(xs.map((x) => x.target), [3000, 1000, 9000]);
});

test('example counts count for less than a judged demand score', () => {
  const judged = scoreIdea({ ...input, nicheDemand: 9 }).parts.demand;
  const counted = scoreIdea({ ...input, nicheDemand: null, signalScore: 9 }).parts.demand;
  assert.ok(judged > counted);
});
