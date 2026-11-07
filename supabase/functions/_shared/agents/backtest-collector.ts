// Backtest collector agent: finds real businesses with stated financials
// (mostly businesses-for-sale listings) so predictions can be checked against
// reality. Every figure needs its exact quote on the listing page.
import { ToolError, type AgentContext, type AgentDef, type AgentTool } from '../agent.ts';
import { confirmQuote, fetchPage, webSearch } from '../agent-tools.ts';
import { quoteHasNumber } from '../evidence.ts';
import { db, must } from '../db.ts';

type Params = Record<string, unknown> & { target?: number };

async function modelled() {
  const rows = must(await db().from('niches').select('id,slug,name,card,status').neq('status', 'rejected'), 'niches') as {
    id: string; slug: string; name: string; status: string; card: Record<string, unknown>;
  }[];
  return rows.filter((n) => n.card?.model);
}

const listNiches: AgentTool<Params> = {
  name: 'list_niches',
  description: 'Kinds of business that have a full model and can be backtested (slug, name, what it sells).',
  input_schema: { type: 'object', properties: {} },
  async run() {
    const existing = must(await db().from('backtest_cases').select('niche_id'), 'cases') as { niche_id: string }[];
    return (await modelled()).map((n) => ({
      slug: n.slug,
      name: n.name,
      sells: String(n.card?.revenue_units ?? n.card?.summary ?? '').slice(0, 160),
      cases_so_far: existing.filter((c) => c.niche_id === n.id).length,
    }));
  },
};

async function checked(c: AgentContext<Params>, url: string, quote: string | undefined, original: string | undefined, what: string) {
  if (!quote) return;
  if (!(await confirmQuote(c as unknown as AgentContext, url, quote))) throw new ToolError(`The ${what} quote is not on the page. Copy it exactly.`);
  if (original && !quoteHasNumber(quote, original)) throw new ToolError(`The ${what} quote must contain the figure as printed (${original}).`);
}

const recordCase: AgentTool<Params> = {
  name: 'record_case',
  description: 'Record a real business with stated annual revenue (gross sales), and cash flow (SDE) and asking price if stated. Each figure needs the exact quote from the listing.',
  input_schema: {
    type: 'object',
    properties: {
      niche_slug: { type: 'string' },
      business_name: { type: 'string' },
      url: { type: 'string' },
      locality: { type: 'string' },
      country_code: { type: 'string', enum: ['US', 'CO', 'CR', 'SV'] },
      annual_revenue_usd: { type: 'number' },
      revenue_original: { type: 'string', description: 'As printed, e.g. "$412,000"' },
      revenue_quote: { type: 'string' },
      sde_usd: { type: 'number' },
      sde_original: { type: 'string' },
      sde_quote: { type: 'string' },
      asking_price_usd: { type: 'number' },
      price_original: { type: 'string' },
      price_quote: { type: 'string' },
      units: { type: 'number', description: 'Rentable units (sites, cabins, rooms) if stated' },
      unit_label: { type: 'string' },
    },
    required: ['niche_slug', 'business_name', 'url', 'locality', 'country_code', 'annual_revenue_usd', 'revenue_original', 'revenue_quote'],
  },
  // deno-lint-ignore no-explicit-any
  async run(input: any, c) {
    const niche = (await modelled()).find((n) => n.slug === input.niche_slug);
    if (!niche) throw new ToolError('Unknown niche slug, or that niche has no model yet. Use list_niches.');
    if (!(Number(input.annual_revenue_usd) > 1000)) throw new ToolError('annual_revenue_usd must be the annual figure in USD.');
    await checked(c, input.url, input.revenue_quote, input.revenue_original, 'revenue');
    await checked(c, input.url, input.sde_quote, input.sde_original, 'cash flow');
    await checked(c, input.url, input.price_quote, input.price_original, 'asking price');
    const { error } = await db().from('backtest_cases').insert({
      niche_id: niche.id,
      business_name: String(input.business_name).slice(0, 200),
      url: input.url,
      locality: input.locality,
      country_code: input.country_code,
      annual_revenue_usd: input.annual_revenue_usd,
      sde_usd: input.sde_quote ? input.sde_usd : null,
      asking_price_usd: input.price_quote ? input.asking_price_usd : null,
      units: input.units ?? null,
      unit_label: input.unit_label ?? null,
      quotes: { revenue: input.revenue_quote, sde: input.sde_quote ?? null, price: input.price_quote ?? null },
      run_id: c.run.id,
    });
    if (error) {
      if (/duplicate|unique/i.test(error.message)) return 'Already recorded.';
      throw new ToolError(error.message);
    }
    const n = (((c.scratch.cases ??= []) as string[]).push(input.business_name));
    return { recorded: n };
  },
};

export const backtestCollector: AgentDef<Params> = {
  name: 'backtest-collector',
  runKind: 'backtest_collect',
  model: (m) => m.numbers ?? m.judgment,
  tools: () => [listNiches, webSearch, fetchPage, recordCase],
  async task(ctx) {
    const target = Number(ctx.params.target ?? 6);
    return `Collect up to ${target} new backtest cases. Start with list_niches and favour niches with few cases so far.`;
  },
  finish: {
    description: 'Finish collecting.',
    schema: { type: 'object', properties: { summary: { type: 'string' }, skipped: { type: 'array', items: { type: 'string' } } }, required: ['summary', 'skipped'] },
  },
  async onFinish(ctx) {
    return { cases: ctx.scratch.cases ?? [] };
  },
};
