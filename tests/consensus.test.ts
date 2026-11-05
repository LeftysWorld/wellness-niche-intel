import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consensus } from '../supabase/functions/_shared/consensus.ts';

const o = (value: number, url: string, confirmed = true) => ({ value, url, confirmed });

test('three agreeing sites give a high-confidence median', () => {
  const c = consensus([o(2000, 'https://a.com/1'), o(2200, 'https://b.com/2'), o(2400, 'https://c.com/3')])!;
  assert.equal(c.value, 2200);
  assert.equal(c.sources, 3);
  assert.equal(c.confidence, 'high');
  assert.ok(c.low <= 2200 && c.high >= 2200);
});

test('listings from one site count as one source', () => {
  const c = consensus([o(2000, 'https://www.a.com/1'), o(2100, 'https://a.com/2'), o(2200, 'https://a.com/3')])!;
  assert.equal(c.sources, 1);
  assert.equal(c.confidence, 'low');
});

test('outliers more than 3x from the median are dropped', () => {
  const c = consensus([o(2000, 'https://a.com'), o(2100, 'https://b.com'), o(2300, 'https://c.com'), o(450000, 'https://d.com')])!;
  assert.equal(c.dropped.length, 1);
  assert.equal(c.value, 2100);
});

test('unconfirmed figures are used only when nothing is confirmed, at low confidence', () => {
  const mixed = consensus([o(1000, 'https://a.com', false), o(3000, 'https://b.com'), o(3100, 'https://c.com')])!;
  assert.equal(mixed.kept.every((k) => k.confirmed), true);
  const none = consensus([o(1000, 'https://a.com', false), o(1100, 'https://b.com', false), o(1200, 'https://c.com', false)])!;
  assert.equal(none.confidence, 'low');
  assert.equal(none.value, 1100);
});

test('wide disagreement caps confidence below high', () => {
  const c = consensus([o(1000, 'https://a.com'), o(1500, 'https://b.com'), o(2900, 'https://c.com'), o(2950, 'https://d.com')])!;
  assert.notEqual(c.confidence, 'high');
});

test('nothing usable returns null', () => {
  assert.equal(consensus([]), null);
  assert.equal(consensus([o(0, 'https://a.com'), o(-5, 'https://b.com')]), null);
});
