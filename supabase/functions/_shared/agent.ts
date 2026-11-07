// The agent loop. An agent is a model with tools and a playbook: it reads the
// task, calls tools (search, read a page, record a figure, run the model…),
// reads what comes back, decides what to do next, and calls `finish` when it
// has enough. Code still owns every number: tools check sources, enforce
// budgets and do the arithmetic; the model only chooses what to do.
//
// A session can outlive one function call. Each call runs a time slice; if the
// work is not done the session is saved and continues in a fresh call
// (queue_agent → api/agent-resume). Every model turn and tool call is written
// to agent_steps, so the Activity page can show exactly what an agent did.
import { db, getSetting, must, type Models } from './db.ts';
import { messages as turn, clip, type JsonSchema } from './llm.ts';
import { appendUser, compact, type ContentBlock, type Message } from './history.ts';
import { BudgetExceeded, finishRun, loadRun, saveProgress, startRun, type Run } from './runs.ts';
import type { EvidenceStore } from './evidence.ts';
import { PLAYBOOKS } from './playbooks.ts';

/** Thrown by a tool to tell the agent what was wrong with its call (it sees the message and can fix it). */
export class ToolError extends Error {}

export interface Scratch {
  evidence: EvidenceStore;
  [k: string]: unknown;
}

export interface AgentSettings {
  enabled: boolean;
  slice_seconds: number;
  max_slices: number;
  target_band: number;
  max_proposals: number;
  thinking_tokens: number;
  agents: Record<string, { max_turns: number; tokens: number; searches: number }>;
}

export interface AgentContext<P = Record<string, unknown>> {
  run: Run;
  sessionId: string;
  params: P;
  scratch: Scratch;
  models: Models & { numbers?: string };
  settings: AgentSettings;
  /** Set by the finish tool. */
  finished?: Record<string, unknown>;
}

export interface AgentTool<P = Record<string, unknown>> {
  name: string;
  description: string;
  input_schema: JsonSchema;
  // deno-lint-ignore no-explicit-any
  run(input: any, ctx: AgentContext<P>): Promise<unknown>;
}

export interface AgentDef<P = Record<string, unknown>> {
  /** Name used in sessions, settings and the playbook file (agents/<name>.md). */
  name: string;
  /** Kind of the run record that tracks cost. */
  runKind: string;
  model(models: AgentContext['models']): string;
  /** Use extended thinking for judgment-heavy agents. */
  thinking?: boolean;
  tools(ctx: AgentContext<P>): AgentTool<P>[];
  /** The opening message: what to do this time. */
  task(ctx: AgentContext<P>): Promise<string>;
  finish: { description: string; schema: JsonSchema };
  /** Runs once after a valid finish call: store results, start follow-up work. */
  onFinish(ctx: AgentContext<P>, result: Record<string, unknown>): Promise<unknown>;
  /** Runs when the session stops without finishing (budget, limits): salvage what can be saved. */
  onStop?(ctx: AgentContext<P>, reason: string): Promise<unknown>;
}

interface SessionRow {
  id: string;
  run_id: string;
  agent: string;
  params: Record<string, unknown>;
  messages: Message[];
  scratch: Scratch;
  status: string;
  turns: number;
  slices: number;
}

export async function agentSettings(): Promise<AgentSettings> {
  const s = await getSetting<Partial<AgentSettings>>('agents');
  return {
    enabled: s.enabled !== false,
    slice_seconds: s.slice_seconds ?? 75,
    max_slices: s.max_slices ?? 12,
    target_band: s.target_band ?? 0.8,
    max_proposals: s.max_proposals ?? 6,
    thinking_tokens: s.thinking_tokens ?? 3000,
    agents: s.agents ?? {},
  };
}

function limits(settings: AgentSettings, name: string) {
  const a = settings.agents[name] ?? { max_turns: 30, tokens: 300000, searches: 20 };
  return { maxTurns: a.max_turns, tokens: a.tokens, searches: a.searches };
}

/** The playbook, plus the shared rules every agent follows. */
function systemPrompt(name: string): string {
  const shared = PLAYBOOKS['_shared'] ?? '';
  const own = PLAYBOOKS[name];
  if (!own) throw new Error(`No playbook for agent ${name} (supabase/functions/agents/${name}.md)`);
  return `${own}\n\n${shared}`;
}

