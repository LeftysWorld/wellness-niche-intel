// Re-verify an analysis result on demand (analysis runs verify automatically).
import { getSetting, type Budgets } from '../_shared/db.ts';
import { HttpError } from '../_shared/http.ts';
import { withRun } from '../_shared/runs.ts';
import { verifyResult } from '../_shared/verify.ts';

export async function run(body: Record<string, unknown>) {
  const resultId = String(body.result_id ?? '');
  if (!resultId) throw new HttpError(400, 'result_id is required');
  const budgets = await getSetting<Budgets>('budgets');
  return withRun('verify', { tokenBudget: budgets.verify_tokens, searchBudget: 0, subjectId: resultId, input: body }, async (run) => ({
    report: await verifyResult(run, resultId),
  }));
}
