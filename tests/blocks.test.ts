import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKS, composeBrief, describeBlock } from '../supabase/functions/_shared/blocks.ts';

test('every block has a known category and unique type', () => {
  const types = BLOCKS.map((b) => b.type);
  assert.equal(new Set(types).size, types.length);
  assert.ok(BLOCKS.length >= 50);
});

test('a block reads as a plain line with its settings', () => {
  const line = describeBlock({ uid: '1', type: 'stays', params: { kind: 'Geodesic domes', units: 4, price: 220 } });
  assert.equal(line, 'Overnight stays: Geodesic domes; units 4; price per night $220');
});

test('a design becomes a brief with sections, questions and searches', () => {
  const b = composeBrief(
    'Forest fire-and-ice',
    [
      { uid: 'a', type: 'theme', params: { text: 'Nordic forest bathhouse' } },
      { uid: 'b', type: 'base_niche', params: { niche: 'n1' } },
      { uid: 'c', type: 'day_pass', params: { capacity: 30, price: 45 } },
      { uid: 'd', type: 'stays', params: { kind: 'Cabins', units: 3 } },
      { uid: 'e', type: 'sauna', params: { count: 2 } },
      { uid: 'f', type: 'property', params: { choice: 'Rent land and build my own' } },
      { uid: 'g', type: 'question', params: { text: 'What do sauna memberships cost near Asheville?' } },
      { uid: 'h', type: 'price_check', params: { text: 'cabin stays' } },
    ],
    { niches: { n1: 'Nature bathhouse' } },
  );
  assert.match(b.text, /Theme: Nordic forest bathhouse/);
  assert.match(b.text, /Offers:\n- Day passes or entry: guests per day 30; price per visit \$45/);
  assert.match(b.text, /Facilities:\n- Sauna: how many 2; Cabin sauna/);
  assert.match(b.text, /Property: Rent land and build my own/);
  assert.match(b.text, /Start from a niche: Nature bathhouse/);
  assert.equal(b.questions.length, 2);
  assert.equal(b.baseNicheId, 'n1');
  assert.ok(b.queries.some((q) => q.includes('Nordic forest bathhouse')));
});
