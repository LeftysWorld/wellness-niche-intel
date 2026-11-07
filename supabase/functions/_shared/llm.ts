// Anthropic Messages API client.
//   ask()      one structured reply (output_config.format with a JSON schema),
//              used for single judgments such as a critic or a verifier.
//   messages() one raw turn with tools, used by the agent loop in agent.ts.
// Both cache the system prompt (and, for agents, the tool list and the
// conversation so far), log tokens to spend_log and enforce budgets.
// The API key is read from the ANTHROPIC_API_KEY function secret.
import { db } from './db.ts';
import { checkSpendCaps, noteSpend, type Run } from './runs.ts';
import { strictSchema } from './schema.ts';
import { withCacheBreakpoint, type ContentBlock, type Message } from './history.ts';

export type { ContentBlock, Message };

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface AskOptions {
  run: Run;
  model: string;
  system: string;
  prompt: string;
  tool: { name: string; description: string; schema: JsonSchema };
  maxTokens?: number;
}

/** Most tokens one reply may use when a cut-off reply is retried with more room. */
const MAX_REPLY_TOKENS = 16000;

/**
 * Tokens charged to a run's budget. Cache reads cost a tenth of normal input,
 * so they count at a tenth; cache writes cost a quarter more, so they count in full.
 */
export function chargedTokens(u: Usage): number {
  return u.input_tokens + u.output_tokens + u.cache_creation_input_tokens + Math.ceil(u.cache_read_input_tokens / 10);
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

function usageOf(body: { usage?: Partial<Usage> }): Usage {
  const u = body.usage ?? {};
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
  };
}

async function logUsage(run: Run, model: string, u: Usage) {
  await db().from('spend_log').insert({
    run_id: run.id,
    provider: 'anthropic',
    model,
    // Cache writes are billed as input, so they count towards the caps as input.
    input_tokens: u.input_tokens + u.cache_creation_input_tokens,
    output_tokens: u.output_tokens,
    cache_read_tokens: u.cache_read_input_tokens,
    cache_write_tokens: u.cache_creation_input_tokens,
    calls: 1,
  });
  const charged = chargedTokens(u);
  noteSpend(charged, 0);
  await run.charge(charged);
}

function apiKey(): string {
  const key = Deno.env.get('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set. Add it under Edge Functions → Secrets.');
  return key;
}

async function post(body: Record<string, unknown>): Promise<Response> {
  return await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function ask<T>(opts: AskOptions): Promise<T> {
  let maxTokens = Math.min(opts.maxTokens ?? 4096, Math.max(512, opts.run.remaining()));
  if (opts.run.remaining() <= 0) await opts.run.charge(1);
  await checkSpendCaps('tokens');

  let lastErr = '';
  // Structured outputs guarantee the reply matches the schema. Very large
  // schemas can be refused ("compiled grammar is too large"); then the schema
  // goes in the prompt instead and the reply is parsed and checked by the caller.
  let constrained = true;
  let widened = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const schema = strictSchema(opts.tool.schema);
    const systemText = constrained
      ? `${opts.system}\n\nReply with JSON only: ${opts.tool.description}.`
      : `${opts.system}\n\nReply with a single compact JSON object only (minified on one line: no prose, no code fences, no indentation): ${opts.tool.description}. It must match this JSON schema, with every listed field present:\n${JSON.stringify(schema)}`;
    const res = await post({
      model: opts.model,
      max_tokens: maxTokens,
      // Cached: repeated calls with the same instructions pay a tenth for them.
      system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: opts.prompt }],
      ...(constrained ? { output_config: { format: { type: 'json_schema', schema } } } : {}),
    });
    if (res.status === 400 && constrained) {
      const text = await res.text();
      if (/grammar is too large|too complex/i.test(text)) {
        constrained = false;
        continue;
      }
      throw new Error(`Anthropic 400: ${text}`);
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = `${res.status} ${await res.text()}`;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const body = await res.json();
    await logUsage(opts.run, opts.model, usageOf(body));
    if (body.stop_reason === 'max_tokens') {
      // A reply that ran out of room gets one retry with twice the room, if the run can afford it.
      const room = Math.min(MAX_REPLY_TOKENS, maxTokens * 2, Math.max(0, opts.run.remaining()));
      if (!widened && room > maxTokens) {
        widened = true;
        maxTokens = room;
        continue;
      }
      throw new Error(`Reply was cut off at ${maxTokens} tokens`);
    }
    const raw = (body.content ?? []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('');
    // Unconstrained replies occasionally wrap the JSON; take the outermost object.
    const text = constrained ? raw : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    try {
      return JSON.parse(text) as T;
    } catch {
      // Only possible without the schema guarantee; one more try usually fixes it.
      lastErr = `Model reply was not valid JSON: ${text.slice(0, 200)}`;
      if (!constrained && attempt < 4) continue;
      throw new Error(lastErr);
    }
  }
  throw new Error(`Anthropic unavailable after retries: ${lastErr}`);
}

// ---------------------------------------------------------------------------
// Raw turns for the agent loop.

export interface ToolDef {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

export interface TurnReply {
  content: ContentBlock[];
  stop_reason: string;
  usage: Usage;
}

/**
 * One agent turn. The system prompt, the tools and the conversation up to the
 * newest message are cached, so each turn pays full price only for what is new.
 * Extended thinking is used when asked for, and dropped if the model refuses it.
 */
export async function messages(opts: {
  run: Run;
  model: string;
  system: string;
  tools: ToolDef[];
  history: Message[];
  maxTokens: number;
  thinkingTokens?: number;
}): Promise<TurnReply & { thinkingUsed: boolean }> {
  if (opts.run.remaining() <= 0) await opts.run.charge(1);
  await checkSpendCaps('tokens');
  const tools = opts.tools.map((t, i) => (i === opts.tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t));
  const history = withCacheBreakpoint(opts.history);
  let thinking = opts.thinkingTokens && opts.thinkingTokens >= 1024 ? opts.thinkingTokens : 0;
  let maxTokens = Math.min(MAX_REPLY_TOKENS, Math.max(1024, opts.maxTokens) + thinking);
  let lastErr = '';
  let widened = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await post({
      model: opts.model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }],
      tools,
      messages: history,
      ...(thinking ? { thinking: { type: 'enabled', budget_tokens: thinking } } : {}),
    });
    if (res.status === 400) {
      const text = await res.text();
      if (thinking && /thinking/i.test(text)) {
        // This model or configuration does not take a thinking budget: carry on without it.
        thinking = 0;
        maxTokens = Math.min(MAX_REPLY_TOKENS, Math.max(1024, opts.maxTokens));
        continue;
      }
      throw new Error(`Anthropic 400: ${text}`);
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = `${res.status} ${await res.text()}`;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const body = await res.json();
    const usage = usageOf(body);
    await logUsage(opts.run, opts.model, usage);
    if (body.stop_reason === 'max_tokens' && !widened && maxTokens < MAX_REPLY_TOKENS) {
      // A turn cut off mid-way (usually inside a tool call) is retried once with more room.
      widened = true;
      maxTokens = Math.min(MAX_REPLY_TOKENS, maxTokens * 2);
      continue;
    }
    return { content: body.content ?? [], stop_reason: body.stop_reason, usage, thinkingUsed: thinking > 0 };
  }
  throw new Error(`Anthropic unavailable after retries: ${lastErr}`);
}

/** Trim long page text so prompts stay inside budget. */
export function clip(text: string, max = 6000): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}
