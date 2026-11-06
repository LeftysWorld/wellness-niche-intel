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
  // This fixture predates opening hours and income tax, so those two are reported as missing.
  assert.deepEqual([...out.missing].sort(), ['niche.open_hours', 'tax.income_effective_pct']);
  const r = analyze(out.model, { simulations: 300, seed: 1 });
  assert.ok(Number.isFinite(r.year5.profit.p50));
});

test('owned US build adds land, uses a loan, and reports missing keys', () => {
  const us = mergeLedger([{ scope: 'country', rows: [row('labor.monthly_wage_usd', 2800), row('finance.rate_pct', 8.5), row('finance.min_equity_pct', 0.2)] }]);
  const out = buildModel({ niche, template: data.template, location: { slug: 'us-nc-madison', name: 'Madison County', country_code: 'US' }, ledger: us, profile, tenure: 'own' });
  assert.ok(out.model.startupCosts.some((c) => c.key === 'land'));
  assert.equal(out.model.financing.kind, 'loan');
  assert.ok(out.missing.includes('land.price_per_acre_usd'));
  assert.ok(out.model.exit.buildingValue > 0);
});

test('solo owner gets no fixed staff lines; a team owner gets the niche staff', () => {
  const loc = { slug: 'co-ant-el-retiro', name: 'El Retiro', country_code: 'CO' };
  const solo = buildModel({ niche, template: data.template, location: loc, ledger: colombia, profile: { ...profile, operator_model: 'solo' }, tenure: 'lease' });
  assert.equal(solo.model.costs.staffing.length, 0);
  assert.ok(solo.model.costs.hourlyWage);
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

test('lease follows the kind of site the niche needs, flagged when estimated', () => {
  const base = { niche: { ...niche, model: { ...niche.model, siteType: 'commercial' as const } }, template: data.template, location: { slug: 'x', name: 'x', country_code: 'CO' }, profile, tenure: 'lease' as const };
  const guessed = buildModel({ ...base, ledger: colombia });
  assert.ok(guessed.missing.includes('lease.commercial_monthly_usd'));
  assert.equal(guessed.model.costs.fixed[0].amount.mode, 3195 * 1.4);
  const withCommercial = mergeLedger([{ scope: 'country', rows: [...colombia.values()] }, { scope: 'micro_area', rows: [row('lease.commercial_monthly_usd', 5000)] }]);
  const sourced = buildModel({ ...base, ledger: withCommercial });
  assert.equal(sourced.model.costs.fixed[0].amount.mode, 5000);
  assert.equal(sourced.model.exit.marketRentMonthly, 5000);
});

test('local streams follow population; destination streams follow traveller demand and prices', () => {
  const model = { ...niche.model, streams: niche.model.streams.map((s: any, i: number) => ({ ...s, market: i === 0 ? 'local' : 'destination' })) };
  const small = mergeLedger([{ scope: 'country', rows: [...colombia.values(), row('demand.population_40min', 40000), row('price.index_destination', 0.9)] }]);
  const out = buildModel({ niche: { ...niche, model }, template: data.template, location: { slug: 'x', name: 'x', country_code: 'CO' }, ledger: small, profile, tenure: 'lease' });
  // sqrt(40k / 400k) = 0.316 local demand factor.
  assert.ok(Math.abs(out.model.streams[0].matureOccupancy.mode - niche.model.streams[0].matureOccupancy.mode * Math.sqrt(0.1)) < 1e-6);
  assert.equal(out.model.streams[0].market, 'local');
  assert.equal(out.model.streams[1].price.mode, niche.model.streams[1].price.mode * 0.9);
});

test('a seasonal curve from the place is normalised and applied', () => {
  const curve = JSON.stringify([2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1]);
  const l = mergeLedger([{ scope: 'country', rows: [...colombia.values(), { ...row('demand.seasonality', null), value_text: curve }] }]);
  const out = buildModel({ niche, template: data.template, location: { slug: 'x', name: 'x', country_code: 'CO' }, ledger: l, profile, tenure: 'lease' });
  const s = out.model.streams[0].seasonality!;
  assert.equal(s.length, 12);
  assert.ok(Math.abs(s.reduce((a, b) => a + b, 0) / 12 - 1) < 1e-9);
  assert.ok(s[0] > s[11]);
});

test('evidence separates sourced values from estimates', () => {
  const l = mergeLedger([{ scope: 'country', rows: [row('labor.monthly_wage_usd', 900), row('price.index', 0.6, { written_by: 'seed:estimate', source_url: null })] }]);
  const out = buildModel({ niche, template: data.template, location: { slug: 'x', name: 'x', country_code: 'CO' }, ledger: l, profile, tenure: 'lease' });
  assert.ok(out.evidence.sourced.includes('labor.monthly_wage_usd'));
  assert.ok(out.evidence.guessed.includes('price.index'));
  assert.ok(out.evidence.missing.includes('lease.finca_monthly_usd'));
  assert.ok(out.evidence.sourcedShare > 0 && out.evidence.sourcedShare < 1);
});

test('solo owners pay for opening hours beyond their limit by the hour', () => {
  const busy = { ...niche, model: { ...niche.model, openHoursPerMonth: 300 } };
  const out = buildModel({ niche: busy, template: data.template, location: { slug: 'x', name: 'x', country_code: 'CO' }, ledger: colombia, profile: { ...profile, operator_model: 'solo', owner_hours_per_month: 220 }, tenure: 'lease' });
  const r = analyze(out.model, { simulations: 200, sensitivity: false });
  assert.ok(r.capacity.needsHelp);
  assert.ok(r.capacity.paidHelpHoursP50 >= 300 + niche.model.ownerFixedHours - 220);
  assert.ok(r.capacity.paidHelpCostP50 > 0);
});

test('a loan includes a build period with interest and a lender test', () => {
  const us = mergeLedger([{ scope: 'country', rows: [row('labor.monthly_wage_usd', 2800), row('finance.rate_pct', 8.5), row('finance.min_equity_pct', 0.2), row('land.price_per_acre_usd', 16000)] }]);
  const out = buildModel({ niche, template: data.template, location: { slug: 'x', name: 'x', country_code: 'US' }, ledger: us, profile: { ...profile, financing_allowed: ['sba'] }, tenure: 'own' });
  assert.equal(out.model.financing.minEquityPct, 0.2, 'start-ups put down the typical 20% (SBA floor 10%)');
  const r = analyze(out.model, { simulations: 200, sensitivity: false });
  assert.ok(r.startup.preOpeningMonthsP50 >= 6);
  assert.equal(r.lender.applies, true);
  assert.equal(r.lender.bankable, (r.lender.dscrP50 ?? 0) >= 1.25);
});
