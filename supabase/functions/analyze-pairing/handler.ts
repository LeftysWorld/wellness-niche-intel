// HTTP entry point: analyse one idea. Asking for it approves it. By default the
// pairing analyst agent researches until confident (agents/pairing-analyst.md),
// then the full simulation and the verifier run. agent=false runs the earlier
// fixed pipeline (price lookup, simulation, verifier). Logic: _shared/analysis.ts.
import { agentSettings, startAgent } from '../_shared/agent.ts';
import { pairingAnalyst } from '../_shared/agents/index.ts';
import { analyzePairing, approveForAnalysis } from '../_shared/analysis.ts';
import { db, getSetting, must, type Budgets } from '../_shared/db.ts';
import { HttpError } from '../_shared/http.ts';
import { withRun } from '../_shared/runs.ts';

/** An analyst session already working on this idea, if any. */
export async function activeAnalysis(pairingId: string) {
  const rows = must(
    await db().from('agent_sessions').select('id,status,run_id').eq('agent', 'pairing-analyst').eq('subject_id', pairingId).in('status', ['running', 'paused']).limit(1),
    'active analysis',
  ) as { id: string; status: string; run_id: string }[];
  return rows[0] ?? null;
}

export async function run(body: Record<string, unknown>) {
  const pairingId = String(body.pairing_id ?? '');
  if (!pairingId) throw new HttpError(400, 'pairing_id is required');
  await approveForAnalysis(pairingId);

  const settings = await agentSettings();
  if (settings.enabled && body.agent !== false) {
    const busy = await activeAnalysis(pairingId);
    if (busy) return { session_id: busy.id, run_id: busy.run_id, status: 'already running' };
    // From the app: start in the background and return at once; the idea's page shows progress.
    return await startAgent(pairingAnalyst, { pairing_id: pairingId }, { subjectId: pairingId, input: body, background: String(body._caller ?? '').startsWith('user:') });
  }

  const budgets = await getSetting<Budgets>('budgets');
  return withRun(
    'analysis',
    { tokenBudget: budgets.analysis_tokens + budgets.verify_tokens, searchBudget: 6, subjectId: pairingId, input: body },
    (run) => analyzePairing(run, pairingId, { research: body.research !== false, verify: body.verify !== false }),
  );
}
