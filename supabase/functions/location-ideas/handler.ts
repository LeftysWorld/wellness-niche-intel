// Suggest new places that match the owner's description (or a sensible default).
// Suggestions are screened against every niche and shown as suggested places;
// the owner adds or dismisses them in the web app.
import { getSetting, type Budgets } from '../_shared/db.ts';
import { leastCoveredCountry, suggestPlaces } from '../_shared/places.ts';
import { withRun } from '../_shared/runs.ts';

export async function run(body: Record<string, unknown>) {
  const budgets = await getSetting<Budgets>('budgets');
  // country_code targets one country; balance=true picks the country with the fewest places.
  const country = body.country_code
    ? { code: String(body.country_code).toUpperCase(), name: String(body.country_name ?? body.country_code) }
    : body.balance
      ? await leastCoveredCountry()
      : null;
  return withRun('location_ideas', { tokenBudget: budgets.location_scout_tokens, searchBudget: 6, input: body }, (r) =>
    suggestPlaces(r, Number(body.count ?? 5), { country: country ?? undefined }),
  );
}
