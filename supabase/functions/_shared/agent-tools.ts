// Tools shared by the agents. Each tool checks its input and enforces the
// rules in code (quotes must be on the page, figures must be plausible, totals
// and medians are computed here), so the model chooses what to do but never
// decides what counts as evidence.
import { ToolError, type AgentContext, type AgentTool } from './agent.ts';
import { db, must } from './db.ts';
import { containsQuote, hostOf, PAGE_TEXT_LIMIT, quoteHasNumber, windows, type EvidenceItem } from './evidence.ts';
import { consensus, type Observation } from './consensus.ts';
import { inRange, sumParts, SUMMED_KEYS } from './guards.ts';
import { writeAssumptions, type NewAssumption } from './ledger.ts';
import { fetchText, search } from './search.ts';

type Ctx = AgentContext<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Search and reading

export const webSearch: AgentTool = {
  name: 'web_search',
  description: 'Search the web. Returns up to 8 results (url, title, snippet). Snippets are leads: read the page with fetch_page before relying on it.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'A short, specific query (local language where it helps)' },
      max_results: { type: 'integer', description: '1-10, default 8' },
    },
    required: ['query'],
  },
  async run(input: { query: string; max_results?: number }, ctx: Ctx) {
    const q = String(input.query ?? '').trim();
    if (q.length < 3) throw new ToolError('Give a real query.');
    const hits = await search(ctx.run, q.slice(0, 300), Math.max(1, Math.min(10, Number(input.max_results ?? 8))));
    for (const h of hits) {
      const prev = ctx.scratch.evidence[h.url];
      ctx.scratch.evidence[h.url] = { ...(prev ?? {}), url: h.url, title: h.title, snippet: prev?.snippet ? `${prev.snippet}\n${h.snippet}` : h.snippet };
    }
    if (!hits.length) return 'No results. Try different words, a portal name, or the wider region.';
    return hits.map((h) => ({ url: h.url, title: h.title, snippet: h.snippet.slice(0, 600) }));
  },
};

async function readPage(ctx: Ctx, url: string): Promise<EvidenceItem> {
  const prev = ctx.scratch.evidence[url];
  if (prev?.text || prev?.fetched) return prev;
  const text = await fetchText(url, PAGE_TEXT_LIMIT * 2);
  const item: EvidenceItem = { url, title: prev?.title ?? '', snippet: prev?.snippet ?? '', text: text.slice(0, PAGE_TEXT_LIMIT), fetched: true };
  ctx.scratch.evidence[url] = item;
  return item;
}

export const fetchPage: AgentTool = {
  name: 'fetch_page',
  description:
    'Read a web page as text. With `find`, returns only the passages around those words (best for long pages: prices, tables, rates). Without it, returns the start of the page.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      find: { type: 'array', items: { type: 'string' }, description: 'Words to look for, e.g. ["per night", "acre", "$"]' },
    },
    required: ['url'],
  },
  async run(input: { url: string; find?: string[] }, ctx: Ctx) {
    const url = String(input.url ?? '');
    if (!/^https?:\/\//i.test(url)) throw new ToolError('Give a full http(s) URL.');
    const item = await readPage(ctx, url);
    if (!item.text) return 'Could not read this page (blocked, not text, or empty). Use the search snippet, or try another source.';
    const terms = (input.find ?? []).filter(Boolean);
    if (terms.length) {
      const w = windows(item.text, terms);
      return w.length ? { url, passages: w } : { url, passages: [], note: `None of ${terms.join(', ')} found. Page starts: ${item.text.slice(0, 1200)}` };
    }
    return { url, length: item.text.length, text: item.text.slice(0, 7000) };
  },
};

/**
 * A quote counts only if it is on a page the agent actually saw: in the search
 * result text, or on the page itself (fetched now if it was not read yet).
 */
export async function confirmQuote(ctx: Ctx, url: string, quote: string): Promise<boolean> {
  const item = ctx.scratch.evidence[url];
  if (!item) throw new ToolError(`You have not seen ${url} in this session. Search for it or fetch it first.`);
  if (containsQuote(`${item.title} ${item.snippet}`, quote)) return true;
  const page = await readPage(ctx, url);
  return Boolean(page.text && containsQuote(page.text, quote));
}

// ---------------------------------------------------------------------------
// Figures → ledger values

export interface Figure {
  value: number;
  url: string;
  quote: string;
  original: string;
  fit: 'exact' | 'close';
  part?: string;
  note?: string;
  /** For prices: what exactly the price buys. */
  terms?: PriceTerms;
}

export { termsProblem, type PriceTerms } from './price-terms.ts';
import { termsProblem, type PriceTerms } from './price-terms.ts';

