import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildModel, mergeLedger, type LedgerValue } from '../supabase/functions/_shared/model-builder.ts';
import { analyze } from '../supabase/functions/_shared/engine/index.ts';

const data = JSON.parse(readFileSync(new URL('./data/dark-retreat.json', import.meta.url), 'utf8'));
const niche = { slug: 'dark-retreat', name: 'Dark retreat', model: data.card.model };
const base = { capital_usd: { min: 100000, max: 150000 }, owner_hours_per_month: 220 };

let n = 0;
const row = (key: string, value: number): LedgerValue => ({
  id: `10000000-0000-0000-0000-${String(++n).padStart(12, '0')}`, key, value_num: value, value_text: null,
  low: null, high: null, confidence: 'medium', source_url: 'https://example.org', written_by: 'seed',
});
const us = mergeLedger([{ scope: 'country', rows: [row('labor.monthly_wage_usd', 2800), row('finance.rate_pct', 8.5), row('finance.min_equity_pct', 0.2), row('land.price_per_acre_usd', 15000), row('lease.finca_monthly_usd', 2500)] }]);
const co = mergeLedger([{ scope: 'country', rows: [row('labor.monthly_wage_usd', 900), row('land.price_per_acre_usd', 40000), row('lease.finca_monthly_usd', 2000)] }]);
const US = { slug: 'us-nc-madison', name: 'Madison County', country_code: 'US' };
const CO = { slug: 'co-ant-el-retiro', name: 'El Retiro', country_code: 'CO' };

test('renting land: no land purchase, the build items, land rent, and an SBA loan in the US', () => {
  const out = buildModel({ niche, template: data.template, location: US, ledger: us, profile: { ...base, financing_allowed: ['cash', 'sba', 'lease'] }, tenure: 'ground' });
  const keys = out.model.startupCosts.map((c) => c.key);
  assert.ok(!keys.includes('land'), 'no land purchase');
  assert.ok(keys.includes('ground_deposit'));
  assert.ok(!keys.includes('lease_deposit') && !keys.includes('dark_room_fitout'), 'no conversion items for an existing building');
  assert.equal(out.model.costs.fixed[0].key, 'ground_rent');
  // No scouted ground rent yet: 6% a year of the land value, flagged as missing.
  assert.equal(out.model.costs.fixed[0].amount.mode, Math.round(((15000 * 0.06) / 12) * data.template.land_acres * 1000) / 1000);
  assert.ok(out.missing.includes('lease.land_monthly_usd_per_acre'));
  assert.equal(out.model.exit.ownsProperty, false);
  assert.equal(out.model.financing.kind, 'loan');
  assert.equal(out.model.financing.termYears, 10);
});

test('a US lease can borrow for fit-out with SBA 7(a)', () => {
  const out = buildModel({ niche, template: data.template, location: US, ledger: us, profile: { ...base, financing_allowed: ['cash', 'sba', 'lease'] }, tenure: 'lease' });
  assert.equal(out.model.financing.kind, 'loan');
  assert.equal(out.model.financing.lender, 'an SBA 7(a) loan');
});

test('abroad: cash only, unless seller financing is allowed, which covers part of the land', () => {
  const cash = buildModel({ niche, template: data.template, location: CO, ledger: co, profile: { ...base, financing_allowed: ['cash', 'sba', 'lease'] }, tenure: 'own' });
  assert.equal(cash.model.financing.kind, 'cash');
  const seller = buildModel({ niche, template: data.template, location: CO, ledger: co, profile: { ...base, financing_allowed: ['cash', 'seller'] }, tenure: 'own' });
  const land = seller.model.startupCosts.find((c) => c.key === 'land')!.amount.mode;
  assert.equal(seller.model.financing.kind, 'loan');
  assert.equal(seller.model.financing.maxLoan, land * 0.6);
  const r = analyze(seller.model, { simulations: 200, seed: 3 });
  assert.ok(Math.abs(r.startup.loanAmountP50 - land * 0.6) < 1, 'loan capped at 60% of the land');
});

test('living on site counts the housing saved in the lender test and the with-housing take-home', () => {
  const profile = { ...base, financing_allowed: ['cash', 'sba', 'lease'], live_on_site: true, housing_cost_usd: 1500 };
  const on = buildModel({ niche, template: data.template, location: US, ledger: us, profile, tenure: 'own' });
  const off = buildModel({ niche, template: data.template, location: US, ledger: us, profile: { ...profile, live_on_site: false }, tenure: 'own' });
  assert.equal(on.model.ownerHousingSavedMonthly, 1500);
  const a = analyze(on.model, { simulations: 300, seed: 9 });
  const b = analyze(off.model, { simulations: 300, seed: 9 });
  assert.equal(a.year1.takeHome.p50, b.year1.takeHome.p50, 'take-home itself is unchanged');
  assert.equal(a.year1.takeHomeWithHousing.p50, Math.round((a.year1.takeHome.p50 + 1500) * 100) / 100);
  assert.ok(a.lender.dscrP50! > b.lender.dscrP50!, 'housing saved improves coverage');
});
