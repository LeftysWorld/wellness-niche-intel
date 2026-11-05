// Judge how well each place matches the owner's description of what they want.
import { getSetting, type Budgets } from '../_shared/db.ts';
import { scorePlaces } from '../_shared/places.ts';
import { withRun } from '../_shared/runs.ts';

export async function run(body: Record<string, unknown>) {
  const budgets = await getSetting<Budgets>('budgets');
  return withRun('location_fit', { tokenBudget: budgets.fit_screen_tokens, searchBudget: 0, subjectId: body.location_id as string | undefined, input: body }, (r) =>
    scorePlaces(r, { locationId: body.location_id as string | undefined }),
  );
}