export interface FigureRules {
  /** Allowed keys, with a plausible range when known. */
  allowed(key: string): boolean;
  range(key: string): [number, number] | null;
  /** Where a key is written: the place, its country, or the pairing. */
  subject(key: string): { subject_type: NewAssumption['subject_type']; subject_id: string | null };
  agent: string;
  /** Evaluation runs record what would be written without writing it. */
  dryRun?: boolean;
  /** For price keys: the unit the model prices the offer in. Return null for keys that are not prices. */
  terms?(key: string): { unit?: string; units: readonly string[] } | null;
}

function figures(ctx: Ctx): Record<string, Figure[]> {
  return ((ctx.scratch.figures ??= {}) as Record<string, Figure[]>);
}

export function figureTools(rules: FigureRules): AgentTool[] {
  const record: AgentTool = {
    name: 'record_figure',
    description:
      'Record one figure for a value (one listing, price or statistic per call), with the exact words from the page that contain it. Convert to the unit the value is defined in (USD, per month, per acre…) and say how in `note`. The quote is checked against the page.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The value this figure is for' },
        value: { type: 'number', description: 'The figure, converted to the unit of the value' },
        original: { type: 'string', description: 'The figure as printed on the page, e.g. "$1,950/month" or "COP 1.750.905"' },
        url: { type: 'string' },
        quote: { type: 'string', description: 'Exact words from the page containing the original figure (under 30 words)' },
        fit: { type: 'string', enum: ['exact', 'close', 'proxy'], description: 'exact: this value for this place; close: same measure, nearby place or slightly different type; proxy: a different measure' },
        part: { type: 'string', description: 'Only for totals made of parts (population by town): the town' },
        note: { type: 'string', description: 'Conversion and any difference from what was asked' },
        terms: {
          type: 'object',
          description: 'Required for prices: what the price buys, as the page states it',
          properties: {
            product: { type: 'string', description: 'The product or room name exactly as the page shows it, e.g. "Sauna Cabana"' },
            unit: { type: 'string', description: 'per_person, per_booking, per_night, per_month or per_unit' },
            party_size: { type: 'number', description: 'Most people one booking covers, when the page says' },
            duration_minutes: { type: 'number', description: 'Length of the session, when the page says' },
            seen: { type: 'string', description: 'Date the page shows for the price (YYYY-MM-DD) or "undated"' },
          },
        },
      },
      required: ['key', 'value', 'original', 'url', 'quote', 'fit'],
    },
    async run(input: Omit<Figure, 'fit'> & { key: string; fit: string }, ctx: Ctx) {
      const key = String(input.key);
      if (!rules.allowed(key)) throw new ToolError(`${key} is not one of the values you can record here.`);
      if (input.fit === 'proxy') throw new ToolError('Proxies are never written. Find a figure for the value itself, or a close stand-in.');
      const value = Number(input.value);
      if (!Number.isFinite(value) || value < 0) throw new ToolError('value must be a number.');
      const range = rules.range(key);
      if (range && (value < range[0] || value > range[1])) {
        throw new ToolError(`${value} is outside the plausible range for ${key} (${range[0]}–${range[1]}): probably a different quantity (annual vs monthly, sale vs rent, another currency). Check the conversion.`);
      }
      if (!quoteHasNumber(String(input.quote ?? ''), String(input.original ?? ''))) {
        throw new ToolError('The quote must contain the original figure as printed.');
      }
      const ok = await confirmQuote(ctx, String(input.url), String(input.quote ?? ''));
      if (!ok) throw new ToolError('That quote is not on the page. Copy the words exactly as they appear (fetch_page with find shows the passage).');
      const want = rules.terms?.(key) ?? null;
      let terms: PriceTerms | undefined;
      if (want) {
        const t = (input as { terms?: Partial<PriceTerms> }).terms;
        const problem = termsProblem(t, want);
        if (problem) throw new ToolError(problem);
        // The product must be named on the same page, so a price cannot be lifted from a different offer.
        if (!(await confirmQuote(ctx, String(input.url), String(t!.product)))) throw new ToolError(`"${t!.product}" is not on that page. Use the product name exactly as the page shows it.`);
        terms = { product: String(t!.product), unit: String(t!.unit), party_size: t!.party_size, duration_minutes: t!.duration_minutes, seen: String(t!.seen) };
      }
      const list = (figures(ctx)[key] ??= []);
      if (list.some((f) => f.url === input.url && f.value === value && (f.part ?? '') === (input.part ?? ''))) return 'Already recorded.';
      list.push({ value, url: String(input.url), quote: String(input.quote), original: String(input.original), fit: input.fit === 'exact' ? 'exact' : 'close', part: input.part?.trim().toLowerCase() || undefined, note: input.note, terms });
      const sites = new Set(list.map((f) => hostOf(f.url))).size;
      return { recorded: true, key, figures: list.length, sites, values: list.map((f) => f.value) };
    },
  };

  const commit: AgentTool = {
    name: 'commit_value',
    description:
      'Write a value from the figures recorded for it. Code takes the median of the figures (or the sum of parts for population), drops outliers, and sets confidence by how many separate sites agree. Call when you have figures from several sites.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        unit: { type: 'string', description: 'e.g. usd_per_acre, usd_per_month, fraction, people' },
        note: { type: 'string', description: 'How the figures were found and converted, and how they differ from what was asked' },
      },
      required: ['key', 'unit', 'note'],
    },
    async run(input: { key: string; unit: string; note: string }, ctx: Ctx) {
      const key = String(input.key);
      const list = figures(ctx)[key] ?? [];
      if (!list.length) throw new ToolError(`No figures recorded for ${key} yet.`);
      const obs: Observation[] = list.map((f) => ({ value: f.value, url: f.url, confirmed: true, part: f.part }));
      const c = SUMMED_KEYS.has(key) ? sumParts(obs) : consensus(obs.filter((o) => inRange(key, o.value)));
      if (!c) {
        throw new ToolError(SUMMED_KEYS.has(key) ? 'A total needs confirmed figures for at least two parts (towns).' : 'No usable figures.');
      }
      const where = rules.subject(key);
      const prev = await currentValue(where.subject_type, where.subject_id, key);
      if (prev && prev > 0 && (c.value / prev > 2 || prev / c.value > 2) && c.sources < 2) {
        throw new ToolError(`That would change ${key} from ${prev} to ${Math.round(c.value)} on one site's word. Find a second site that agrees.`);
      }
      // Stand-ins lower confidence one step.
      const allClose = list.every((f) => f.fit === 'close');
      const confidence = allClose ? (c.confidence === 'high' ? 'medium' : 'low') : c.confidence;
      const best = [...c.kept].sort((a, b) => Math.abs(a.value - c.value) - Math.abs(b.value - c.value))[0];
      const r3 = (n: number) => Math.round(n * 1000) / 1000;
      const row: NewAssumption = {
        ...where,
        key,
        value_num: r3(c.value),
        low: r3(c.low),
        high: r3(c.high),
        unit: input.unit,
        currency: key.endsWith('_usd') || key.includes('_usd_') ? 'USD' : null,
        source_url: best.url,
        source_note: `Median of ${c.kept.length} figure(s) from ${c.sources} site(s)${c.dropped.length ? `, ${c.dropped.length} outlier(s) dropped` : ''}${allClose ? ', all close stand-ins' : ''}. ${input.note}${termsNote(list)} Sources: ${[...new Set(c.kept.map((o) => o.url))].slice(0, 6).join(' ')}`.slice(0, 2000),
        confidence,
        stale_after: key.startsWith('lease') || key.startsWith('land') || key.startsWith('price.') ? '120 days' : key.startsWith('demand.population') ? '1095 days' : '365 days',
      };
      const committed = ((ctx.scratch.committed ??= {}) as Record<string, unknown>);
      committed[key] = { value: row.value_num, low: row.low, high: row.high, confidence, sources: c.sources, previous: prev };
      if (rules.dryRun) return { committed: key, value: row.value_num, confidence, sources: c.sources, dry_run: true };
      const ids = await writeAssumptions(ctx.run, rules.agent, [row]);
      return { committed: key, value: row.value_num, low: row.low, high: row.high, confidence, sources: c.sources, previous: prev, assumption_id: ids[0] };
    },
  };

  const giveUp: AgentTool = {
    name: 'give_up',
    description: 'Mark a value as not findable this time, with what you tried. It will be retried later with a different strategy.',
    input_schema: { type: 'object', properties: { key: { type: 'string' }, tried: { type: 'string' } }, required: ['key', 'tried'] },
    async run(input: { key: string; tried: string }, ctx: Ctx) {
      const gave = ((ctx.scratch.gave_up ??= {}) as Record<string, string>);
      gave[String(input.key)] = String(input.tried).slice(0, 500);
      return 'Noted.';
    },
  };
  return [record, commit, giveUp];
}

function termsNote(list: Figure[]): string {
  const t = list.filter((f) => f.terms).map((f) => `${f.terms!.product} ${f.terms!.unit.replace('_', ' ')}${f.terms!.party_size ? `, up to ${f.terms!.party_size}` : ''}${f.terms!.duration_minutes ? `, ${f.terms!.duration_minutes} min` : ''} (${f.terms!.seen}): $${f.value}`);
  return t.length ? ` Terms: ${t.join('; ')}.` : '';
}

async function currentValue(subjectType: string, subjectId: string | null, key: string): Promise<number | null> {
  let q = db().from('current_assumptions').select('value_num').eq('subject_type', subjectType).eq('key', key);
  q = subjectId ? q.eq('subject_id', subjectId) : q.is('subject_id', null);
  const row = must(await q.maybeSingle(), `current ${key}`);
  return row?.value_num ?? null;
}
