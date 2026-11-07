// Run records and token/search budgets. Every agent works inside a run; the run
// is the unit of cost tracking and the audit trail for what was written.
import { db, must } from './db.ts';

export class BudgetExceeded extends Error {}
/** Thrown when a job of the same kind is already running. */
export class AlreadyRunning extends Error {}

export interface SpendCaps {
  daily_tokens: number;
  monthly_tokens: number;
  daily_searches: number;
  monthly_searches: number;
}

let capsCache: { at: number; totals: Record<string, number>; caps: SpendCaps } | null = null;

/**
 * Overall limits across every run (schedules and buttons alike). Checked before
 * each AI call and each search; totals are re-read at most every 20 seconds.
 */
export async function checkSpendCaps(what: 'tokens' | 'searches'): Promise<void> {
  if (!capsCache || Date.now() - capsCache.at > 20_000) {
    const { data: totals } = await db().rpc('spend_totals');
    const { data: setting } = await db().from('settings').select('value').eq('key', 'budgets').maybeSingle();
    const b = (setting?.value ?? {}) as Partial<SpendCaps>;
    capsCache = {
      at: Date.now(),
      totals: (totals?.[0] ?? totals ?? {}) as Record<string, number>,
      caps: {
        daily_tokens: b.daily_tokens ?? 1_500_000,
        monthly_tokens: b.monthly_tokens ?? 15_000_000,
        daily_searches: b.daily_searches ?? 60,
        monthly_searches: b.monthly_searches ?? 900,
      },
    };
  }
  const { totals, caps } = capsCache;
  if (what === 'tokens') {
    if ((totals.tokens_today ?? 0) >= caps.daily_tokens) throw new BudgetExceeded(`Paused: daily AI budget of ${caps.daily_tokens.toLocaleString()} tokens reached`);
    if ((totals.tokens_month ?? 0) >= caps.monthly_tokens) throw new BudgetExceeded(`Paused: monthly AI budget of ${caps.monthly_tokens.toLocaleString()} tokens reached`);
  } else {
    if ((totals.searches_today ?? 0) >= caps.daily_searches) throw new BudgetExceeded(`Paused: daily search budget of ${caps.daily_searches} reached`);
    if ((totals.searches_month ?? 0) >= caps.monthly_searches) throw new BudgetExceeded(`Paused: monthly search budget of ${caps.monthly_searches} reached`);
  }
}

/** Count usage locally between re-reads so a single run can't overshoot the caps. */
export function noteSpend(tokens: number, searches: number) {
  if (!capsCache) return;
  capsCache.totals.tokens_today = (capsCache.totals.tokens_today ?? 0) + tokens;
  capsCache.totals.tokens_month = (capsCache.totals.tokens_month ?? 0) + tokens;
  capsCache.totals.searches_today = (capsCache.totals.searches_today ?? 0) + searches;
  capsCache.totals.searches_month = (capsCache.totals.searches_month ?? 0) + searches;
}

export interface Run {
  id: string;
  kind: string;
  tokenBudget: number;
  searchBudget: number;
  tokensUsed: number;
  searchCalls: number;
  assumptionIds: string[];
  charge(tokens: number): Promise<void>;
  chargeSearch(): void;
  remaining(): number;
}

