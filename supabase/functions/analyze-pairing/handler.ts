// HTTP entry point: analyse one approved pairing. Logic lives in _shared/analysis.ts.
import { analyzePairing } from '../_shared/analysis.ts';
import { getSetting, type Budgets } from '../_shared/db.ts';
import { HttpError } from '../_shared/http.ts';
import { withRun } from '../_shared/runs.ts';

export async function run(body: Record<string, unknown>) {
  const pairingId = String(body.pairing_id ?? '');
  if (!pairingId) throw new HttpError(400, 'pairing_id is required');
  const budgets = await getSetting<Budgets>('budgets');
  return withRun(
    'analysis',
    { tokenBudget: budgets.analysis_tokens + budgets.verify_tokens, searchBudget: 6, subjectId: pairingId, input: body },
    (run) => analyzePairing(run, pairingId, { research: body.research !== false, verify: body.verify !== false }),
  );
}
