// Tests for the pure parts of the agent system: evidence checks, history
// handling, driver mapping, niche intake, graders, the competition factor,
// the answer key, and the playbooks (compiled and free of held-out answers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { containsQuote, quoteHasNumber, squash, windows } from '../supabase/functions/_shared/evidence.ts';
import { appendUser, compact, withCacheBreakpoint, type Message } from '../supabase/functions/_shared/history.ts';
import { driverKeys, PAIRING_KEY, uncertaintyBand } from '../supabase/functions/_shared/drivers.ts';
import { displayName, intakeProblems, looksLikeSlug } from '../supabase/functions/_shared/niche-intake.ts';
import { calibration, gradeRanges, recall } from '../supabase/functions/_shared/evals/grading.ts';
import { HELD_OUT_NICHES } from '../supabase/functions/_shared/evals/held-out-niches.ts';
import { ANSWER_KEY, rangeUsd } from '../supabase/functions/_shared/evals/answer-key.ts';
import { buildModel, competitionFactor, mergeLedger, type LedgerValue } from '../supabase/functions/_shared/model-builder.ts';
import { analyze } from '../supabase/functions/_shared/engine/index.ts';
import { render } from '../scripts/build_playbooks.mjs';

// --- evidence ---------------------------------------------------------------

test('quotes match despite curly quotes, dashes and spacing', () => {
  const page = 'Lots from “$12,900” – per acre.\n\nGreat   views';
  assert.ok(containsQuote(page, 'lots from "$12,900" - per acre. great views'));
  assert.ok(!containsQuote(page, 'lots from $13,900'));
  assert.ok(!containsQuote(page, 'lot'), 'very short quotes never count');
  assert.equal(squash('A B'), 'a b');
});

test('a quote must contain the figure as printed, in any number format', () => {
  assert.ok(quoteHasNumber('El salario mínimo quedó en $1.750.905 mensuales', 'COP 1.750.905'));
  assert.ok(quoteHasNumber('Rent: $1,950/month, 12-month lease', '$1,950'));
  assert.ok(!quoteHasNumber('Rent: $1,950/month', '$2,400'));
  assert.ok(quoteHasNumber('no figure needed', ''));
});

test('windows returns merged passages around search terms', () => {
  const text = `${'x'.repeat(1000)} price per night 120 ${'y'.repeat(50)} per night 150 ${'z'.repeat(1000)}`;
  const w = windows(text, ['per night'], 100);
  assert.equal(w.length, 1, 'overlapping windows merge');
  assert.ok(w[0].includes('120') && w[0].includes('150'));
});

// --- history ----------------------------------------------------------------

test('only the newest message carries the cache breakpoint', () => {
  const h: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'task', cache_control: { type: 'ephemeral' } }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'web_search', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'results' }] },
  ];
  const out = withCacheBreakpoint(h);
  const marked = JSON.stringify(out).match(/cache_control/g) ?? [];
  assert.equal(marked.length, 1);
  assert.ok(JSON.stringify(out[2]).includes('cache_control'));
  assert.ok(!JSON.stringify(h[2]).includes('cache_control'), 'input is not mutated');
});

test('compact shortens old tool results only when history is large, and keeps the last thinking', () => {
  const big = 'r'.repeat(30_000);
  const h: Message[] = [{ role: 'user', content: 'task' }];
  for (let i = 0; i < 8; i++) {
    h.push({ role: 'assistant', content: [{ type: 'thinking', thinking: `t${i}`, signature: 's' }, { type: 'tool_use', id: `u${i}`, name: 'fetch_page', input: {} }] });
    h.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `u${i}`, content: big }] });
  }
  const out = compact(h);
  const first = out[2].content as { content: string }[];
  assert.ok(first[0].content.length < 500, 'old results shortened');
  const last = out[out.length - 1].content as { content: string }[];
  assert.equal(last[0].content.length, big.length, 'recent results kept whole');
  const thinking = out.filter((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'thinking'));
  assert.equal(thinking.length, 1, 'only the newest assistant turn keeps its thinking');
  // Small histories are left alone apart from old thinking.
  const small = compact(h.slice(0, 3));
  assert.equal(((small[2].content as { content: string }[])[0]).content.length, big.length);
});

test('tool results and notes go in one user message after the assistant turn', () => {
  const h: Message[] = [{ role: 'user', content: 'go' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'x', input: {} }] }];
  appendUser(h, [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }]);
  appendUser(h, [{ type: 'text', text: 'note' }]);
  assert.equal(h.length, 3);
  assert.equal((h[2].content as unknown[]).length, 2);
});

// --- drivers ----------------------------------------------------------------

