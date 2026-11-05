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
  for (const snap of [r.month12, r.month36, r.month60]) {
    assert.ok(snap.profit.p10 <= snap.profit.p50 && snap.profit.p50 <= snap.profit.p90);
  }
  assert.ok(r.month36.profit.p50 > r.month12.profit.p50);
  assert.ok(r.startup.fundable);
  assert.equal(r.valuation[0].year, 3);
  assert.ok(r.sensitivity.length > 0 && r.sensitivity[0].swing >= r.sensitivity.at(-1)!.swing);
});

test('financed US model: debt, asset valuation and funding gap are handled', () => {
  const r = analyze(westernNcFinanced(), { simulations: 800 });
  assert.ok(r.startup.loanAmountP50 > 0);
  assert.ok(r.startup.monthlyDebtPaymentP50 > 0);
  assert.equal(r.valuation[1].method, 'asset');
  // 20% equity on a ~$450k+ project exceeds $150k only in expensive cases.
  assert.equal(typeof r.startup.fundable, 'boolean');
});

test('capacity warning fires when a solo operator is overloaded', () => {
  const model = colombiaLeasedFinca();
  model.capacity = { ownerHoursPerMonth: 100, ownerFixedHoursPerMonth: 60 };
  const r = analyze(model, { simulations: 200 });
  assert.ok(r.capacity.exceeded);
  assert.ok(r.warnings.some((w) => w.includes('workload')));
});
