// Verification of one analysis result. Code checks run first (cheap, exact);
// then a separate, stronger model reviews the inputs and a sample of sources
// with no knowledge of how the analysis was produced.
import { db, getSetting, must, type Models, type Thresholds } from './db.ts';
import { ask, clip } from './llm.ts';
import { fetchText } from './search.ts';
import type { Run } from './runs.ts';
import type { AnalysisResult, BusinessModel } from './engine/types.ts';
import { normalizeTri } from './engine/random.ts';

export interface VerifyReport {
  status: 'pass' | 'flag' | 'fail';
  checks: { name: string; ok: boolean; detail: string }[];
  sourceChecks: { key: string; url: string; supported: 'yes' | 'partly' | 'no' | 'unreachable'; note: string }[];
  reviewer?: { verdict: string; concerns: string[] };
  confidence: 'high' | 'medium' | 'low';
}

export function codeChecks(model: BusinessModel, r: AnalysisResult, th: Thresholds): VerifyReport['checks'] {
  const checks: VerifyReport['checks'] = [];
  const rev = r.month36.revenue.p50;
  const margin = rev > 0 ? r.month36.profit.p50 / rev : 0;
  checks.push({ name: 'year-3 margin plausible', ok: margin <= th.verifier_max_margin, detail: `margin ${(margin * 100).toFixed(1)}% (limit ${th.verifier_max_margin * 100}%)` });
  const hot = model.streams.filter((s) => s.units * s.sellablePerUnitPerMonth > 1 && normalizeTri(s.startOccupancy).mode > th.verifier_max_year1_occupancy);
  checks.push({ name: 'opening occupancy realistic', ok: hot.length === 0, detail: hot.length ? `high start occupancy: ${hot.map((s) => s.key).join(', ')}` : 'ok' });
  checks.push({ name: 'fundable with owner cash', ok: r.startup.fundable, detail: r.startup.fundingNote });
  checks.push({ name: 'owner workload within limit', ok: !r.capacity.exceeded, detail: `peak ${Math.round(r.capacity.peakOwnerHoursP50)} h/month vs ${r.capacity.limit}` });
  checks.push({ name: 'percentiles ordered', ok: r.month36.profit.p10 <= r.month36.profit.p50 && r.month36.profit.p50 <= r.month36.profit.p90, detail: 'P10 ≤ P50 ≤ P90' });
  checks.push({ name: 'survives worst realistic cash dip', ok: r.cashLowPoint.p10 > -model.financing.ownerCash * 0.25, detail: `P10 cash low point ${Math.round(r.cashLowPoint.p10)}` });
  return checks;
}

