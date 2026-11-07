// Fill missing or stale ledger values for one location (or all active ones).
// By default a tool-using agent does the research (agents/location-scout.md);
// mode=classic runs the earlier fixed search-and-extract pipeline.
import { agentSettings, startAgent } from '../_shared/agent.ts';
import { locationScout } from '../_shared/agents/index.ts';
import { db, getSetting, must, type Budgets } from '../_shared/db.ts';
import { withRun } from '../_shared/runs.ts';
import { scoutLocation } from '../_shared/scout.ts';

export async function run(body: Record<string, unknown>) {
  const ids: string[] = body.location_id
    ? [String(body.location_id)]
    : must(await db().from('locations').select('id').eq('active', true), 'locations').map((l: { id: string }) => l.id);

  const settings = await agentSettings();
  if (settings.enabled && body.mode !== 'classic') {
    const params = (id: string) => ({ location_id: id, keys: body.keys as string[] | undefined, force: Boolean(body.force) });
    // One place: run now (continues in the background if it needs longer). Several: one background session each.
    if (ids.length === 1) return await startAgent(locationScout, params(ids[0]), { subjectId: ids[0], input: body, background: String(body._caller ?? '').startsWith('user:') });
    const started: unknown[] = [];
    for (const id of ids) started.push(await startAgent(locationScout, params(id), { subjectId: id, input: body, background: true }));
    return { started };
  }

  const budgets = await getSetting<Budgets>('budgets');
  return withRun(
    'location_scout',
    { tokenBudget: budgets.location_scout_tokens, searchBudget: 20 * ids.length, subjectId: body.location_id as string | undefined, input: body },
    async (run) => {
      const out: unknown[] = [];
      for (const id of ids) out.push(await scoutLocation(run, id, { keys: body.keys as string[] | undefined, force: Boolean(body.force) }));
      return { locations: out };
    },
  );
}
