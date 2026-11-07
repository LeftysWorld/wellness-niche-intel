// Continue an agent session in a fresh function call (queued by the session
// itself when its time slice ran out, or by the orchestrator for stalled ones).
import { claim, runSlice } from '../_shared/agent.ts';
import { AGENTS } from '../_shared/agents/index.ts';
import { db, must } from '../_shared/db.ts';
import { HttpError } from '../_shared/http.ts';

export async function run(body: Record<string, unknown>) {
  const id = String(body.session_id ?? '');
  if (!id) throw new HttpError(400, 'session_id is required');
  const s = must(await db().from('agent_sessions').select('id,agent,status').eq('id', id).maybeSingle(), 'session');
  if (!s) throw new HttpError(404, 'No such session');
  const def = AGENTS[s.agent];
  if (!def) throw new HttpError(400, `Unknown agent ${s.agent}`);
  // Only one call may run a session at a time.
  if (!(await claim(id))) return { session_id: id, status: s.status, note: 'Not paused; nothing to do.' };
  return await runSlice(def, id);
}
