// Fit screen: every written-up niche (in use or still a new idea) × one place
// (a full re-rank queues one job per place). Pure code, no AI calls. Ideas are dropped only for hard
// reasons (excluded tags, a place that can't support the niche, no residency
// route); everything else is kept, scored and ranked money-first in the app.
import { db, defaultProfile, getSetting, must, type Thresholds } from '../_shared/db.ts';
import { loadLedger, type LocationRow } from '../_shared/ledger.ts';
import { evaluate, type NicheRow } from '../_shared/pairing.ts';
import { scoreIdea, snapshotFor, targetFigure, type TargetBasis } from '../_shared/scoring.ts';
import { withRun } from '../_shared/runs.ts';
import { round2 } from '../_shared/engine/random.ts';

export async function run(body: Record<string, unknown>) {
  const profile = body.profile_id
    ? must(await db().from('parameter_profiles').select('*').eq('id', body.profile_id).single(), 'profile')
    : await defaultProfile();
  const th = await getSetting<Thresholds>('thresholds');
  const params = profile.params;
  const basis: TargetBasis = params.target_basis === 'pre_tax' ? 'pre_tax' : 'after_tax';
  const targetYear = Number(params.target_year ?? 1);
  const target = Number(params.target_monthly_profit_usd ?? 5000);

  // A full re-rank is too much for one call: queue one job per place (they run in parallel).
  if (!body.location_id) {
    const { data: queued, error } = await db().rpc('queue_fit_screen', { p_niche: body.niche_id ?? null });
    if (error) throw new Error(`Could not queue the re-rank: ${error.message}`);
    return { queued, note: 'Re-ranking runs in the background, one job per place; results appear within a minute or two.' };
  }

  return withRun('fit_screen', { tokenBudget: 0, searchBudget: 0, profileId: profile.id, subjectId: String(body.location_id), input: body, exclusive: true }, async () => {
    let nq = db().from('niches').select('id,slug,name,status,risk_tags,signal_score,card').in('status', ['approved', 'proposed']);
    if (body.niche_id) nq = nq.eq('id', body.niche_id);
    // deno-lint-ignore no-explicit-any
    const niches = (must(await nq, 'niches') as NicheRow[]).filter((n) => n.card?.model && !((n.card as any).smoke_test?.length));
    let lq = db().from('locations').select('*').eq('active', true).eq('level', 'micro_area');
    if (body.location_id) lq = lq.eq('id', body.location_id);
    const locations = must(await lq, 'locations') as LocationRow[];
    const checks = must(await db().from('niche_place_checks').select('niche_id,location_id,verdict,reason'), 'site checks') as {
      niche_id: string; location_id: string; verdict: string; reason: string;
    }[];
    const checkFor = (n: string, l: string) => checks.find((c) => c.niche_id === n && c.location_id === l);
    const excluded: string[] = params.excluded_niche_tags ?? [];
    const results: Record<string, unknown>[] = [];

    for (const location of locations) {
      const ledger = await loadLedger(location);
      const pop = ledger.get('demand.population_40min')?.value_num ?? null;
      const countryDiscount = ledger.get('exit.country_discount')?.value_num ?? 0.2;
      const advisory = ledger.get('safety.us_advisory_level')?.value_num ?? 1;
      for (const niche of niches) {
        const reasons: string[] = [];
        const banned = (niche.risk_tags ?? []).filter((t) => excluded.includes(t));
        if (banned.length) reasons.push(`excluded tag: ${banned.join(', ')}`);
        // deno-lint-ignore no-explicit-any
        const card = niche.card as any;
        if (card.model?.requiresPopulation && pop !== null && pop < th.day_pass_min_population_40min) {
          reasons.push(`only ${Math.round(pop).toLocaleString()} people within 40 minutes; this niche needs ${th.day_pass_min_population_40min.toLocaleString()}`);
        }
        if (params.visa?.[location.country_code] === 'not_allowed') reasons.push('no residency route for you');
        const site = checkFor(niche.id, location.id);
        if (site?.verdict === 'no') reasons.push(`site: ${site.reason}`);

        let row: Record<string, unknown> = { niche_id: niche.id, location_id: location.id, profile_id: profile.id, hard_filter_reasons: reasons };
        if (reasons.length) {
          row = { ...row, status: 'screened_out', scores: { niche_status: niche.status }, score_total: null, rough_profit_year3: null };
        } else {
          const [best] = await evaluate(niche, location, profile, { simulations: 300, sensitivity: false });
          const r = best.result;
          const s = scoreIdea(
            {
              result: r,
              evidence: best.build.evidence,
              target,
              targetYear,
              basis,
              nicheDemand: typeof card.demand_score === 'number' ? card.demand_score : null,
              signalScore: Number(niche.signal_score ?? 0),
              placeFit: typeof location.fit?.score === 'number' ? location.fit.score : null,
              visaRoute: params.visa?.[location.country_code],
              countryDiscount,
              advisoryLevel: advisory,
            },
            params.weights ?? {},
          );
          const y = snapshotFor(r, targetYear);
          row = {
            ...row,
            status: 'candidate',
            scores: {
              parts: s.parts,
              niche_status: niche.status,
              tenure: best.tenure,
              basis,
              fundable: r.startup.fundable,
              funding_note: r.startup.fundingNote,
              lender: r.lender,
              startup_p50: round2(r.startup.total.p50),
              cash_needed_p50: round2(r.startup.cashNeeded.p50),
              pre_opening_months: r.startup.preOpeningMonthsP50,
              target_year_figure: round2(targetFigure(r, targetYear, basis)),
              target_year_range: basis === 'pre_tax' ? y.profit : y.takeHome,
              year3_figure: round2(targetFigure(r, 3, basis)),
              needs_help: r.capacity.needsHelp,
              paid_help_hours: r.capacity.paidHelpHoursP50,
              evidence: best.build.evidence,
              site_check: site ? { verdict: site.verdict, reason: site.reason } : null,
              warnings: r.warnings,
            },
            score_total: s.total,
            rough_profit_year3: round2(targetFigure(r, 3, basis)),
          };
        }
        // Keep decisions the owner already made.
        const existing = must(
          await db().from('pairings').select('id,status').eq('niche_id', niche.id).eq('location_id', location.id).eq('profile_id', profile.id).maybeSingle(),
          'pairing lookup',
        );
        if (existing && ['approved', 'analyzed', 'verified', 'rejected'].includes(existing.status)) delete row.status;
        const saved = must(
          await db().from('pairings').upsert(row, { onConflict: 'niche_id,location_id,profile_id' }).select('id,status,score_total').single(),
          'pairing upsert',
        );
        results.push({ pairing: saved.id, niche: niche.slug, location: location.slug, status: saved.status, score: saved.score_total, reasons });
      }
    }
    return { screened: results.length, kept: results.filter((r) => r.status !== 'screened_out').length };
  });
}