/**
 * Start an agent session and run its first slice in this call. Short tasks
 * finish here; longer ones continue in the background.
 */
export async function startAgent<P extends Record<string, unknown>>(
  def: AgentDef<P>,
  params: P,
  opts: { subjectId?: string; profileId?: string; input?: unknown; background?: boolean } = {},
) {
  const settings = await agentSettings();
  const lim = limits(settings, def.name);
  const run = await startRun(def.runKind, { tokenBudget: lim.tokens, searchBudget: lim.searches, subjectId: opts.subjectId, profileId: opts.profileId, input: opts.input ?? params });
  const row = must(
    await db()
      .from('agent_sessions')
      .insert({ run_id: run.id, agent: def.name, subject_id: opts.subjectId ?? null, params, messages: [], scratch: { evidence: {} }, status: 'running' })
      .select('id')
      .single(),
    'start session',
  );
  if (opts.background) {
    await db().from('agent_sessions').update({ status: 'paused' }).eq('id', row.id);
    await db().rpc('queue_agent', { p_name: 'agent-resume', p_body: { session_id: row.id } });
    return { session_id: row.id, run_id: run.id, status: 'queued' };
  }
  return await runSlice(def, row.id, run);
}

/** Claim a paused session so two calls never run it at once. */
export async function claim(sessionId: string): Promise<boolean> {
  const { data } = await db()
    .from('agent_sessions')
    .update({ status: 'running', updated_at: new Date().toISOString() })
    .eq('id', sessionId)
    .eq('status', 'paused')
    .select('id');
  return Boolean(data?.length);
}