const data = JSON.parse(readFileSync(new URL('./data/dark-retreat.json', import.meta.url), 'utf8'));
const niche = { slug: 'dark-retreat', name: 'Dark retreat', model: data.card.model };
const profile = { capital_usd: { min: 100000, max: 150000 }, financing_allowed: ['cash', 'sba', 'lease'], owner_hours_per_month: 220 };
let n = 0;
const row = (key: string, value: number, extra: Partial<LedgerValue> = {}): LedgerValue => ({
  id: `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`, key, value_num: value, value_text: null,
  low: null, high: null, confidence: 'medium', source_url: 'https://example.org', written_by: 'seed', ...extra,
});
const ledger = () =>
  mergeLedger([
    { scope: 'country', rows: [row('labor.monthly_wage_usd', 900), row('price.index', 0.6), row('build.cost_index', 0.55), row('tax.revenue_pct', 0.05, { written_by: 'seed:estimate' })] },
    { scope: 'micro_area', rows: [row('lease.finca_monthly_usd', 3195), row('demand.multiplier', 1)] },
  ]);

test('profit drivers map to the ledger values behind them', () => {
  const b = buildModel({ niche, template: data.template, location: { slug: 'x', name: 'X', country_code: 'CO' }, ledger: ledger(), profile, tenure: 'lease' });
  const r = analyze(b.model, { simulations: 50, seed: 1 });
  const d = driverKeys(b.model, r.sensitivity, { tenure: 'lease', siteType: niche.model.siteType, evidence: b.evidence });
  const stream = b.model.streams[0];
  const price = d.find((x) => x.input === `${stream.label}: price`);
  assert.equal(price?.key, `price.${stream.key}_usd`);
  assert.equal(price?.scope, 'pairing');
  assert.equal(price?.status, 'guessed', 'a price with no idea-specific value is guessed');
  const lease = d.find((x) => x.input === 'Lease');
  if (lease) {
    assert.equal(lease.key, 'lease.finca_monthly_usd');
    assert.equal(lease.status, 'sourced');
  }
  const tax = driverKeys(b.model, [{ input: 'Revenue taxes', lowProfit: 0, highProfit: 1, swing: 1 }], { tenure: 'lease', evidence: b.evidence })[0];
  assert.equal(tax.key, 'tax.revenue_pct');
  assert.equal(tax.status, 'guessed');
  const nicheOwn = driverKeys(b.model, [{ input: 'Insurance', lowProfit: 0, highProfit: 1, swing: 1 }], { tenure: 'lease', evidence: b.evidence })[0];
  assert.equal(nicheOwn.key, null);
  assert.equal(nicheOwn.status, 'niche');
});

test('pairing keys and the uncertainty band', () => {
  assert.ok(PAIRING_KEY.test('price.dark_nights_usd'));
  assert.ok(PAIRING_KEY.test('occupancy.dark_nights.mature'));
  assert.ok(PAIRING_KEY.test('demand.competitors_60min'));
  assert.ok(!PAIRING_KEY.test('lease.finca_monthly_usd'));
  assert.equal(uncertaintyBand({ p10: 1000, p50: 2000, p90: 3000 }), 1);
  assert.equal(uncertaintyBand({ p10: -400, p50: 0, p90: 600 }), 2, 'a P50 near zero uses a $500 floor');
});

// --- competition --------------------------------------------------------------

test('competition shifts expected occupancy in steps', () => {
  assert.equal(competitionFactor(0), 1);
  assert.equal(competitionFactor(2), 1.05);
  assert.equal(competitionFactor(4), 0.95);
  assert.equal(competitionFactor(7), 0.85);
  assert.equal(competitionFactor(25), 0.75);
  const base = buildModel({ niche, template: data.template, location: { slug: 'x', name: 'X', country_code: 'CO' }, ledger: ledger(), profile, tenure: 'lease' });
  const crowded = ledger();
  crowded.set('demand.competitors_60min', { ...row('demand.competitors_60min', 12), scope: 'pairing' });
  const c = buildModel({ niche, template: data.template, location: { slug: 'x', name: 'X', country_code: 'CO' }, ledger: crowded, profile, tenure: 'lease' });
  const s = base.model.streams.findIndex((x) => x.units * x.sellablePerUnitPerMonth > 1);
  assert.ok(c.model.streams[s].matureOccupancy.mode < base.model.streams[s].matureOccupancy.mode);
  assert.ok(c.evidence.sourced.includes('demand.competitors_60min'));
});

// --- niche intake -------------------------------------------------------------

test('names are stored as words', () => {
  assert.equal(displayName('camp-and-retreat-center'), 'Camp and retreat center');
  assert.equal(displayName('hotel_spa_wellness'), 'Hotel spa wellness');
  assert.equal(displayName('Example: Nordic bathhouse'), 'Nordic bathhouse');
  assert.equal(displayName('Kneipp trail'), 'Kneipp trail');
  assert.ok(looksLikeSlug('luxury-wellness-resort'));
  assert.ok(!looksLikeSlug('Luxury wellness resort'));
});

