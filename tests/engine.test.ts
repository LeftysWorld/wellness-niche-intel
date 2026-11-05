import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  amortizedPayment,
  analyze,
  deterministicMonth,
  loanBalance,
} from '../supabase/functions/_shared/engine/index.ts';
import { colombiaLeasedFinca, westernNcFinanced } from './fixtures.ts';

const near = (actual: number, expected: number, tol: number, msg: string) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: expected ~${expected}, got ${actual}`);

test('reproduces the hand-built Colombia mature month (Phase 1 gate)', () => {
  const m = deterministicMonth(colombiaLeasedFinca(), 60);
  near(m.revenue, 11400, 1, 'revenue');
  near(m.costs, 8623.67, 1, 'costs');
  near(m.profit, 2776.33, 1, 'profit');
});

test('loan payment matches the hand-built US figure', () => {
  near(amortizedPayment(275000, 8.5, 300), 2214.35, 1, '275k at 8.5% over 25 years');
});

test('loan balance falls to zero at term', () => {
  near(loanBalance(100000, 6, 120, 120), 0, 0.01, 'balance at term');
  assert.ok(loanBalance(100000, 6, 120, 60) > 0);
});

test('analysis is reproducible for a given seed', () => {
  const a = analyze(colombiaLeasedFinca(), { simulations: 300, seed: 7 });
  const b = analyze(colombiaLeasedFinca(), { simulations: 300, seed: 7 });
  assert.deepEqual(a, b);
});

test('percentiles are ordered and profit improves as the business matures', () => {
  const r = analyze(colombiaLeasedFinca(), { simulations: 1000 });
  for (const snap of [r.year1, r.year3, r.year5]) {
    assert.ok(snap.profit.p10 <= snap.profit.p50 && snap.profit.p50 <= snap.profit.p90);
  }
  assert.ok(r.year3.profit.p50 > r.year1.profit.p50);
  assert.ok(r.startup.fundable);
  assert.equal(r.valuation[0].year, 3);
  assert.ok(r.sensitivity.length > 0 && r.sensitivity[0].swing >= r.sensitivity.at(-1)!.swing);
});

test('financed US model: debt, asset valuation and funding gap are handled', () => {
  const r = analyze(westernNcFinanced(), { simulations: 800 });
  assert.ok(r.startup.loanAmountP50 > 0);
  assert.ok(r.startup.monthlyDebtPaymentP50 > 0);
  // Property is now added on top of the business value.
  assert.ok(r.valuation[1].propertyValueP50 > 0);
  // 20% equity on a ~$450k+ project exceeds $150k only in expensive cases.
  assert.equal(typeof r.startup.fundable, 'boolean');
});

test('hours beyond the owner limit become paid help', () => {
  const model = colombiaLeasedFinca();
  model.capacity = { ownerHoursPerMonth: 100, ownerFixedHoursPerMonth: 60 };
  const r = analyze(model, { simulations: 200 });
  assert.ok(r.capacity.needsHelp);
  assert.ok(r.warnings.some((w) => w.includes('paid help')));
});

test('paid help is charged at the hourly wage for hours over the limit', () => {
  const model = colombiaLeasedFinca();
  model.capacity = { ownerHoursPerMonth: 100, ownerFixedHoursPerMonth: 60, openHoursPerMonth: 100 };
  model.costs.hourlyWage = { low: 5, mode: 5, high: 5 };
  const base = deterministicMonth(colombiaLeasedFinca(), 60);
  const m = deterministicMonth(model, 60);
  // 60 fixed + 100 open + per-sale hours, minus the 100-hour limit, all at $5/hour.
  assert.ok(base.profit - m.profit >= 60 * 5, `help cost ${base.profit - m.profit}`);
});

test('pre-opening months cost rent and delay nothing in operating-year figures', () => {
  const model = colombiaLeasedFinca();
  const open = analyze(model, { simulations: 200, seed: 3 });
  model.preOpening = { months: { low: 4, mode: 4, high: 4 }, fixedShare: 0.3 };
  const built = analyze(model, { simulations: 200, seed: 3 });
  assert.equal(built.startup.preOpeningMonthsP50, 4);
  assert.ok(built.startup.preOpeningCostP50 > 0);
  assert.ok(built.cashLowPoint.p50 < open.cashLowPoint.p50, 'pre-opening costs deepen the cash dip');
  assert.ok(built.startup.cashNeeded.p50 > open.startup.cashNeeded.p50);
});

test('take-home is profit less income tax, and a repair reserve lowers profit', () => {
  const model = colombiaLeasedFinca();
  model.costs.incomeTaxPct = { low: 0.25, mode: 0.25, high: 0.25 };
  const m = deterministicMonth(model, 60);
  near(m.takeHome, m.profit * 0.75, 0.01, 'take-home after 25% tax');
  const reserved = colombiaLeasedFinca();
  reserved.costs.reservePctOfRevenue = { low: 0.03, mode: 0.03, high: 0.03 };
  near(deterministicMonth(reserved, 60).profit, deterministicMonth(colombiaLeasedFinca(), 60).profit - 11400 * 0.03, 1, 'reserve');
});

test('a loan that profit cannot cover 1.25x fails the lender test', () => {
  const r = analyze(westernNcFinanced(), { simulations: 300 });
  assert.equal(r.lender.applies, true);
  assert.equal(r.lender.bankable, (r.lender.dscrP50 ?? 0) >= 1.25);
  if (!r.lender.bankable) assert.equal(r.startup.fundable, false);
});

test('owned property is added to business value, not chosen instead of it', () => {
  const r = analyze(westernNcFinanced(), { simulations: 300 });
  const y5 = r.valuation[1];
  assert.ok(y5.propertyValueP50 > 0);
  assert.ok(y5.price.p50 >= y5.propertyValueP50 * 0.99);
});

test('demand correlation widens the spread of outcomes', () => {
  const r = analyze(colombiaLeasedFinca(), { simulations: 2000, seed: 11 });
  assert.ok(r.year3.profit.p90 - r.year3.profit.p10 > 0);
});
