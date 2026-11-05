// Fit screen: every approved niche × every region in the profile. Pure code,
// no AI calls: hard filters, a quick simulation for each tenure, weighted
// scores, then the top pairings go to the review queue for approval.
import { db, defaultProfile, getSetting, must, type Thresholds } from '../_shared/db.ts';
import { loadLedger, REQUIRED_LOCATION_KEYS, type LocationRow } from '../_shared/ledger.ts';
import { evaluate, score, snapshotFor, type NicheRow } from '../_shared/pairing.ts';
import { withRun } from '../_shared/runs.ts';
import { round2 } from '../_shared/engine/random.ts';

export async function run(body: Record<string, unknown>) {
  const profile = body.profile_id
    ? must(await db().from('parameter_profiles').select('*').eq('id', body.profile_id).single(), 'profile')
    : await defaultProfile();
  const th = await getSetting<Thresholds>('thresholds');
  const params = profile.params;

  return withRun('fit_screen', { tokenBudget: 0, profileId: profile.id, input: body }, async (run) => {
    let nq = db().from('niches').select('id,slug,name,status,risk_tags,signal_score,card').eq('status', 'approved');
    if (body.niche_id) nq = nq.eq('id', body.niche_id);
    const niches = must(await nq, 'niches') as NicheRow[];
    let lq = db().from('locations').select('*').in('slug', params.regions ?? []).eq('active', true);
    if (body.location_id) lq = lq.eq('id', body.location_id);
    const locations = must(await lq, 'locations') as LocationRow[];
    const excluded: string[] = params.excluded_niche_tags ?? [];
    const results: Record<string, unknown>[] = [];

    for (const location of locations) {
      const ledger = await loadLedger(location);
      const missingKeys = REQUIRED_LOCATION_KEYS.filter((k) => !ledger.get(k));
      const pop = ledger.get('demand.population_40min')?.value_num ?? null;
      const risk = {
        countryDiscount: ledger.get('exit.country_discount')?.value_num ?? 0.2,
        advisory: ledger.get('safety.us_advisory_level')?.value_num ?? 1,
      };
      for (const niche of niches) {
        const reasons: string[] = [];
        const banned = (niche.risk_tags ?? []).filter((t) => excluded.includes(t));
        if (banned.length) reasons.push(`excluded tag: ${banned.join(', ')}`);
        // deno-lint-ignore no-explicit-any
        const needsPop = (niche.card?.model as any)?.requiresPopulation;
        if (needsPop && pop !== null && pop < th.day_pass_min_population_40min) reasons.push(`population ${pop} below ${th.day_pass_min_population_40min}`);
        if (params.visa?.[location.country_code] === 'not_allowed') reasons.push('owner cannot get residency');
        if (missingKeys.length) reasons.push(`needs data: ${missingKeys.join(', ')}`);

        let row: Record<string, unknown> = {
          niche_id: niche.id,
          location_id: location.id,
          profile_id: profile.id,
          hard_filter_reasons: reasons,
        };
        if (reasons.length) {
          row = { ...row, status: 'screened_out', scores: {}, score_total: null, rough_profit_year3: null };
        } else {
          const [best] = await evaluate(niche, location, profile, { simulations: Math.min(400, th.simulations) });
          const s = score(best, niche, location, params, risk);
          row = {
            ...row,
            status: s.total >= th.fit_score_min ? 'candidate' : 'screened_out',
            scores: {
              ...s.scores,
              tenure: best.tenure,
              startup_p50: round2(best.result.startup.total.p50),
              target_year_profit_p50: round2(snapshotFor(best.result, Number(params.target_year ?? 1)).profit.p50),
              fundable: best.result.startup.fundable,
              warnings: best.result.warnings,
            },
            score_total: s.total,
            rough_profit_year3: round2(best.result.month36.profit.p50),
          };
          if (s.total < th.fit_score_min) (row.hard_filter_reasons as string[]).push(`fit score ${s.total} below ${th.fit_score_min}`);
        }
        // Do not knock back pairings the owner already approved or that have been analysed.
        const existing = must(
          await db().from('pairings').select('id,status').eq('niche_id', niche.id).eq('location_id', location.id).eq('profile_id', profile.id).maybeSingle(),
          'pairing lookup',
        );
        if (existing && ['approved', 'analyzed', 'verified', 'rejected'].includes(existing.status)) {
          delete row.status;
        }
        const saved = must(
          await db().from('pairings').upsert(row, { onConflict: 'niche_id,location_id,profile_id' }).select('id,status,score_total').single(),
          'pairing upsert',
        );
        results.push({ pairing: saved.id, niche: niche.slug, location: location.slug, status: saved.status, score: saved.score_total, reasons });
      }
    }

    // Shortlist: best candidates go to the owner for approval.
    const shortlist = must(
      await db()
        .from('pairings')
        .select('id,score_total,scores,niches(name),locations(name)')
        .eq('profile_id', profile.id)
        .eq('status', 'candidate')
        .order('score_total', { ascending: false })
        .limit(th.shortlist_size),
      'shortlist',
    );
    for (const p of shortlist) {
      const open = must(
        await db().from('review_queue').select('id').eq('item_type', 'shortlist').eq('item_id', p.id).eq('status', 'pending').maybeSingle(),
        'queue lookup',
      );
      if (open) continue;
      await db().from('pairings').update({ status: 'awaiting_approval' }).eq('id', p.id);
      // deno-lint-ignore no-explicit-any
      const n = (p as any).niches?.name, l = (p as any).locations?.name;
      await db().from('review_queue').insert({
        item_type: 'shortlist',
        item_id: p.id,
        summary: `${n} in ${l}: fit ${p.score_total}, ${p.scores?.tenure}, startup ≈ $${Math.round(p.scores?.startup_p50 ?? 0).toLocaleString()}, year-${params.target_year ?? 1} profit ≈ $${Math.round(p.scores?.target_year_profit_p50 ?? 0).toLocaleString()}/mo`,
        payload: p.scores ?? {},
      });
    }
    return { screened: results.length, shortlisted: shortlist.length, results };
  });
}
