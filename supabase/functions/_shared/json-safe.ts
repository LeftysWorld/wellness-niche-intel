// Postgres jsonb rejects the NUL character (\u0000) and lone UTF-16 surrogates,
// both of which turn up in scraped page text and in text clipped mid-character.
// One bad character fails the whole save, so clean everything before writing.
// Pure, so it is tested.

const BAD = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function cleanText(s: string): string {
  return s.replace(BAD, '');
}

/** A deep copy with every string cleaned (keys too). */
export function jsonSafe<T>(value: T): T {
  if (typeof value === 'string') return cleanText(value) as T;
  if (Array.isArray(value)) return value.map((v) => jsonSafe(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[cleanText(k)] = jsonSafe(v);
    return out as T;
  }
  return value;
}
