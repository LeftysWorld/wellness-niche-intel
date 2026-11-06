import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inRange, sumParts } from '../supabase/functions/_shared/guards.ts';

test('an all-industry professional wage is outside the hospitality range', () => {
  assert.equal(inRange('labor.monthly_wage_usd', 8127.6), false);
  assert.equal(inRange('labor.monthly_wage_usd', 3200), true);
});

test('a nightly vacation rate times 30 is not a plausible estate lease', () => {
  assert.equal(inRange('lease.estate_monthly_usd', 27480), false);
  assert.equal(inRange('lease.estate_monthly_usd', 4500), true);
});

test('keys without a range are always in range', () => {
  assert.equal(inRange('demand.multiplier', 99), true);
});

test('catchment population adds up one confirmed figure per town', () => {
  const r = sumParts([
    { value: 17000, url: 'https://a.example/x', confirmed: true, part: 'morgan county' },
    { value: 130000, url: 'https://b.example/y', confirmed: true, part: 'berkeley county' },
    { value: 129000, url: 'https://c.example/z', confirmed: true, part: 'berkeley county' },
    { value: 45000, url: 'https://a.example/w', confirmed: true, part: 'hancock area' },
    { value: 999999, url: 'https://d.example/q', confirmed: false, part: 'unconfirmed' },
  ]);
  assert.ok(r);
  assert.equal(r.value, 17000 + 130000 + 45000);
  assert.equal(r.kept.length, 3);
  assert.equal(r.confidence, 'medium');
});

test('one town alone is not a catchment', () => {
  assert.equal(sumParts([{ value: 20700, url: 'https://a.example', confirmed: true, part: 'el retiro' }]), null);
});
