import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { demandGaps, demandPull, MAX_PER_HOST, scoreDemand, type DemandSignal } from '../supabase/functions/_shared/demand.ts';

const sig = (scope: 'market' | 'area', direction: 'for' | 'against', strength: 1 | 2 | 3, host: string, kind = scope === 'market' ? 'search_trend' : 'busy_competitors'): DemandSignal =>
  ({ scope, kind: kind as DemandSignal['kind'], direction, strength, finding: 'x', url: `https://${host}/p`, host });

test('no signals: unclear at the midpoint', () => {
  const s = scoreDemand([], 'area');
  assert.equal(s.level, 'unclear');
  assert.equal(s.score, 5);
});

test('a couple of hints cannot reach the extremes', () => {
  const s = scoreDemand([sig('area', 'for', 1, 'a.com'), sig('area', 'for', 1, 'b.com')], 'area');
  assert.ok(s.score > 5 && s.score < 7, String(s.score));
});

test('strong evidence from several sites scores high with high confidence', () => {
  const s = scoreDemand(['a', 'b', 'c', 'd'].map((h) => sig('area', 'for', 3, `${h}.com`)), 'area');
  assert.equal(s.score, 10);
  assert.equal(s.level, 'strong');
  assert.equal(s.confidence, 'high');
});

test('evidence against pulls the score down', () => {
  const s = scoreDemand([sig('area', 'for', 1, 'a.com'), sig('area', 'against', 3, 'b.com'), sig('area', 'against', 3, 'c.com')], 'area');
  assert.ok(s.score < 4.5);
  assert.equal(s.level, 'weak');
});

test('one website counts at most twice', () => {
  const many = Array.from({ length: 6 }, () => sig('market', 'for', 3, 'blog.com'));
  const s = scoreDemand(many, 'market');
  assert.equal(s.signals, MAX_PER_HOST);
  assert.equal(s.confidence, 'low');
});

test('scopes are scored apart; the area weighs more overall', () => {
  const p = demandPull([sig('market', 'for', 3, 'a.com'), sig('market', 'for', 3, 'b.com'), sig('area', 'against', 3, 'c.com'), sig('area', 'against', 3, 'd.com')]);
  assert.ok(p.market.score > 5 && p.area.score < 5);
  assert.ok(p.overall < 5, String(p.overall));
});

test('the analyst cannot finish without both scopes and a fresh assessment', () => {
  assert.match(demandGaps([], undefined)!, /market and one area/);
  const both = [sig('market', 'for', 2, 'a.com'), sig('area', 'for', 2, 'b.com')];
  assert.match(demandGaps(both, undefined)!, /assess_demand/);
  assert.match(demandGaps(both, 1)!, /assess_demand/);
  assert.equal(demandGaps(both, 2), null);
});

test('the analyst playbook asks for demand pull in both scopes', () => {
  const md = readFileSync(new URL('../supabase/functions/agents/pairing-analyst.md', import.meta.url), 'utf8');
  assert.match(md, /demand pull/i);
  assert.match(md, /record_demand_signal/);
  assert.match(md, /assess_demand/);
});
