// Conversation history for agent sessions: cache breakpoints and compaction.
// Pure (no I/O), so it is tested.

export type ContentBlock =
  | { type: 'text'; text: string; cache_control?: unknown }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean; cache_control?: unknown };

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}


/** Mark the newest message as a cache breakpoint so the next turn reads the prefix from cache. */
export function withCacheBreakpoint(history: Message[]): Message[] {
  if (!history.length) return history;
  const out = history.map((m) => ({ ...m, content: typeof m.content === 'string' ? m.content : m.content.map((b) => stripCache(b)) }));
  const last = out[out.length - 1];
  if (typeof last.content === 'string') {
    last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }];
  } else if (last.content.length) {
    const i = last.content.length - 1;
    const b = last.content[i];
    if (b.type === 'text' || b.type === 'tool_result') last.content[i] = { ...b, cache_control: { type: 'ephemeral' } };
  }
  return out;
}

function stripCache(b: ContentBlock): ContentBlock {
  if ((b.type === 'text' || b.type === 'tool_result') && b.cache_control) {
    const { cache_control: _drop, ...rest } = b;
    return rest as ContentBlock;
  }
  return b;
}


export function appendUser(history: Message[], blocks: ContentBlock[]) {
  const last = history[history.length - 1];
  // Tool results must come in one user message right after the assistant turn.
  if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(...blocks);
  else history.push({ role: 'user', content: blocks });
}

/** Characters of history kept in full; older tool results are shortened past this. */
const HISTORY_BUDGET = 140_000;

/**
 * Keep long sessions affordable: older tool results are cut to a short
 * summary (everything seen is still in the evidence store), and thinking from
 * earlier turns is dropped (the API ignores it anyway). The newest turns stay whole.
 */
export function compact(history: Message[], keepRecent = 6): Message[] {
  const size = JSON.stringify(history).length;
  const lastAssistant = history.map((m) => m.role).lastIndexOf('assistant');
  return history.map((m, i) => {
    if (typeof m.content === 'string') return m;
    const old = i < history.length - keepRecent;
    return {
      ...m,
      // Dropped only once the history is large: changing earlier turns invalidates the prompt cache.
      content: m.content
        .filter((b) => !(size > HISTORY_BUDGET && i < lastAssistant && (b.type === 'thinking' || b.type === 'redacted_thinking')))
        .map((b) =>
          old && size > HISTORY_BUDGET && b.type === 'tool_result' && b.content.length > 400
            ? { ...b, content: `${b.content.slice(0, 300)}… [shortened; the full result was seen earlier]` }
            : b,
        ),
    };
  });
}

