// Fill missing or stale ledger values for one location (or all active ones).
import { db, getSetting, must, type Budgets } from '../_shared/db.ts';
import { withRun } from '../_shared/runs.ts';
import { scoutLocation } from '../_shared/scout.ts';

export async function run(body: Record<string, unknown>) {
  const budgets = await getSetting<Budgets>('budgets');
  const ids: string[] = body.location_id
    ? [String(body.location_id)]
    : must(await db().from('locations').select('id').eq('active', true), 'locations').map((l) => l.id);
  return withRun(
    'location_scout',
    { tokenBudget: budgets.location_scout_tokens, searchBudget: 12 * ids.length, subjectId: body.location_id as string | undefined, input: body },
    async (run) => {
      const out: unknown[] = [];
      for (const id of ids) out.push(await scoutLocation(run, id, { keys: body.keys as string[] | undefined, force: Boolean(body.force) }));
      return { locations: out };
    },
  );
}
