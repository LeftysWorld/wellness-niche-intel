// Full analysis of one approved pairing (shared by analyze-pairing and the orchestrator):
//  1. Research local competitor prices (AI reads search results; values go to
//     the ledger with sources, scoped to this pairing).
//  2. Build the model from the ledger and run the full simulation (code).
//  3. Store the result and hand it to the verifier.
import { db, getSetting, must, type Models, type Thresholds } from './db.ts';
import { HttpError } from './http.ts';
import { writeAssumptions, type LocationRow, type NewAssumption } from './ledger.ts';
import { ask } from './llm.ts';
import { evaluate, type NicheRow } from './pairing.ts';
import type { Run } from './runs.ts';
import { search } from './search.ts';
import { verifyResult } from './verify.ts';

async function researchPrices(run: Run, pairingId: string, niche: NicheRow, location: LocationRow, models: Models) {
  // deno-lint-ignore no-explicit-any
  const streams = ((niche.card.model as any)?.streams ?? []).filter((s: any) => s.units * s.sellablePerUnitPerMonth > 1);
  if (!streams.length) return [];
  const terms: string[] = (niche.card.competitor_terms as string[]) ?? [niche.name];
  const where = location.name;
  const hits = (
    await Promise.all(terms.slice(0, 2).map((t) => search(run, `${t} ${where} price`, 6)))
  ).flat();
  if (!hits.length) return [];
  const fx = await getSetting<{ cop_per_usd?: number }>('currency');
  type Out = { prices: { stream: string; low: number; mode: number; high: number; source_index: number; note: string; confidence: 'high' | 'medium' | 'low' }[] };
  const out = await ask<Out>({
    run,
    model: models.extraction,
    system: 'You extract prices from search results. Only report prices actually stated in the results. Convert to USD. Never guess.',
    prompt: [
      `Business type: ${niche.name}. Location: ${where} (${location.country_code}).`,
      `Revenue streams to price (USD per unit sold): ${streams.map((s: { key: string; label: string }) => `${s.key} = ${s.label}`).join('; ')}`,
      `Exchange rate: ${fx.cop_per_usd ?? 'n/a'} COP per USD.`,
      `Results:\n${hits.map((h, i) => `[${i}] ${h.url}\n${h.title}\n${h.snippet}`).join('\n\n')}`,
      'For each stream with at least one comparable local price, give low/typical/high in USD and the [n] of the best source. Skip streams with no evidence.',
    ].join('\n\n'),
    tool: {
      name: 'prices',
      description: 'Report sourced prices',
      schema: {
        type: 'object',
        properties: {
          prices: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                stream: { type: 'string' },
                low: { type: 'number' },
                mode: { type: 'number' },
                high: { type: 'number' },
                source_index: { type: 'integer', description: 'The [n] of the result the price comes from' },
                note: { type: 'string' },
                confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
              },
              required: ['stream', 'low', 'mode', 'high', 'source_index', 'note', 'confidence'],
            },
          },
        },
        required: ['prices'],
      },
    },
    maxTokens: 2000,
  });
  const valid = new Set(streams.map((s: { key: string }) => s.key));
  const rows: NewAssumption[] = out.prices
    .filter((p) => valid.has(p.stream) && hits[p.source_index] && p.mode > 0 && p.low <= p.mode && p.mode <= p.high)
    .map((p) => ({
      subject_type: 'pairing',
      subject_id: pairingId,
      key: `price.${p.stream}_usd`,
      value_num: p.mode,
      low: p.low,
      high: p.high,
      unit: 'per_sale',
      currency: 'USD',
      source_url: hits[p.source_index].url,
      source_note: p.note,
      confidence: p.confidence,
      stale_after: '120 days',
    }));
  return writeAssumptions(run, 'analyze-pairing', rows);
}

export async function analyzePairing(run: Run, pairingId: string, opts: { research: boolean; verify: boolean }) {
  const th = await getSetting<Thresholds>('thresholds');
  const models = await getSetting<Models>('models');
  const p = must(await db().from('pairings').select('*').eq('id', pairingId).single(), 'pairing');
  if (!['approved', 'analyzed', 'verified'].includes(p.status)) throw new HttpError(409, `Pairing is ${p.status}; approve it first`);
  const niche = must(await db().from('niches').select('*').eq('id', p.niche_id).single(), 'niche') as NicheRow;
  const location = must(await db().from('locations').select('*').eq('id', p.location_id).single(), 'location') as LocationRow;
  const profile = must(await db().from('parameter_profiles').select('*').eq('id', p.profile_id).single(), 'profile');

  let researched: string[] = [];
  if (opts.research) {
    const fresh = must(
      await db().from('current_assumptions').select('id').eq('subject_type', 'pairing').eq('subject_id', pairingId).eq('is_stale', false).like('key', 'price.%').limit(1),
      'fresh prices',
    );
    if (!fresh.length) researched = await researchPrices(run, pairingId, niche, location, models);
  }

  const [best, alt] = await evaluate(niche, location, profile, { simulations: th.simulations, pairingId });
  const weak = best.build.weakInputs.length + best.build.missing.length;
  const saved = must(
    await db()
      .from('analysis_results')
      .insert({
        run_id: run.id,
        pairing_id: pairingId,
        model: best.build.model,
        result: { ...best.result, tenure: best.tenure, missing: best.build.missing, weakInputs: best.build.weakInputs, alternative: alt ? { tenure: alt.tenure, month12: alt.result.month12, month36: alt.result.month36, month60: alt.result.month60, startup: alt.result.startup.total } : null },
        assumption_ids: best.build.usedAssumptionIds,
        confidence: weak > 4 ? 'low' : weak > 1 ? 'medium' : 'high',
        verifier_status: 'pending',
      })
      .select('id')
      .single(),
    'save result',
  );
  run.assumptionIds.push(...best.build.usedAssumptionIds);
  await db().from('pairings').update({ status: 'analyzed', latest_result_id: saved.id, rough_profit_year3: best.result.month36.profit.p50 }).eq('id', pairingId);

  let verification: Awaited<ReturnType<typeof verifyResult>> | null = null;
  if (opts.verify) verification = await verifyResult(run, saved.id);
  return {
    resultId: saved.id,
    tenure: best.tenure,
    researchedValues: researched.length,
    profitP50: { m12: best.result.month12.profit.p50, m36: best.result.month36.profit.p50, m60: best.result.month60.profit.p50 },
    startupP50: best.result.startup.total.p50,
    verifier: verification?.status ?? 'skipped',
  };
}
