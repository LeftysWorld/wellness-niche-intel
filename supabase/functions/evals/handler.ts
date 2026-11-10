// The evaluation suite: measures each part of the system against a target and
// stores the scores (eval_results; the Activity page shows the latest).
//   ledger      what the ledger holds now vs the answer key (free)
//   scout_live  the scout agent researches answer-key values from scratch in
//               test mode (nothing written); graded when each session finishes
//   coverage    share of the values every place needs that are sourced
//   brainstorm  recall of a held-out list of known formats; junk rate
//   backtest    predicted vs stated revenue of real businesses (calibration)
//   analysis    verified share and how narrow the analysts got the uncertainty
import { startAgent } from '../_shared/agent.ts';
import { locationScout } from '../_shared/agents/index.ts';
import { db, defaultProfile, getSetting, must } from '../_shared/db.ts';
import { ANSWER_KEY, rangeUsd } from '../_shared/evals/answer-key.ts';
import { calibration, gradeRanges, recall, share, type BacktestPrediction } from '../_shared/evals/grading.ts';
import { HELD_OUT_NICHES } from '../_shared/evals/held-out-niches.ts';
import { evaluateBuilt } from '../_shared/evaluate.ts';
import { loadLedger, REQUIRED_LOCATION_KEYS, type LocationRow } from '../_shared/ledger.ts';
import { isEstimate, type LedgerValue, type NicheModelSpec } from '../_shared/model-builder.ts';
import { looksLikeSlug } from '../_shared/niche-intake.ts';
import { latestTemplate } from '../_shared/pairing.ts';
import { inPlay } from '../_shared/places.ts';
import { withRun, type Run } from '../_shared/runs.ts';
import { COUNTRY_KEYS } from '../_shared/scout.ts';

type Row = { metric: string; value: number | null; target: number | null; passed: boolean | null; sample_size?: number; details?: unknown };

async function save(run: Run, suite: string, rows: Row[]) {
  for (const r of rows) await db().from('eval_results').insert({ suite, run_id: run.id, details: {}, ...r });
  return rows.map((r) => ({ metric: r.metric, value: r.value, target: r.target, passed: r.passed }));
}

async function ledgerEval(run: Run) {
  const fx = await getSetting<{ cop_per_usd?: number; crc_per_usd?: number }>('currency');
  const items: { id: string; value: number | null; range: [number, number] | null; written_by: string | null }[] = [];
  for (const e of ANSWER_KEY) {
    const loc = must(await db().from('locations').select('id').eq('slug', e.location).maybeSingle(), 'location');
    // A value researched for one idea is graded on that idea's own value.
    let subject: { type: string; id: string } | null = loc ? { type: 'location', id: loc.id } : null;
    if (loc && e.niche) {
      const n = must(await db().from('niches').select('id').eq('slug', e.niche).maybeSingle(), 'niche');
      const p = n ? must(await db().from('pairings').select('id').eq('niche_id', n.id).eq('location_id', loc.id).limit(1).maybeSingle(), 'pairing') : null;
      subject = p ? { type: 'pairing', id: p.id } : null;
    }
    const cur = subject
      ? must(await db().from('current_assumptions').select('value_num,written_by').eq('subject_type', subject.type).eq('subject_id', subject.id).eq('key', e.key).maybeSingle(), 'value')
      : null;
    items.push({ id: e.id, value: cur?.value_num ?? null, range: rangeUsd(e, fx), written_by: cur?.written_by ?? null });
  }
  const graded = gradeRanges(items);
  const accuracy = share(graded.map((g) => g.pass));
  return save(run, 'ledger', [
    { metric: 'accuracy', value: accuracy, target: 0.85, passed: accuracy >= 0.85, sample_size: graded.length, details: { graded: graded.map((g, i) => ({ ...g, written_by: items[i].written_by })) } },
  ]);
}

async function coverageEval(run: Run) {
  const locs = must(await db().from('locations').select('id,slug,level,active,origin,fit,parent_id'), 'locations') as (LocationRow & { active: boolean })[];
  const micro = locs.filter((l) => l.level === 'micro_area' && inPlay(l));
  const countryIds = new Set(micro.map((l) => l.parent_id).filter(Boolean) as string[]);
  const subjects = [...micro, ...locs.filter((l) => countryIds.has(l.id))];
  let needed = 0;
  let sourced = 0;
  let strong = 0;
  const gaps: Record<string, number> = {};
  for (const l of subjects) {
    const own = REQUIRED_LOCATION_KEYS.filter((k) => (l.level === 'country' ? COUNTRY_KEYS.has(k) : !COUNTRY_KEYS.has(k)));
    const rows = must(await db().from('current_assumptions').select('id,key,value_num,value_text,low,high,confidence,source_url,written_by,is_stale').eq('subject_type', 'location').eq('subject_id', l.id), 'values') as LedgerValue[];
    for (const k of own) {
      needed++;
      const v = rows.find((r) => r.key === k);
      const ok = v && !isEstimate(v) && !v.is_stale;
      if (ok) sourced++;
      if (ok && v!.confidence !== 'low') strong++;
      else gaps[k] = (gaps[k] ?? 0) + 1;
    }
  }
  const s = needed ? Math.round((strong / needed) * 1000) / 1000 : 0;
  return save(run, 'coverage', [
    { metric: 'sourced_medium_plus', value: s, target: 0.8, passed: s >= 0.8, sample_size: needed, details: { places: subjects.length, gaps } },
    { metric: 'sourced_any', value: needed ? Math.round((sourced / needed) * 1000) / 1000 : 0, target: null, passed: null, sample_size: needed },
  ]);
}

