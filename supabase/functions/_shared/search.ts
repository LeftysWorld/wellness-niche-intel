// Web search behind one interface. SEARCH_PROVIDER picks Tavily (default) or
// Brave; the key comes from TAVILY_API_KEY or BRAVE_API_KEY.
import { db } from './db.ts';
import { checkSpendCaps, noteSpend, type Run } from './runs.ts';

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  content?: string;
  published?: string;
}

export async function search(run: Run, query: string, maxResults = 8): Promise<SearchHit[]> {
  run.chargeSearch();
  await checkSpendCaps('searches');
  noteSpend(0, 1);
  const provider = (Deno.env.get('SEARCH_PROVIDER') ?? 'tavily').toLowerCase();
  const hits = provider === 'brave' ? await brave(query, maxResults) : await tavily(query, maxResults);
  await db().from('spend_log').insert({ run_id: run.id, provider, model: 'search', input_tokens: 0, output_tokens: 0, calls: 1 });
  return hits;
}

async function tavily(query: string, max: number): Promise<SearchHit[]> {
  const key = Deno.env.get('TAVILY_API_KEY');
  if (!key) throw new Error('TAVILY_API_KEY is not set (or set SEARCH_PROVIDER=brave and BRAVE_API_KEY).');
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: max, search_depth: 'basic', include_raw_content: false }),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return (body.results ?? []).map((r: Record<string, string>) => ({
    url: r.url,
    title: r.title ?? '',
    snippet: r.content ?? '',
    published: r.published_date,
  }));
}

async function brave(query: string, max: number): Promise<SearchHit[]> {
  const key = Deno.env.get('BRAVE_API_KEY');
  if (!key) throw new Error('BRAVE_API_KEY is not set.');
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max}`;
  const res = await fetch(url, { headers: { 'X-Subscription-Token': key, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Brave ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return (body.web?.results ?? []).map((r: Record<string, string>) => ({
    url: r.url,
    title: r.title ?? '',
    snippet: (r.description ?? '').replace(/<[^>]+>/g, ''),
    published: r.age,
  }));
}

/** Fetch a page as plain text, for verification and deeper extraction. */
export async function fetchText(url: string, max = 12000): Promise<string> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'wellness-niche-intel/1.0' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return '';
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, max);
  } catch {
    return '';
  }
}