test('intake rejects thin, oversized, excluded or non-land proposals', () => {
  const ok = {
    name: 'Riverside barrel-sauna camp',
    needs_land_or_structure: true,
    solo_operable: true,
    est_startup_usd: { low: 60000, high: 140000 },
    risk_tags: [],
    confirmedExamples: [{ url: 'https://a.example/x' }, { url: 'https://www.b.example/y' }],
  };
  const prof = { capital_max: 150000, excluded_tags: ['psychedelic', 'medical_license'] };
  assert.deepEqual(intakeProblems(ok, prof), []);
  assert.equal(intakeProblems({ ...ok, confirmedExamples: [{ url: 'https://a.example/1' }, { url: 'https://a.example/2' }] }, prof).length, 1, 'two pages on one site are one source');
  assert.ok(intakeProblems({ ...ok, est_startup_usd: { low: 900000, high: 2000000 } }, prof)[0].includes('far over'));
  assert.ok(intakeProblems({ ...ok, risk_tags: ['psychedelic'] }, prof)[0].includes('excludes'));
  assert.equal(intakeProblems({ ...ok, needs_land_or_structure: false, name: 'urban-studio' }, prof).length, 2);
});

// --- graders ------------------------------------------------------------------

test('range grading: inside passes, missing fails, misses are measured', () => {
  const g = gradeRanges([
    { id: 'a', value: 10, range: [5, 15] },
    { id: 'b', value: 20, range: [5, 15] },
    { id: 'c', value: null, range: [5, 15] },
  ]);
  assert.deepEqual(g.map((x) => x.pass), [true, false, false]);
  assert.equal(g[1].miss, 0.333);
});

test('recall matches formats by phrase in name, aliases or description', () => {
  const lib = [
    { name: 'Dark retreat', aliases: ['darkness retreat'] },
    { name: 'Nature bathhouse', description: 'wood-fired saunas and a cold plunge' },
    { name: 'Hidden gem', description: 'a temazcal sweat lodge ceremony' },
  ];
  const r = recall(HELD_OUT_NICHES, lib);
  const covered = r.found.filter((f) => f.covered).map((f) => f.name);
  assert.ok(covered.includes('Dark retreat'));
  assert.ok(covered.includes('Mesoamerican temazcal'));
  assert.ok(covered.includes('Contrast-therapy bathhouse'));
  assert.ok(!covered.includes('Russian banya'));
  assert.ok(r.value > 0 && r.value < 0.2);
});

test('calibration: coverage of the P10-P90 range, log error and bias', () => {
  const preds = [
    { id: '1', actual: 100, predicted: { p10: 80, p50: 100, p90: 130 } },
    { id: '2', actual: 200, predicted: { p10: 80, p50: 100, p90: 130 } },
    { id: '3', actual: 90, predicted: { p10: 80, p50: 100, p90: 130 }, multiple: 2.5, multipleRange: { low: 1.8, high: 3 } },
    { id: '4', actual: 300, predicted: { p10: 80, p50: 100, p90: 130 }, multiple: 6, multipleRange: { low: 1.8, high: 3 } },
  ];
  const c = calibration(preds);
  assert.equal(c.coverage, 0.5);
  assert.equal(c.bias, 'pessimistic');
  assert.equal(c.multipleCoverage, 0.5);
  assert.ok(c.medianLogError! > 0);
});

// --- answer key ---------------------------------------------------------------

test('answer key entries are sourced, ordered and convert to USD', () => {
  const ids = new Set<string>();
  for (const e of ANSWER_KEY) {
    assert.ok(!ids.has(e.id), `duplicate id ${e.id}`);
    ids.add(e.id);
    assert.ok(e.sources.length >= 1 && e.sources.every((s) => s.startsWith('https://')), `${e.id} needs sources`);
    assert.ok(e.range[0] < e.range[1], `${e.id} range must be ordered`);
  }
  const co = ANSWER_KEY.find((e) => e.id === 'co-wage-2026')!;
  assert.deepEqual(rangeUsd(co, { cop_per_usd: 4000 }), [625, 750]);
  assert.equal(rangeUsd(co, {}), null, 'no exchange rate, no grade');
});

// --- playbooks ----------------------------------------------------------------

const agentsDir = new URL('../supabase/functions/agents/', import.meta.url);

test('the compiled playbooks are up to date', () => {
  const current = readFileSync(new URL('../supabase/functions/_shared/playbooks.ts', import.meta.url), 'utf8');
  assert.equal(current, render(), 'run node scripts/build_playbooks.mjs');
});

test('every agent has a playbook', () => {
  for (const name of ['_shared', 'location-scout', 'pairing-analyst', 'niche-scout', 'backtest-collector']) {
    assert.ok(existsSync(new URL(`${name}.md`, agentsDir)), `agents/${name}.md missing`);
  }
});

test('no playbook leaks the held-out formats the brainstorm is graded on', () => {
  const text = readdirSync(agentsDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => readFileSync(new URL(f, agentsDir), 'utf8').toLowerCase())
    .join('\n');
  // Formats the library already covers are not secrets; the rest must stay out of prompts.
  const known = ['dark retreat', 'darkness retreat', 'bathhouse', 'cold plunge', 'contrast therapy', 'hot spring', 'forest bathing', 'float spa', 'equine', 'silent retreat', 'yoga retreat'];
  for (const h of HELD_OUT_NICHES) {
    for (const m of h.match) {
      if (known.includes(m)) continue;
      assert.ok(!text.includes(m.toLowerCase()), `playbooks mention held-out "${m}"`);
    }
  }
});
