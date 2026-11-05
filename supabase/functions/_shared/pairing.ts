// Shared steps for screening and analysing a niche × location pairing.
import { db, must } from './db.ts';
import { loadLedger, type LocationRow } from './ledger.ts';
import type { ProfileParams } from './model-builder.ts';
import type { TargetBasis } from './scoring.ts';
import { evaluateBuilt, type Candidate } from './evaluate.ts';

export type { Candidate };

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
  // deno-lint-ignore no-explicit-any
  return evaluateBuilt({ niche: { slug: niche.slug, name: niche.name, model: niche.card.model as any }, template, location, ledger, profile: profile.params, ...opts });
}
