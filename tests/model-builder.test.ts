import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildModel, mergeLedger, type LedgerValue } from '../supabase/functions/_shared/model-builder.ts';
import { analyze } from '../supabase/functions/_shared/engine/index.ts';

const data = JSON.parse(readFileSync(new URL('./data/dark-retreat.json', import.meta.url), 'utf8'));
const niche = { slug: 'dark-retreat', name: 'Dark retreat', model: data.card.model };
const profile = { capital_usd: { min: 100000, max: 150000 }, financing_allowed: ['cash', 'sba', 'lease'], owner_hours_per_month: 220 };

let n = 0;
const row = (key: string, value: number, extra: Partial<LedgerValue> = {}): LedgerValue => ({
  id: `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`, key, value_num: value, value_text: null,
  low: null, high: null, confidence: 'medium', source_url: 'https://example.org', written_by: 'seed', ...extra,
});

const colombia = mergeLedger([
  { scope: 'country', rows: [row('labor.monthly_wage_usd', 900), row('price.index', 0.6), row('build.cost_index', 0.55), row('tax.revenue_pct', 0.05), row('exit.country_discount', 0.3)] },
  { scope: 'micro_area', rows: [row('lease.finca_monthly_usd', 3195), row('demand.multiplier', 1), row('price.index', 0.65)] },
]);

test('micro-area overrides country in merged ledger', () => {
  assert.equal(colombia.get('price.index')?.value_num, 0.65);
  assert.equal(colombia.get('price.index')?.scope, 'micro_area');
});

test('leased Colombia build uses lease items and skips land', () => {
  const out = buildModel({ niche, template: data.template, location: { slug: 'co-ant-el-retiro', name: 'El Retiro', country_code: 'CO' }, ledger: colombia, profile, tenure: 'lease' });
  const keys = out.model.startupCosts.map((c) => c.key);
  assert.ok(keys.includes('dark_room_fitout') && keys.includes('lease_deposit'));
  assert.ok(!keys.includes('land') && !keys.includes('site_work'));
  const deposit = out.model.startupCosts.find((c) => c.key === 'lease_deposit')!;
  assert.equal(deposit.amount.mode, 6390);
  assert.equal(out.model.costs.fixed[0].key, 'lease');
  assert.ok(!out.model.costs.fixed.some((f) => f.key === 'property_tax'));
  assert.equal(out.model.streams[0].price.mode, 275 * 0.65);
  assert.equal(out.model.financing.kind, 'lease');
  assert.ok(out.missing.length === 0, `missing: ${out.missing}`);
  const r = analyze(out.model, { simulations: 300, seed: 1 });
  assert.ok(Number.isFinite(r.month60.profit.p50));
});

test('owned US build adds land, uses a loan, and reports missing keys', () => {
  const us = mergeLedger([{ scope: 'country', rows: [row('labor.monthly_wage_usd', 2800), row('finance.rate_pct', 8.5), row('finance.min_equity_pct', 0.2)] }]);
  const out = buildModel({ niche, template: data.template, location: { slug: 'us-nc-madison', name: 'Madison County', country_code: 'US' }, ledger: us, profile, tenure: 'own' });
  assert.ok(out.model.startupCosts.some((c) => c.key === 'land'));
  assert.equal(out.model.financing.kind, 'loan');
  assert.ok(out.missing.includes('land.price_per_acre_usd'));
  assert.ok(out.model.exit.buildingValue > 0);
});

test('solo owner gets no paid staff unless asked; staff come back with withStaff', () => {
  const loc = { slug: 'co-ant-el-retiro', name: 'El Retiro', country_code: 'CO' };
  const solo = buildModel({ niche, template: data.template, location: loc, ledger: colombia, profile: { ...profile, operator_model: 'solo' }, tenure: 'lease' });
  assert.equal(solo.model.costs.staffing.length, 0);
  assert.equal(solo.staffed, false);
  const staffed = buildModel({ niche, template: data.template, location: loc, ledger: colombia, profile: { ...profile, operator_model: 'solo' }, tenure: 'lease', withStaff: true });
  assert.ok(staffed.model.costs.staffing.length > 0);
  const team = buildModel({ niche, template: data.template, location: loc, ledger: colombia, profile: { ...profile, operator_model: 'team' }, tenure: 'lease' });
  assert.ok(team.model.costs.staffing.length > 0);
});

test('a niche rent line is dropped so the lease is counted once', () => {
  const withRent = { ...niche, model: { ...niche.model, fixed: [...niche.model.fixed, { key: 'site_lease', label: 'Site or house lease', usd: { low: 2000, mode: 2500, high: 3000 }, scale: 'none', applies: 'both' }] } };
  const out = buildModel({ niche: withRent, template: data.template, location: { slug: 'x', name: 'x', country_code: 'CO' }, ledger: colombia, profile, tenure: 'lease' });
  const rentLines = out.model.costs.fixed.filter((f) => /lease|rent/i.test(`${f.key} ${f.label}`));
  assert.equal(rentLines.length, 1);
  assert.equal(rentLines[0].key, 'lease');
});
