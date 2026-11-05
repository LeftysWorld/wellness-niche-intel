// Suggest new places that match the owner's description. Suggestions arrive
// switched off; the owner adds or dismisses them in the web app.
import { getSetting, type Budgets } from '../_shared/db.ts';
import { suggestPlaces } from '../_shared/places.ts';
import { withRun } from '../_shared/runs.ts';

export async function run(body: Record<string, unknown>) {
  const budgets = await getSetting<Budgets>('budgets');
  return withRun('location_ideas', { tokenBudget: budgets.location_scout_tokens, searchBudget: 6, input: body }, (r) => suggestPlaces(r, Number(body.count ?? 5)));
}
