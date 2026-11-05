// Run records and token/search budgets. Every agent works inside a run; the run
// is the unit of cost tracking and the audit trail for what was written.
import { db, must } from './db.ts';

export class BudgetExceeded extends Error {}

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
  opts: { tokenBudget: number; searchBudget?: number; profileId?: string; subjectId?: string; input?: unknown },
): Promise<Run> {
  const row = must(
    await db()
      .from('runs')
      .insert({
        kind,
        status: 'running',
        profile_id: opts.profileId ?? null,
        subject_id: opts.subjectId ?? null,
        token_budget: opts.tokenBudget,
        input: opts.input ?? {},
      })
      .select('id')
      .single(),
    'start run',
  );
  const run: Run = {
    id: row.id,
    kind,
    tokenBudget: opts.tokenBudget,
    searchBudget: opts.searchBudget ?? 50,
    tokensUsed: 0,
    searchCalls: 0,
    assumptionIds: [],
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
  const run = await startRun(kind, opts);
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