export async function verifyResult(run: Run, resultId: string): Promise<VerifyReport> {
  const th = await getSetting<Thresholds>('thresholds');
  const models = await getSetting<Models>('models');
  const row = must(await db().from('analysis_results').select('*').eq('id', resultId).single(), 'analysis result');
  const model = row.model as BusinessModel;
  const result = row.result as AnalysisResult;
  const checks = codeChecks(model, result, th);

  // Sample sourced assumptions and check each source still supports the value.
  const ids: string[] = row.assumption_ids ?? [];
  const assumptions = ids.length
    ? must(await db().from('assumptions').select('id,key,value_num,value_text,unit,currency,source_url,confidence,written_by').in('id', ids), 'assumptions')
    : [];
  const withUrl = assumptions.filter((a) => a.source_url?.startsWith('http'));
  const sample = withUrl.sort(() => 0.5 - Math.random()).slice(0, th.verifier_source_sample);
  const pages = await Promise.all(sample.map(async (a) => ({ a, text: await fetchText(a.source_url!, 8000) })));

  type Review = {
    sources: { key: string; supported: 'yes' | 'partly' | 'no' | 'unreachable'; note: string }[];
    verdict: 'pass' | 'flag' | 'fail';
    concerns: string[];
  };
  const review = await ask<Review>({
    run,
    model: models.verification,
    system:
      'You are an independent reviewer checking a small-business feasibility analysis. You did not build it. Be specific and skeptical, but do not invent problems. Judge only from what is shown.',
    prompt: [
      `Business: ${model.label}`,
      `Inputs (three-point estimates, USD):\n${clip(JSON.stringify({ streams: model.streams, costs: model.costs, startup: model.startupCosts, financing: model.financing, exit: model.exit }), 9000)}`,
      `Key results (P10/P50/P90 monthly profit): month 12 ${fmt(result.month12.profit)}, month 36 ${fmt(result.month36.profit)}, month 60 ${fmt(result.month60.profit)}. Startup P50 $${Math.round(result.startup.total.p50)}. Break-even month ${result.breakEvenMonthP50 ?? 'never'}.`,
      `Automated checks: ${checks.map((c) => `${c.ok ? 'OK' : 'FAIL'} ${c.name} (${c.detail})`).join('; ')}`,
      `Sources to check (does the page support the value?):\n${pages
        .map(({ a, text }) => `- key ${a.key} = ${a.value_num ?? a.value_text} ${a.unit ?? ''} ${a.currency ?? ''} from ${a.source_url}\n  page text: ${text ? clip(text, 2500) : '(unreachable)'}`)
        .join('\n') || '(no sourced inputs)'}`,
      'Return a verdict: pass if inputs look sourced and plausible; flag if the owner should look at specific concerns; fail if the result is likely wrong.',
    ].join('\n\n'),
    tool: {
      name: 'report',
      description: 'Report the review',
      schema: {
        type: 'object',
        properties: {
          sources: {
            type: 'array',
            items: {
              type: 'object',
              properties: { key: { type: 'string' }, supported: { type: 'string', enum: ['yes', 'partly', 'no', 'unreachable'] }, note: { type: 'string' } },
              required: ['key', 'supported', 'note'],
            },
          },
          verdict: { type: 'string', enum: ['pass', 'flag', 'fail'] },
          concerns: { type: 'array', items: { type: 'string' } },
        },
        required: ['sources', 'verdict', 'concerns'],
      },
    },
    maxTokens: 3000,
  });

  const sourceChecks = review.sources.map((s) => ({ ...s, url: sample.find((a) => a.key === s.key)?.source_url ?? '' }));
  const failedChecks = checks.filter((c) => !c.ok).length;
  const badSources = sourceChecks.filter((s) => s.supported === 'no').length;
  const weak = assumptions.filter((a) => a.confidence === 'low' || String(a.written_by).includes('estimate')).length;
  const status: VerifyReport['status'] = review.verdict === 'fail' || badSources >= 2 ? 'fail' : review.verdict === 'flag' || failedChecks > 0 || badSources > 0 ? 'flag' : 'pass';
  const confidence: VerifyReport['confidence'] = status === 'pass' && weak <= 2 ? 'high' : status === 'fail' || weak > 6 ? 'low' : 'medium';
  const report: VerifyReport = { status, checks, sourceChecks, reviewer: { verdict: review.verdict, concerns: review.concerns }, confidence };

  await db().from('analysis_results').update({ verifier_status: status, verifier_report: report, confidence }).eq('id', resultId);
  if (status === 'pass') await db().from('pairings').update({ status: 'verified' }).eq('id', row.pairing_id);
  if (confidence === 'low' || status !== 'pass') {
    await db().from('review_queue').insert({
      item_type: 'low_confidence',
      item_id: resultId,
      summary: `${model.label}: verifier ${status}. ${review.concerns.slice(0, 2).join(' ')}`.slice(0, 500),
      payload: report,
    });
  }
  return report;
}

function fmt(p: { p10: number; p50: number; p90: number }) {
  return `${Math.round(p.p10)}/${Math.round(p.p50)}/${Math.round(p.p90)}`;
}
