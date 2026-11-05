// JSON-schema helpers for structured outputs (no runtime dependencies, so tests can import it).

/** Structured outputs need every object closed; add that recursively. */
export function strictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictSchema);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    out[k] = k === 'properties' && v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, strictSchema(pv)]))
      : strictSchema(v);
  }
  if (out.type === 'object') {
    out.additionalProperties = false;
    if (!out.properties) out.properties = {};
    if (!out.required) out.required = [];
  }
  return out;
}
