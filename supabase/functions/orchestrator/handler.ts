// Orchestrator: the scheduler calls this with a task.
//   task=tick     (hourly)  change events → mark affected pairings for re-analysis;
//                           analyse the next approved pairing.
//   task=refresh  (daily)   re-scout the locations with the stalest data.
//   task=digest   (weekly)  write a summary of the week.
// Each call does a small, bounded amount of work so it fits the function time limit.
import { analyzePairing } from '../_shared/analysis.ts';
import { db, getSetting, must, type Budgets } from '../_shared/db.ts';
import { HttpError } from '../_shared/http.ts';
import { withRun } from '../_shared/runs.ts';
import { scoutLocation } from '../_shared/scout.ts';

async function processChangeEvents() {
  const events = must(await db().from('change_events').select('*').is('processed_at', null).limit(200), 'change events');
  if (!events.length) return { events: 0, requeued: 0 };
  const pairingIds = new Set<string>();
  for (const e of events) {
    if (e.subject_type === 'pairing' && e.subject_id) pairingIds.add(e.subject_id);
    if (e.subject_type === 'location' && e.subject_id) {
      // A country value affects every micro-area below it.
      const children = must(await db().from('locations').select('id').eq('parent_id', e.subject_id), 'children').map((c) => c.id);
      const locs = [e.subject_id, ...children];
      const ps = must(await db().from('pairings').select('id').in('location_id', locs).in('status', ['analyzed', 'verified']), 'affected');
      ps.forEach((p) => pairingIds.add(p.id));
    }
    if (e.subject_type === 'global') {
      const ps = must(await db().from('pairings').select('id').in('status', ['analyzed', 'verified']), 'affected');
      ps.forEach((p) => pairingIds.add(p.id));
    }
  }
  if (pairingIds.size) await db().from('pairings').update({ status: 'approved' }).in('id', [...pairingIds]).in('status', ['analyzed', 'verified']);
  await db().from('change_events').update({ processed_at: new Date().toISOString() }).in('id', events.map((e) => e.id));
  return { events: events.length, requeued: pairingIds.size };
}

async function syncApprovals() {
  // Owner decisions in the review queue move niches and pairings forward.
  const decided = must(
    await db().from('review_queue').select('id,item_type,item_id,status,payload').in('status', ['approved', 'rejected']).is('payload->>synced', null).limit(100),
    'decisions',
  );
  for (const d of decided) {
    if (d.item_type === 'niche') await db().from('niches').update({ status: d.status }).eq('id', d.item_id).eq('status', 'proposed');
    if (d.item_type === 'shortlist') await db().from('pairings').update({ status: d.status }).eq('id', d.item_id).eq('status', 'awaiting_approval');
    await db().from('review_queue').update({ payload: { ...(d.payload ?? {}), synced: true } }).eq('id', d.id);
  }
  return decided.length;
}

async function digest() {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 86_400_000);
  const since = start.toISOString();
  const [niches, examples, pairings, pending, spend, runs] = await Promise.all([
    db().from('niches').select('name,status,signal_score').gte('created_at', since),
    db().from('example_businesses').select('name,country,niches(name)').gte('first_seen_at', since).limit(50),
    db().from('pairings').select('score_total,rough_profit_year3,status,niches(name),locations(name)').in('status', ['analyzed', 'verified', 'awaiting_approval']).order('score_total', { ascending: false }).limit(10),
    db().from('review_queue').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    db().from('spend_log').select('provider,model,input_tokens,output_tokens,calls').gte('created_at', since),
    db().from('runs').select('kind,status').gte('started_at', since),
  ]);
  const tokens = (spend.data ?? []).reduce((s, r) => s + r.input_tokens + r.output_tokens, 0);
  const searches = (spend.data ?? []).filter((r) => r.model === 'search').reduce((s, r) => s + r.calls, 0);
  const content = {
    new_niches: niches.data ?? [],
    new_examples: examples.data ?? [],
    top_pairings: pairings.data ?? [],
    pending_reviews: pending.count ?? 0,
    tokens,
    searches,
    runs: (runs.data ?? []).reduce((acc: Record<string, number>, r) => ((acc[`${r.kind}:${r.status}`] = (acc[`${r.kind}:${r.status}`] ?? 0) + 1), acc), {}),
  };
  const row = must(await db().from('digests').insert({ period_start: since, period_end: end.toISOString(), content }).select('id').single(), 'digest');
  return { digest: row.id, ...content, new_examples: content.new_examples.length, new_niches: content.new_niches.length };
}

export async function run(body: Record<string, unknown>) {
  const task = String(body.task ?? 'tick');
  const budgets = await getSetting<Budgets>('budgets');

  if (task === 'tick') {
    const decisions = await syncApprovals();
    const changes = await processChangeEvents();
    const next = must(
      await db().from('pairings').select('id').eq('status', 'approved').order('score_total', { ascending: false, nullsFirst: false }).limit(1).maybeSingle(),
      'next pairing',
    );
    if (!next) return { decisions, changes, analysed: null };
    const analysis = await withRun('analysis', { tokenBudget: budgets.analysis_tokens + budgets.verify_tokens, searchBudget: 6, subjectId: next.id, input: { via: 'orchestrator' } }, (run) =>
      analyzePairing(run, next.id, { research: true, verify: true }),
    );
    return { decisions, changes, analysed: analysis };
  }

  if (task === 'refresh') {
    const limit = Number(body.limit ?? 2);
    // Stalest first: locations whose newest value is oldest (or that have none).
    const locs = must(await db().from('locations').select('id,slug').eq('active', true), 'locations');
    const ages = await Promise.all(
      locs.map(async (l) => {
        const r = must(await db().from('current_assumptions').select('retrieved_at').eq('subject_type', 'location').eq('subject_id', l.id).order('retrieved_at', { ascending: false }).limit(1).maybeSingle(), 'age');
        return { ...l, newest: r?.retrieved_at ? Date.parse(r.retrieved_at) : 0 };
      }),
    );
    const pick = ages.sort((a, b) => a.newest - b.newest).slice(0, limit);
    return withRun('monthly_refresh', { tokenBudget: budgets.location_scout_tokens, searchBudget: 12 * limit, input: body }, async (run) => {
      const out: unknown[] = [];
      for (const l of pick) out.push(await scoutLocation(run, l.id));
      return { refreshed: out };
    });
  }

  if (task === 'digest') {
    return withRun('digest', { tokenBudget: 0, searchBudget: 0, input: body }, () => digest());
  }

  throw new HttpError(400, `Unknown task ${task}`);
}