export async function startRun(
  kind: string,
  opts: { tokenBudget: number; searchBudget?: number; profileId?: string; subjectId?: string; input?: unknown; exclusive?: boolean },
): Promise<Run> {
  // Runs with no sign of life for 30 minutes died mid-way (time limit or crash).
  // Agent sessions that span several calls keep their run alive with a heartbeat.
  await db()
    .from('runs')
    .update({ status: 'failed', error: 'Stopped without finishing (time limit or crash)', finished_at: new Date().toISOString() })
    .eq('status', 'running')
    .lt('heartbeat_at', new Date(Date.now() - 30 * 60_000).toISOString());
  if (opts.exclusive) {
    let q = db().from('runs').select('id').eq('kind', kind).eq('status', 'running');
    if (opts.subjectId) q = q.eq('subject_id', opts.subjectId);
    const { data: busy } = await q.limit(1);
    if (busy?.length) throw new AlreadyRunning(`A ${kind.replace('_', ' ')} run is already in progress`);
  }
  const row = must(
    await db()
      .from('runs')
      .insert({
        kind,
        status: 'running',
        profile_id: opts.profileId ?? null,
        subject_id: opts.subjectId ?? null,
        token_budget: opts.tokenBudget,
        // The search budget travels with the run so a resumed session keeps it.
        input: { ...((opts.input as Record<string, unknown>) ?? {}), search_budget: opts.searchBudget ?? 50 },
      })
      .select('id')
      .single(),
    'start run',
  );
  return makeRun({ id: row.id, kind, tokenBudget: opts.tokenBudget, searchBudget: opts.searchBudget ?? 50, tokensUsed: 0, searchCalls: 0, assumptionIds: [] });
}

function makeRun(state: Pick<Run, 'id' | 'kind' | 'tokenBudget' | 'searchBudget' | 'tokensUsed' | 'searchCalls' | 'assumptionIds'>): Run {
  const run: Run = {
    ...state,
    async charge(tokens: number) {
      run.tokensUsed += tokens;
      if (run.tokensUsed > run.tokenBudget) throw new BudgetExceeded(`Token budget ${run.tokenBudget} exceeded`);
    },
    chargeSearch() {
      run.searchCalls += 1;
      if (run.searchCalls > run.searchBudget) throw new BudgetExceeded(`Search budget ${run.searchBudget} exceeded`);
    },
    remaining: () => run.tokenBudget - run.tokensUsed,
  };
  return run;
}

/** Re-open a run that an agent session continues in a later function call. */
export async function loadRun(id: string): Promise<Run> {
  const row = must(await db().from('runs').select('id,kind,token_budget,tokens_used,search_calls,assumption_ids,input').eq('id', id).single(), 'load run');
  return makeRun({
    id: row.id,
    kind: row.kind,
    tokenBudget: row.token_budget ?? 0,
    searchBudget: Number(row.input?.search_budget ?? 50),
    tokensUsed: row.tokens_used ?? 0,
    searchCalls: row.search_calls ?? 0,
    assumptionIds: row.assumption_ids ?? [],
  });
}

/** Save usage so far and show the run is alive (between slices of an agent session). */
export async function saveProgress(run: Run) {
  await db()
    .from('runs')
    .update({ tokens_used: run.tokensUsed, search_calls: run.searchCalls, assumption_ids: run.assumptionIds, heartbeat_at: new Date().toISOString() })
    .eq('id', run.id);
}

export async function finishRun(run: Run, status: 'succeeded' | 'failed' | 'budget_exceeded' | 'skipped', output: unknown, error?: string) {
  await db()
    .from('runs')
    .update({
      status,
      output,
      error: error ?? null,
      tokens_used: run.tokensUsed,
      search_calls: run.searchCalls,
      assumption_ids: run.assumptionIds,
      finished_at: new Date().toISOString(),
    })
    .eq('id', run.id);
}

/** Run a body inside a run record, mapping budget overruns and errors to statuses. */
export async function withRun<T>(
  kind: string,
  opts: Parameters<typeof startRun>[1],
  body: (run: Run) => Promise<T>,
): Promise<T & { runId: string; status: string }> {
  let run: Run;
  try {
    run = await startRun(kind, opts);
  } catch (e) {
    if (e instanceof AlreadyRunning) return { status: 'skipped', reason: e.message } as unknown as T & { runId: string; status: string };
    throw e;
  }
  try {
    const out = await body(run);
    await finishRun(run, 'succeeded', out);
    return { ...(out as T), runId: run.id, status: 'succeeded' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof BudgetExceeded) {
      await finishRun(run, 'budget_exceeded', {}, msg);
      return { runId: run.id, status: 'budget_exceeded', error: msg } as unknown as T & { runId: string; status: string };
    }
    await finishRun(run, 'failed', {}, msg);
    throw e;
  }
}
