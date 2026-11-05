// Recompute an idea in the browser with the same pure code the screening uses
// (model builder + engine), from the same ledger rows. Nothing is saved.
import { mergeLedger, type CostTemplate, type LedgerValue, type NicheModelSpec, type ProfileParams } from '../../supabase/functions/_shared/model-builder.ts';
import { evaluateBuilt, type Candidate } from '../../supabase/functions/_shared/evaluate.ts';
import { supabase } from './supabase.ts';

const COLS = 'id,key,value_num,value_text,low,high,confidence,source_url,written_by,is_stale,subject_type,subject_id';

export interface LiveInputs {
  niche: { slug: string; name: string; model: NicheModelSpec };
  template: CostTemplate;
  location: { slug: string; name: string; country_code: string };
  rows: LedgerValue[];
  ledger: ReturnType<typeof mergeLedger>;
  profile: ProfileParams;
}

/** Everything the calculator needs for one niche in one place, or a reason it can't run. */
export async function loadLive(
  niche: { id: string; slug: string; name: string; card?: { model?: NicheModelSpec } },
  location: { id: string; slug: string; name: string; country_code: string; level: string; parent_id: string | null },
  profile: ProfileParams,
  pairingId?: string,
): Promise<LiveInputs | { missing: string }> {
  if (!niche.card?.model) return { missing: 'This niche has not been written up yet, so it has no economics to calculate with.' };
  const { data: t } = await supabase.from('cost_templates').select('template').eq('niche_id', niche.id).order('version', { ascending: false }).limit(1).maybeSingle();
  if (!t?.template) return { missing: 'This niche has no cost template yet.' };
  const read = async (subjectType: string, subjectId: string | null) => {
    let q = supabase.from('current_assumptions').select(COLS).eq('subject_type', subjectType);
    q = subjectId ? q.eq('subject_id', subjectId) : q.is('subject_id', null);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as unknown as LedgerValue[];
  };
  const layers: Parameters<typeof mergeLedger>[0] = [{ scope: 'global', rows: await read('global', null) }];
  if (location.parent_id) layers.push({ scope: 'country', rows: await read('location', location.parent_id) });
  layers.push({ scope: location.level === 'country' ? 'country' : 'micro_area', rows: await read('location', location.id) });
  if (pairingId) layers.push({ scope: 'pairing', rows: await read('pairing', pairingId) });
  return {
    niche: { slug: niche.slug, name: niche.name, model: niche.card.model },
    template: t.template as CostTemplate,
    location: { slug: location.slug, name: location.name, country_code: location.country_code },
    rows: layers.flatMap((l) => l.rows),
    ledger: mergeLedger(layers),
    profile,
  };
}

/** Lease and buy (where allowed), best first, with the year-3 sensitivity table. */
export function computeLive(i: LiveInputs, simulations = 1000): Candidate[] {
  return evaluateBuilt({ niche: i.niche, template: i.template, location: i.location, ledger: i.ledger, profile: i.profile, simulations, sensitivity: true });
}
