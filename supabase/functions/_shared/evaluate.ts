// Build and analyse a niche in a place for every allowed tenure, best first.
// Pure (no I/O): the edge functions and the dashboard run the same code, so an
// idea's page shows exactly the numbers its screening produced.
import { buildModel, type BuildOutput, type CostTemplate, type Ledger, type NicheModelSpec, type ProfileParams, type Tenure } from './model-builder.ts';
import { moneyRank, targetFigure, type TargetBasis } from './scoring.ts';
import { analyze } from './engine/index.ts';
import type { AnalysisResult } from './engine/types.ts';

export interface Candidate {
  tenure: Tenure;
  build: BuildOutput;
  result: AnalysisResult;
}

export function evaluateBuilt(input: {
  niche: { slug: string; name: string; model: NicheModelSpec };
  template: CostTemplate;
  location: { slug: string; name: string; country_code: string };
  ledger: Ledger;
  profile: ProfileParams & { own_or_lease?: string; target_basis?: TargetBasis };
  simulations: number;
  pairingId?: string;
  sensitivity?: boolean;
}): Candidate[] {
  const { profile } = input;
  const pref = profile.own_or_lease ?? 'either';
  // "either" compares all three: lease a property, rent land and build, or buy land and build.
  const tenures: Tenure[] = pref === 'own' ? ['own'] : pref === 'lease' ? ['lease'] : pref === 'ground' ? ['ground'] : ['lease', 'ground', 'own'];
  const targetYear = Number(profile.target_year ?? 1);
  const basis: TargetBasis = profile.target_basis === 'pre_tax' || profile.target_basis === 'with_housing' ? profile.target_basis : 'after_tax';
  const build = (tenure: Tenure, financingOverride?: 'cash'): Candidate => {
    const b = buildModel({ niche: input.niche, template: input.template, location: input.location, ledger: input.ledger, profile, tenure, financingOverride });
    if (input.pairingId) b.model.pairingId = input.pairingId;
    return { tenure, build: b, result: analyze(b.model, { simulations: input.simulations, seed: 42, sensitivity: input.sensitivity }) };
  };
  const out = tenures.map((tenure) => {
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
