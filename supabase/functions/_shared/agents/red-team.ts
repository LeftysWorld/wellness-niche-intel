// deno-lint-ignore-file no-explicit-any
// Red-team agent: an independent check of a finished analysis. It is told the
// inputs that move cash and profit most and the values the analysis used, but
// not where they came from, and re-researches them from scratch. Code compares
// what it finds with what was used; big gaps are flagged on the idea page,
// lower the analysis's confidence, and are handed to the next analysis to
// reconcile. It writes nothing to the ledger, so its check stays independent.
import { ToolError, type AgentContext, type AgentDef, type AgentTool } from '../agent.ts';
import { confirmQuote, fetchPage, webSearch } from '../agent-tools.ts';
import { termsProblem, type PriceTerms } from '../price-terms.ts';
import { db, must } from '../db.ts';
import { hostOf, quoteHasNumber } from '../evidence.ts';
import { PRICE_UNITS } from '../model-builder.ts';
import { jsonSafe } from '../json-safe.ts';
import { compareChecks, lowerConfidence, redTeamTargets, type RedTeamCheck, type RedTeamTarget } from '../red-team.ts';
import type { BusinessModel } from '../engine/types.ts';

export interface RedTeamParams extends Record<string, unknown> {
  result_id: string;
}
type Ctx = AgentContext<RedTeamParams>;

async function load(resultId: string) {
  const ar = must(await db().from('analysis_results').select('id,pairing_id,model,result,confidence').eq('id', resultId).single(), 'result');
  const p = must(await db().from('pairings').select('niche_id,location_id').eq('id', ar.pairing_id).single(), 'pairing');
  const niche = must(await db().from('niches').select('name,card').eq('id', p.niche_id).single(), 'niche');
  const location = must(await db().from('locations').select('name,country_code').eq('id', p.location_id).single(), 'location');
  return { ar, niche, location };
}

