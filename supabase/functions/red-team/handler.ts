// Independent re-check of a finished analysis (see agents/red-team.md).
// Queued by the pairing analyst when it finishes; can also be run by hand with { result_id }.
import { startAgent } from '../_shared/agent.ts';
import { redTeam } from '../_shared/agents/index.ts';
import { db, must } from '../_shared/db.ts';
import { HttpError } from '../_shared/http.ts';

export async function run(body: Record<string, unknown>) {
  const resultId = String(body.result_id ?? '');
  if (!resultId) throw new HttpError(400, 'result_id is required');
  const ar = must(await db().from('analysis_results').select('id,pairing_id').eq('id', resultId).maybeSingle(), 'result');
  if (!ar) throw new HttpError(404, 'No such analysis');
  return await startAgent(redTeam, { result_id: resultId }, { subjectId: ar.pairing_id, input: body, background: String(body._caller ?? '').startsWith('user:') });
}