async function brainstormEval(run: Run) {
  const lib = must(await db().from('niches').select('id,name,aliases,status,card,created_at'), 'niches') as {
    id: string; name: string; aliases: string[]; status: string; card: Record<string, unknown>; created_at: string;
  }[];
  const r = recall(HELD_OUT_NICHES, lib.map((n) => ({ name: n.name, aliases: n.aliases, description: String(n.card?.description ?? n.card?.summary ?? '') })));
  const since = Date.now() - 60 * 86_400_000;
  const recent = lib.filter((n) => Date.parse(n.created_at) >= since && n.card?.design_id === undefined);
  const counts = must(await db().from('example_businesses').select('niche_id'), 'examples') as { niche_id: string }[];
  const examples = (id: string) => counts.filter((c) => c.niche_id === id).length;
  const junk = recent.map((n) => n.status === 'rejected' || looksLikeSlug(n.name) || examples(n.id) === 0);
  const junkRate = share(junk);
  const sessions = must(
    await db().from('agent_sessions').select('scratch->proposals').eq('agent', 'niche-scout').gte('created_at', new Date(since).toISOString()),
    'brainstorm sessions',
  ) as { proposals: { verdict: string }[] | null }[];
  const proposals = sessions.flatMap((s) => s.proposals ?? []);
  return save(run, 'brainstorm', [
    { metric: 'held_out_recall', value: r.value, target: 0.8, passed: r.value >= 0.8, sample_size: HELD_OUT_NICHES.length, details: { missing: r.found.filter((f) => !f.covered).map((f) => f.name) } },
    { metric: 'junk_rate', value: junkRate, target: 0.05, passed: junkRate <= 0.05, sample_size: recent.length, details: { junk: recent.filter((_, i) => junk[i]).map((n) => n.name) } },
    {
      metric: 'critic_acceptance',
      value: proposals.length ? share(proposals.map((p) => p.verdict === 'accepted')) : null,
      target: null,
      passed: null,
      sample_size: proposals.length,
    },
  ]);
}

async function backtestEval(run: Run) {
  const cases = must(await db().from('backtest_cases').select('*').eq('status', 'ready'), 'cases') as {
    id: string; niche_id: string; business_name: string; country_code: string; annual_revenue_usd: number; sde_usd: number | null; asking_price_usd: number | null; units: number | null;
  }[];
  const profile = await defaultProfile();
  const preds: BacktestPrediction[] = [];
  const skipped: string[] = [];
  for (const c of cases) {
    const niche = must(await db().from('niches').select('id,slug,name,card').eq('id', c.niche_id).maybeSingle(), 'niche');
    const spec = niche?.card?.model as NicheModelSpec | undefined;
    const template = niche ? await latestTemplate(niche.id) : null;
    const country = must(await db().from('locations').select('*').eq('level', 'country').eq('country_code', c.country_code).maybeSingle(), 'country') as LocationRow | null;
    if (!spec || !template || !country) {
      skipped.push(`${c.business_name}: no model, template or country`);
      continue;
    }
    const multiple = c.sde_usd && c.asking_price_usd && c.sde_usd > 0 ? c.asking_price_usd / c.sde_usd : null;
    const multipleRange = { low: spec.exit.sdeMultiple.low, high: spec.exit.sdeMultiple.high };
    // Revenue scales with capacity: without a stated unit count the comparison would be meaningless.
    const primary = [...spec.streams].sort((a, b) => b.units * b.sellablePerUnitPerMonth * b.price.mode - a.units * a.sellablePerUnitPerMonth * a.price.mode)[0];
    if (!c.units || !primary || primary.units * primary.sellablePerUnitPerMonth <= 1) {
      if (multiple) preds.push({ id: c.id, actual: NaN, predicted: { p10: NaN, p50: NaN, p90: NaN }, multiple, multipleRange });
      skipped.push(`${c.business_name}: no unit count for revenue`);
      continue;
    }
    const ledger = await loadLedger(country);
    ledger.set(`units.${primary.key}`, { id: 'backtest', key: `units.${primary.key}`, value_num: c.units, value_text: null, low: null, high: null, confidence: 'high', source_url: 'backtest', written_by: 'backtest', scope: 'pairing' });
    const [best] = evaluateBuilt({ niche: { slug: niche.slug, name: niche.name, model: spec }, template, location: { slug: country.slug, name: country.name, country_code: country.country_code }, ledger, profile: profile.params, simulations: 400, sensitivity: false });
    const rev = best.result.year5.revenue;
    preds.push({ id: c.id, actual: c.annual_revenue_usd, predicted: { p10: rev.p10 * 12, p50: rev.p50 * 12, p90: rev.p90 * 12 }, multiple, multipleRange });
  }
  const revenue = preds.filter((p) => Number.isFinite(p.actual));
  const cal = calibration(revenue);
  const multiples = calibration(preds.filter((p) => p.multiple));
  return save(run, 'backtest', [
    { metric: 'revenue_p10_p90_coverage', value: revenue.length ? cal.coverage : null, target: 0.8, passed: revenue.length >= 5 ? cal.coverage >= 0.7 && cal.coverage <= 0.95 : null, sample_size: revenue.length, details: { ...cal, skipped } },
    { metric: 'revenue_median_log_error', value: cal.medianLogError, target: 0.35, passed: cal.medianLogError === null ? null : cal.medianLogError <= 0.35, sample_size: revenue.length },
    { metric: 'sale_multiple_coverage', value: multiples.multipleCoverage, target: 0.8, passed: multiples.multipleCoverage === null ? null : multiples.multipleCoverage >= 0.7, sample_size: preds.filter((p) => p.multiple).length },
  ]);
}

