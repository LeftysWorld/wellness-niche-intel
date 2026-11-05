// Shared steps for screening and analysing a niche × location pairing.
import { db, must } from './db.ts';
import { loadLedger, type LocationRow } from './ledger.ts';
import { buildModel, type BuildOutput, type ProfileParams, type Tenure } from './model-builder.ts';
import { moneyRank, targetFigure, type TargetBasis } from './scoring.ts';
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
  profile: { id: string; params: ProfileParams & { own_or_lease?: string; target_basis?: TargetBasis } },
  opts: { simulations: number; pairingId?: string; sensitivity?: boolean },
): Promise<Candidate[]> {
  const template = await latestTemplate(niche.id);
  if (!niche.card?.model || !template) throw new Error(`Niche ${niche.slug} has no model card or cost template yet`);
  const ledger = await loadLedger(location, opts.pairingId);
  const pref = profile.params.own_or_lease ?? 'either';
  const tenures: Tenure[] = pref === 'own' ? ['own'] : pref === 'lease' ? ['lease'] : ['lease', 'own'];
  const targetYear = Number(profile.params.target_year ?? 1);
  const basis: TargetBasis = profile.params.target_basis === 'pre_tax' ? 'pre_tax' : 'after_tax';
  const build = (tenure: Tenure, financingOverride?: 'cash') => {
    const b = buildModel({
      // deno-lint-ignore no-explicit-any
      niche: { slug: niche.slug, name: niche.name, model: niche.card.model as any },
      template,
      location,
      ledger,
      profile: profile.params,
      tenure,
      financingOverride,
    });
    if (opts.pairingId) b.model.pairingId = opts.pairingId;
    return { tenure, build: b, result: analyze(b.model, { simulations: opts.simulations, seed: 42, sensitivity: opts.sensitivity }) };
  };
  const out: Candidate[] = tenures.map((tenure) => {
    const c = build(tenure);
    // A loan a lender would turn down: see whether paying cash works instead.
    if (c.result.lender.applies && !c.result.lender.bankable) {
      const cash = build(tenure, 'cash');
      if (cash.result.startup.fundable) return cash;
    }
    return c;
  });
  return out.sort((a, b) =>
    moneyRank(
      { fundable: a.result.startup.fundable, target: targetFigure(a.result, targetYear, basis), year3: targetFigure(a.result, 3, basis) },
      { fundable: b.result.startup.fundable, target: targetFigure(b.result, targetYear, basis), year3: targetFigure(b.result, 3, basis) },
    ),
  );
}
