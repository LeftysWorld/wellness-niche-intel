// Check each niche's site prerequisites against each active place.
import { getSetting, type Budgets } from '../_shared/db.ts';
import { checkSites } from '../_shared/sitecheck.ts';
import { withRun } from '../_shared/runs.ts';

export async function run(body: Record<string, unknown>) {
  const budgets = await getSetting<Budgets>('budgets');
  return withRun('site_check', { tokenBudget: budgets.fit_screen_tokens, searchBudget: 0, input: body, exclusive: true }, (r) =>
    checkSites(r, { nicheId: body.niche_id as string | undefined, locationId: body.location_id as string | undefined, force: Boolean(body.force) }),
  );
}