async function analysisEval(run: Run) {
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const rows = must(await db().from('analysis_results').select('verifier_status,result->research').gte('created_at', since), 'results') as {
    verifier_status: string; research: { rounds?: { band: number }[] } | null;
  }[];
  const checked = rows.filter((r) => ['pass', 'flag', 'fail'].includes(r.verifier_status));
  const bands = rows.map((r) => r.research?.rounds?.at(-1)?.band).filter((b): b is number => typeof b === 'number').sort((a, b) => a - b);
  const settings = await getSetting<{ target_band?: number }>('agents');
  const median = bands.length ? bands[Math.floor(bands.length / 2)] : null;
  return save(run, 'analysis', [
    { metric: 'verifier_pass_share', value: checked.length ? share(checked.map((r) => r.verifier_status === 'pass')) : null, target: 0.7, passed: checked.length >= 3 ? share(checked.map((r) => r.verifier_status === 'pass')) >= 0.7 : null, sample_size: checked.length },
    { metric: 'median_final_band', value: median, target: settings.target_band ?? 0.8, passed: median === null ? null : median <= (settings.target_band ?? 0.8), sample_size: bands.length },
  ]);
}

/** Queue test-mode scout sessions for the answer-key entries checked longest ago. */
async function queueLiveScout(count: number) {
  const last = must(await db().from('latest_evals').select('metric,created_at').eq('suite', 'scout_live'), 'last live') as { metric: string; created_at: string }[];
  const when = (id: string) => Date.parse(last.find((l) => l.metric === id)?.created_at ?? '1970-01-01');
  const picked = ANSWER_KEY.filter((e) => !e.niche).sort((a, b) => when(a.id) - when(b.id)).slice(0, count);
  const byLocation = new Map<string, typeof picked>();
  for (const e of picked) byLocation.set(e.location, [...(byLocation.get(e.location) ?? []), e]);
  const started: unknown[] = [];
  for (const [slug, entries] of byLocation) {
    const loc = must(await db().from('locations').select('id').eq('slug', slug).maybeSingle(), 'location');
    if (!loc) continue;
    started.push(
      await startAgent(locationScout, { location_id: loc.id, keys: [...new Set(entries.map((e) => e.key))], dry_run: true, eval_ids: entries.map((e) => e.id) }, { subjectId: loc.id, input: { via: 'evals' }, background: true }),
    );
  }
  return { queued: picked.map((e) => e.id), sessions: started.length };
}

export async function run(body: Record<string, unknown>) {
  const suite = String(body.suite ?? 'all');
  const want = (s: string) => suite === 'all' || suite === s;
  return withRun('eval', { tokenBudget: 0, searchBudget: 0, input: body }, async (run) => {
    const out: Record<string, unknown> = {};
    if (want('ledger')) out.ledger = await ledgerEval(run);
    if (want('coverage')) out.coverage = await coverageEval(run);
    if (want('brainstorm')) out.brainstorm = await brainstormEval(run);
    if (want('backtest')) out.backtest = await backtestEval(run);
    if (want('analysis')) out.analysis = await analysisEval(run);
    if (want('scout_live') && body.live !== false) out.scout_live = await queueLiveScout(Number(body.live_count ?? 2));
    return out;
  });
}