export const redTeam: AgentDef<RedTeamParams> = {
  name: 'red-team',
  runKind: 'verify',
  model: (m) => m.judgment,
  thinking: true,
  tools(ctx) {
    const targets = () => (ctx.scratch.targets ?? []) as RedTeamTarget[];
    const recordCheck: AgentTool<RedTeamParams> = {
      name: 'record_check',
      description: 'Record one figure you found for a target input, with the exact words from the page. Prices also need their terms (product, unit, party size, length, date).',
      input_schema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The target key' },
          value: { type: 'number', description: 'In the target\'s unit' },
          original: { type: 'string', description: 'The figure as printed' },
          url: { type: 'string' },
          quote: { type: 'string', description: 'Exact words from the page containing the figure' },
          terms: {
            type: 'object',
            properties: { product: { type: 'string' }, unit: { type: 'string' }, party_size: { type: 'number' }, duration_minutes: { type: 'number' }, seen: { type: 'string' } },
          },
          note: { type: 'string', description: 'Conversion, and how this differs from the target' },
        },
        required: ['key', 'value', 'original', 'url', 'quote'],
      },
      async run(input: RedTeamCheck & { original: string; terms?: Partial<PriceTerms> }, c) {
        const t = targets().find((x) => x.key === input.key);
        if (!t) throw new ToolError(`${input.key} is not one of your targets: ${targets().map((x) => x.key).join(', ')}.`);
        const value = Number(input.value);
        if (!Number.isFinite(value) || value < 0) throw new ToolError('value must be a number.');
        if (!quoteHasNumber(String(input.quote ?? ''), String(input.original ?? ''))) throw new ToolError('The quote must contain the original figure as printed.');
        if (!(await confirmQuote(c as unknown as AgentContext, input.url, input.quote))) throw new ToolError('That quote is not on the page. Copy it exactly.');
        if (t.key.startsWith('price.')) {
          const unit = t.unit.replace(/^USD /, '').replace(' ', '_');
          const problem = termsProblem(input.terms, { unit: unit === 'per_unit' ? undefined : unit, units: PRICE_UNITS });
          if (problem) throw new ToolError(problem);
          if (!(await confirmQuote(c as unknown as AgentContext, input.url, String(input.terms!.product)))) throw new ToolError(`"${input.terms!.product}" is not on that page.`);
        }
        const list = ((c.scratch.checks ??= []) as RedTeamCheck[]);
        if (list.some((x) => x.key === input.key && x.url === input.url && x.value === value)) return 'Already recorded.';
        list.push({ key: input.key, value, url: input.url, host: hostOf(input.url), quote: String(input.quote).slice(0, 300), note: input.note });
        return { recorded: list.filter((x) => x.key === input.key).length, for: input.key };
      },
    };
    const compare: AgentTool<RedTeamParams> = {
      name: 'compare',
      description: 'Compare what you found with what the analysis used (computed by code). Call when you have checked each target you can.',
      input_schema: { type: 'object', properties: {} },
      async run(_i, c) {
        return compareChecks(targets(), (c.scratch.checks ?? []) as RedTeamCheck[]);
      },
    };
    return [webSearch, fetchPage, recordCheck, compare];
  },
  async task(ctx) {
    const { ar, niche, location } = await load(ctx.params.result_id);
    const card = niche.card as Record<string, any>;
    const targets = redTeamTargets(ar.model as BusinessModel, ar.result, card.model);
    ctx.scratch.targets = targets;
    return [
      `Independently check an analysis of **${niche.name}** in **${location.name}** (${location.country_code}).`,
      card.concept?.pitch ? `What it is: ${card.concept.pitch}` : card.summary ? `What it is: ${String(card.summary).slice(0, 400)}` : '',
      'You are not told where the analysis got its numbers. Find each value yourself, from primary sources, as if no one had looked before.',
      'Targets (key · what · value the analysis used · unit · why it matters):',
      ...targets.map((t) => `- ${t.key} · ${t.label} · ${t.current} · ${t.unit} · ${t.why}`),
      'Start with the targets that move cash or profit most. Then call compare and finish.',
    ].filter(Boolean).join('\n');
  },
  finish: {
    description: 'Finish with what you checked and what you could not.',
    schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Two or three sentences: what matched, what did not, and the likely reason (different product, older price, wrong unit, smaller lot…)' },
        not_checked: { type: 'array', items: { type: 'string' }, description: 'Targets you could not find, with what you tried' },
      },
      required: ['summary', 'not_checked'],
    },
  },
  checkFinish(ctx) {
    return (ctx.scratch.checks as unknown[] | undefined)?.length ? null : 'Record at least one check with record_check, then call compare.';
  },
  async onFinish(ctx, out) {
    const findings = compareChecks((ctx.scratch.targets ?? []) as RedTeamTarget[], (ctx.scratch.checks ?? []) as RedTeamCheck[]);
    await save(ctx, findings, String(out.summary ?? ''), (out.not_checked as string[]) ?? []);
    return { flagged: findings.filter((f) => f.flagged).length, checked: findings.filter((f) => f.found !== null).length };
  },
  async onStop(ctx, reason) {
    const findings = compareChecks((ctx.scratch.targets ?? []) as RedTeamTarget[], (ctx.scratch.checks ?? []) as RedTeamCheck[]);
    if (findings.some((f) => f.found !== null)) await save(ctx, findings, `Stopped early: ${reason}`, []);
    return { stopped: reason };
  },
};

async function save(ctx: Ctx, findings: ReturnType<typeof compareChecks>, summary: string, notChecked: string[]) {
  const ar = must(await db().from('analysis_results').select('result,confidence').eq('id', ctx.params.result_id).single(), 'result');
  const red_team = { findings, summary, not_checked: notChecked, at: new Date().toISOString(), session_id: ctx.sessionId };
  await db()
    .from('analysis_results')
    .update({ result: jsonSafe({ ...(ar.result ?? {}), red_team }), confidence: lowerConfidence(ar.confidence, findings) })
    .eq('id', ctx.params.result_id);
}
