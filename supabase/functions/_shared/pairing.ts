// Shared steps for screening and analysing a niche × location pairing.
import { db, must } from './db.ts';
import { loadLedger, type LocationRow } from './ledger.ts';
import { buildModel, type BuildOutput, type ProfileParams, type Tenure } from './model-builder.ts';
import { analyze } from './engine/index.ts';
import type { AnalysisResult } from './engine/types.ts';

export interface NicheRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  risk_tags: string[];
  signal_score: number | null;
  card: { model?: unknown; [k: string]: unknown };
}

export async function latestTemplate(nicheId: string) {
  const row = must(
    await db().from('cost_templates').select('template').eq('niche_id', nicheId).order('version', { ascending: false }).limit(1).maybeSingle(),
    'template',
  );
  return row?.template ?? null;
}

export interface Candidate {
  tenure: Tenure;
  build: BuildOutput;
  result: AnalysisResult;
}

/** Build and analyse every allowed tenure, best first. */
export async function evaluate(
  niche: NicheRow,
  location: LocationRow,
  profile: { id: string; params: ProfileParams & { own_or_lease?: string } },
  opts: { simulations: number; pairingId?: string },
): Promise<Candidate[]> {
  const template = await latestTemplate(niche.id);
  if (!niche.card?.model || !template) throw new Error(`Niche ${niche.slug} has no model card or cost template yet`);
  const ledger = await loadLedger(location, opts.pairingId);
  const pref = profile.params.own_or_lease ?? 'either';
  const tenures: Tenure[] = pref === 'own' ? ['own'] : pref === 'lease' ? ['lease'] : ['lease', 'own'];
  const targetYear = Number(profile.params.target_year ?? 1);
  const out: Candidate[] = tenures.map((tenure) => {
    const build = buildModel({
      // deno-lint-ignore no-explicit-any
      niche: { slug: niche.slug, name: niche.name, model: niche.card.model as any },
      template,
      location,
      ledger,
      profile: profile.params,
      tenure,
    });
    if (opts.pairingId) build.model.pairingId = opts.pairingId;
    return { tenure, build, result: analyze(build.model, { simulations: opts.simulations, seed: 42 }) };
  });
  const rank = (c: Candidate) => (c.result.startup.fundable ? 1e9 : 0) + snapshotFor(c.result, targetYear).profit.p50;
  return out.sort((a, b) => rank(b) - rank(a));
}

export function snapshotFor(r: AnalysisResult, year: number) {
  return year <= 1 ? r.month12 : year <= 3 ? r.month36 : r.month60;
}

export interface FitScores {
  target: number;
  capital: number;
  workload: number;
  demand: number;
  risk: number;
  visa: number;
  data: number;
}

const WEIGHTS: Record<keyof FitScores, number> = { target: 0.3, capital: 0.15, workload: 0.1, demand: 0.15, risk: 0.1, visa: 0.1, data: 0.1 };

export function score(
  c: Candidate,
  niche: NicheRow,
  location: LocationRow,
  params: ProfileParams & { visa?: Record<string, string> },
  ledgerRisk: { countryDiscount: number; advisory: number },
): { scores: FitScores; total: number } {
  const target = Number(params.target_monthly_profit_usd ?? 5000);
  const year = Number(params.target_year ?? 1);
  const p50 = snapshotFor(c.result, year).profit.p50;
  const clamp = (n: number) => Math.max(0, Math.min(10, n));
  const visaMap: Record<string, number> = { citizen: 10, spouse_visa_eligible: 9, digital_nomad: 6, needs_investor_residency: 5, unclear: 3, not_allowed: 0 };
  const scores: FitScores = {
    target: clamp((p50 / target) * 10),
    capital: c.result.startup.fundable ? clamp(10 - Math.max(0, c.result.startup.total.p50 - params.capital_usd.max) / 10000) : 0,
    workload: c.result.capacity.exceeded ? 2 : 10,
    demand: clamp(Number(niche.signal_score ?? 0)),
    risk: clamp(10 - ledgerRisk.countryDiscount * 10 - Math.max(0, ledgerRisk.advisory - 1) * 2),
    visa: visaMap[params.visa?.[location.country_code] ?? 'unclear'] ?? 3,
    data: clamp(10 - c.build.missing.length * 2 - c.build.weakInputs.length * 0.5),
  };
  const total = (Object.keys(WEIGHTS) as (keyof FitScores)[]).reduce((s, k) => s + scores[k] * WEIGHTS[k], 0);
  return { scores, total: Math.round(total * 100) / 100 };
}