/** Run one time slice of a session: turns until it finishes, stops, or the slice runs out. */
export async function runSlice<P extends Record<string, unknown>>(def: AgentDef<P>, sessionId: string, existingRun?: Run) {
  const settings = await agentSettings();
  const models = await getSetting<AgentContext['models']>('models');
  const lim = limits(settings, def.name);
  const s = must(await db().from('agent_sessions').select('*').eq('id', sessionId).single(), 'session') as SessionRow;
  const run = existingRun ?? (await loadRun(s.run_id));
  const ctx: AgentContext<P> = { run, sessionId, params: s.params as P, scratch: s.scratch ?? { evidence: {} }, models, settings };
  if (!ctx.scratch.evidence) ctx.scratch.evidence = {};
  const tools = def.tools(ctx);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const toolDefs = [
    ...tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
    { name: 'finish', description: def.finish.description, input_schema: def.finish.schema },
  ];
  const system = systemPrompt(def.name);
  const history: Message[] = s.messages?.length ? s.messages : [{ role: 'user', content: await def.task(ctx) }];
  let turns = s.turns ?? 0;
  let nudges = 0;
  const deadline = Date.now() + settings.slice_seconds * 1000;

  const save = async (status: string, extra: Record<string, unknown> = {}) => {
    await db()
      .from('agent_sessions')
      .update({ messages: compact(history), scratch: ctx.scratch, turns, status, updated_at: new Date().toISOString(), ...extra })
      .eq('id', sessionId);
    await saveProgress(run);
  };
  const step = (row: { tool?: string | null; input?: unknown; output?: string; ok?: boolean; tokens?: number }) =>
    db().from('agent_steps').insert({ session_id: sessionId, turn: turns, tool: row.tool ?? null, input: row.input ?? null, output: clip(row.output ?? '', 4000), ok: row.ok ?? true, tokens: row.tokens ?? 0 });

  const stop = async (status: 'failed' | 'budget_exceeded', reason: string) => {
    let salvage: unknown = null;
    if (def.onStop) {
      try {
        salvage = await def.onStop(ctx, reason);
      } catch (e) {
        salvage = { error: (e as Error).message };
      }
    }
    await save(status, { error: reason, result: salvage ? { salvage } : null });
    await finishRun(run, status, { session_id: sessionId, turns, salvage }, reason);
    return { session_id: sessionId, run_id: run.id, status, error: reason, salvage };
  };

  try {
    while (true) {
      if (Date.now() > deadline) {
        const slices = (s.slices ?? 0) + 1;
        if (slices >= settings.max_slices) return await stop('failed', `Stopped after ${slices} time slices without finishing`);
        await save('paused', { slices });
        await db().rpc('queue_agent', { p_name: 'agent-resume', p_body: { session_id: sessionId } });
        return { session_id: sessionId, run_id: run.id, status: 'continuing', turns };
      }
      if (turns >= lim.maxTurns + 2) return await stop('failed', `Reached the turn limit (${lim.maxTurns}) without finishing`);
      if (turns === lim.maxTurns) appendUser(history, [{ type: 'text', text: 'You have reached the turn limit. Call finish now with what you have, listing anything left undone.' }]);

      const reply = await turn({
        run,
        model: def.model(models),
        system,
        tools: toolDefs,
        history: compact(history),
        maxTokens: 6000,
        thinkingTokens: def.thinking ? settings.thinking_tokens : 0,
      });
      history.push({ role: 'assistant', content: reply.content });
      const said = reply.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n');
      await step({ tool: null, output: said || `(${reply.stop_reason})`, tokens: reply.usage.input_tokens + reply.usage.output_tokens + reply.usage.cache_creation_input_tokens });
      const uses = reply.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
      turns++;
      if (!uses.length) {
        nudges++;
        if (nudges > 2) return await stop('failed', 'The agent stopped calling tools without finishing');
        appendUser(history, [{ type: 'text', text: 'Keep going with your tools, or call finish if you are done.' }]);
        await save('running');
        continue;
      }
      nudges = 0;
      const results: ContentBlock[] = [];
      for (const u of uses) {
        let out: string;
        let ok = true;
        if (u.name === 'finish') {
          const missing = (def.finish.schema.required ?? []).filter((k) => u.input?.[k] === undefined);
          if (missing.length) {
            ok = false;
            out = `finish is missing: ${missing.join(', ')}. Call finish again with every field.`;
          } else {
            ctx.finished = u.input;
            out = 'Recorded.';
          }
        } else if (Date.now() > deadline + 30_000) {
          // Keep each function call inside its time limit; the agent re-issues the call next slice.
          ok = false;
          out = 'Skipped: this time slice ended before the tool ran. Call it again.';
        } else {
          const tool = byName.get(u.name);
          try {
            if (!tool) throw new ToolError(`No tool named ${u.name}`);
            const value = await tool.run(u.input ?? {}, ctx);
            out = typeof value === 'string' ? value : JSON.stringify(value);
          } catch (e) {
            if (e instanceof BudgetExceeded) throw e;
            ok = false;
            out = e instanceof ToolError ? `Error: ${e.message}` : `Error: ${(e as Error).message ?? e}`;
          }
        }
        await step({ tool: u.name, input: u.input, output: out, ok });
        results.push({ type: 'tool_result', tool_use_id: u.id, content: clip(out, 9000), ...(ok ? {} : { is_error: true }) });
      }
      appendUser(history, results);

      if (ctx.finished) {
        const result = ctx.finished;
        const outcome = await def.onFinish(ctx, result);
        await save('finished', { result: { ...result, outcome } });
        await finishRun(run, 'succeeded', { session_id: sessionId, turns, outcome });
        return { session_id: sessionId, run_id: run.id, status: 'finished', turns, result, outcome };
      }
      await save('running');
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return await stop(e instanceof BudgetExceeded ? 'budget_exceeded' : 'failed', msg);
  }
}

/** Sessions that stalled (a lost call or a crash mid-slice) are put back in the queue. */
export async function resumeStalled(limit = 5) {
  const cutoffRunning = new Date(Date.now() - 15 * 60_000).toISOString();
  const cutoffPaused = new Date(Date.now() - 10 * 60_000).toISOString();
  const stalled = must(
    await db()
      .from('agent_sessions')
      .select('id,status,updated_at')
      .or(`and(status.eq.running,updated_at.lt.${cutoffRunning}),and(status.eq.paused,updated_at.lt.${cutoffPaused})`)
      .limit(limit),
    'stalled sessions',
  ) as { id: string; status: string }[];
  for (const s of stalled) {
    await db().from('agent_sessions').update({ status: 'paused', updated_at: new Date().toISOString() }).eq('id', s.id);
    await db().rpc('queue_agent', { p_name: 'agent-resume', p_body: { session_id: s.id } });
  }
  return stalled.length;
}
