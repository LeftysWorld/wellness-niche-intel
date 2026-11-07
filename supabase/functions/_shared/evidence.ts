// What an agent has seen: every search result and every page it read, kept in
// its session so any figure, quote or example it reports can be checked
// against the actual text. Pure helpers here; I/O is in agent-tools.ts.

export interface EvidenceItem {
  url: string;
  title: string;
  snippet: string;
  /** Page text, once the agent (or a quote check) has read the page. */
  text?: string;
  /** True once fetching was tried, so a dead page is not fetched twice. */
  fetched?: boolean;
}

export type EvidenceStore = Record<string, EvidenceItem>;

/** Lower-case, collapse whitespace and unify quotes and dashes so a copied quote matches its page. */
export function squash(t: string): string {
  return t
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Does this text contain the quote (after normalising)? Quotes must be at least 4 characters. */
export function containsQuote(text: string, quote: string): boolean {
  const q = squash(quote);
  return q.length >= 4 && squash(text).includes(q);
}

/** Does a quote contain the figure it is said to support (in any common number format)? */
export function quoteHasNumber(quote: string, original: string): boolean {
  const digits = (s: string) => s.replace(/[^\d]/g, '');
  const want = digits(original);
  if (!want) return true;
  const runs = (quote.match(/\d[\d.,\s]*\d|\d/g) ?? []).map(digits);
  return runs.some((r) => r === want || r.startsWith(want) || want.startsWith(r) && r.length >= Math.min(3, want.length));
}

export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** Keep a page's text bounded inside a session. */
export const PAGE_TEXT_LIMIT = 40000;

/** Passages around each search term, for a long page (a few hundred characters each side). */
export function windows(text: string, terms: string[], radius = 400, max = 8): string[] {
  const lower = text.toLowerCase();
  const found: [number, number][] = [];
  for (const term of terms.map((t) => t.toLowerCase()).filter((t) => t.length >= 2)) {
    let from = 0;
    while (found.length < max * 3) {
      const i = lower.indexOf(term, from);
      if (i === -1) break;
      found.push([Math.max(0, i - radius), Math.min(text.length, i + term.length + radius)]);
      from = i + term.length;
    }
  }
  found.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const w of found) {
    const last = merged[merged.length - 1];
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else merged.push([...w]);
  }
  return merged.slice(0, max).map(([a, b]) => `…${text.slice(a, b)}…`);
}
