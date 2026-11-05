// Anthropic Messages API client. Every call uses structured outputs
// (output_config.format with a JSON schema), so the reply is guaranteed to be
// JSON matching the schema; nothing is parsed from free-form prose.
// The API key is read from the ANTHROPIC_API_KEY function secret.
import { db } from './db.ts';
import type { Run } from './runs.ts';
import { strictSchema } from './schema.ts';

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

export async function ask<T>(opts: AskOptions): Promise<T> {
  const key = Deno.env.get('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set. Add it under Edge Functions → Secrets.');
  const maxTokens = Math.min(opts.maxTokens ?? 4096, Math.max(512, opts.run.remaining()));
  if (opts.run.remaining() <= 0) await opts.run.charge(1);

  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: maxTokens,
        system: `${opts.system}\n\nReply with JSON only: ${opts.tool.description}.`,
        messages: [{ role: 'user', content: opts.prompt }],
        output_config: { format: { type: 'json_schema', schema: strictSchema(opts.tool.schema) } },
      }),
    });
    if (res.status === 429 || res.status >= 500) {
      lastErr = `${res.status} ${await res.text()}`;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const body = await res.json();
    const input = body.usage?.input_tokens ?? 0;
    const output = body.usage?.output_tokens ?? 0;
    await db().from('spend_log').insert({
      run_id: opts.run.id,
      provider: 'anthropic',
      model: opts.model,
      input_tokens: input,
      output_tokens: output,
      calls: 1,
    });
    await opts.run.charge(input + output);
    if (body.stop_reason === 'max_tokens') throw new Error(`Reply was cut off at ${maxTokens} tokens`);
    const text = (body.content ?? []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('');
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Model reply was not valid JSON: ${text.slice(0, 200)}`);
    }
  }
  throw new Error(`Anthropic unavailable after retries: ${lastErr}`);
}

/** Trim long page text so prompts stay inside budget. */
export function clip(text: string, max = 6000): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}
