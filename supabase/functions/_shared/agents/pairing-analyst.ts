// Pairing analyst agent: research until confident. It runs the model, finds
// the inputs that move profit most, researches the guessed ones, maps the
// competition, re-runs, and stops when the uncertainty band is narrow enough
// or more research would not change the decision. Then it writes a memo, and
// the full 2,000-run analysis and the independent verifier run as before.
import { ToolError, type AgentContext, type AgentDef, type AgentTool } from '../agent.ts';
import { confirmQuote, fetchPage, figureTools, webSearch } from '../agent-tools.ts';
import { analyzePairing } from '../analysis.ts';
import { db, must } from '../db.ts';
import { capitalDrivers, driverKeys, PAIRING_KEY, uncertaintyBand } from '../drivers.ts';
import { capexKeyFor, PRICE_UNITS } from '../model-builder.ts';
import { isOfficialHost, RULE_TOPICS, rulesGap, type RuleRecord } from '../rules.ts';
import { hostOf } from '../evidence.ts';
import { AREA_KINDS, demandGaps, demandPull, kindDirectionProblem, kindsFor, MARKET_KINDS, type DemandKind, type DemandScope, type DemandSignal } from '../demand.ts';
import { KEY_GUIDE, PLAUSIBLE, REQUIRED_LOCATION_KEYS, writeAssumptions, type LocationRow } from '../ledger.ts';
import type { NicheModelSpec } from '../model-builder.ts';
import { evaluate, type NicheRow } from '../pairing.ts';
import { COUNTRY_KEYS } from '../scout.ts';

export interface AnalystParams extends Record<string, unknown> {
  pairing_id: string;
}
type Ctx = AgentContext<AnalystParams>;

interface Competitor {
  name: string;
  url: string;
  locality: string;
  drive_minutes: number;
  same_kind: boolean;
  note?: string;
}

const RAW_PLACE_KEYS = ['build.cost_per_sqft_usd', 'price.lodging_night_usd'];

async function loadAll(pairingId: string) {
  const p = must(await db().from('pairings').select('*').eq('id', pairingId).single(), 'pairing');
  const niche = must(await db().from('niches').select('*').eq('id', p.niche_id).single(), 'niche') as NicheRow;
  const location = must(await db().from('locations').select('*').eq('id', p.location_id).single(), 'location') as LocationRow;
  const profile = must(await db().from('parameter_profiles').select('*').eq('id', p.profile_id).single(), 'profile');
  return { p, niche, location, profile };
}

function demandOf(ctx: Ctx, written?: Record<string, unknown>) {
  const signals = (ctx.scratch.demand_signals ?? []) as DemandSignal[];
  if (!signals.length && !written) return null;
  return { ...demandPull(signals), signals, ...(written ?? {}) };
}

function research(ctx: Ctx) {
  return {
    rounds: (ctx.scratch.rounds ?? []) as unknown[],
    committed: (ctx.scratch.committed ?? {}) as Record<string, unknown>,
    competitors: (ctx.scratch.competitors ?? []) as Competitor[],
    session_id: ctx.sessionId,
  };
}

export const pairingAnalyst: AgentDef<AnalystParams> = {
  name: 'pairing-analyst',
  runKind: 'analysis',
  model: (m) => m.judgment,
  thinking: true,
  tools(ctx) {
    const runModel: AgentTool<AnalystParams> = {
      name: 'run_model',
      description:
        'Run the business model on the current ledger: take-home range for years 1 and 3, startup cost, fundability, the uncertainty band (and the target), and the top drivers of profit with their ledger keys and whether each is sourced, guessed or missing.',
      input_schema: { type: 'object', properties: {} },
      async run(_input, c) {
        const { niche, location, profile } = await loadAll(c.params.pairing_id);
        const [best] = await evaluate(niche, location, profile, { simulations: 500, pairingId: c.params.pairing_id, sensitivity: true });
        const r = best.result;
        const spec = niche.card.model as NicheModelSpec;
        const drivers = driverKeys(best.build.model, r.sensitivity, { tenure: best.tenure, siteType: spec.siteType, evidence: best.build.evidence });
        const band = uncertaintyBand(r.year3.takeHome);
        const rounds = ((c.scratch.rounds ??= []) as unknown[]);
        rounds.push({ at: new Date().toISOString(), band, year1: r.year1.takeHome.p50, year3: r.year3.takeHome.p50, startup: r.startup.total.p50, fundable: r.startup.fundable, sourcedShare: best.build.evidence.sourcedShare });
        return {
          round: rounds.length,
          tenure: best.tenure,
          fundable: r.startup.fundable,
          funding_note: r.startup.fundingNote,
          year1_take_home_monthly: r.year1.takeHome,
          year3_take_home_monthly: r.year3.takeHome,
          startup_cost_p50: r.startup.total.p50,
          cash_needed_p50: r.startup.cashNeeded.p50,
          months_to_open: r.startup.preOpeningMonthsP50,
          band,
          target_band: c.settings.target_band,
          evidence: { sourced_share: best.build.evidence.sourcedShare, niche_economics_guessed: best.build.evidence.nicheGuessed, missing: best.build.evidence.missing },
          top_drivers: drivers.slice(0, 6).map((d) => ({ ...d, definition: d.key ? (KEY_GUIDE[d.key] ?? definitionFor(d.key)) : 'part of the niche\'s own economics (not researched per idea)' })),
          streams: best.build.model.streams.map((s) => ({ key: s.key, label: s.label, market: s.market, price_unit: spec.streams.find((x) => x.key === s.key)?.priceUnit ?? 'not set', price_mode: s.price.mode, mature_occupancy_mode: s.matureOccupancy.mode, units: s.units })),
          top_capital_drivers: capitalDrivers(best.build.model, { evidence: best.build.evidence, capexKey: capexKeyFor }).slice(0, 6),
          land_acres: best.build.model.startupCosts.find((l) => l.key === 'land')?.label ?? null,
          site_needs: (niche.card as Record<string, unknown>).prerequisites ?? [],
          warnings: r.warnings,
        };
      },
    };

    // Read when a figure is committed: the task sets these after the tools are built.
    const locationId = () => ctx.scratch.location_id as string;
    const countryId = () => (ctx.scratch.country_id as string) ?? locationId();
    const [record, commit] = figureTools({
      agent: 'pairing-analyst',
      allowed: (k) => PAIRING_KEY.test(k) || (REQUIRED_LOCATION_KEYS as readonly string[]).includes(k) || RAW_PLACE_KEYS.includes(k),
      range: (k) =>
        k.startsWith('occupancy.') ? [0.02, 0.95]
        : k.startsWith('capex.') ? [200, 5_000_000]
        : k === 'site.acres' ? [0.1, 1000]
        : k.startsWith('price.') && !RAW_PLACE_KEYS.includes(k) ? [1, 50000]
        : (PLAUSIBLE[k] ?? null),
      terms: (k) => {
        const m = k.match(/^price\.([a-z0-9_]+)_usd$/);
        if (!m || RAW_PLACE_KEYS.includes(k) || k.startsWith('price.index')) return null;
        const spec = ctx.scratch.stream_units as Record<string, string> | undefined;
        return { unit: spec?.[m[1]], units: PRICE_UNITS };
      },
      subject: (k) =>
        PAIRING_KEY.test(k)
          ? { subject_type: 'pairing', subject_id: ctx.params.pairing_id }
          : { subject_type: 'location', subject_id: COUNTRY_KEYS.has(k) ? countryId() : locationId() },
    });

    const recordCompetitor: AgentTool<AnalystParams> = {
      name: 'record_competitor',
      description: 'Record one competing business (same kind of offer) near this place, with an exact quote from its page or listing that shows what it sells.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          url: { type: 'string' },
          quote: { type: 'string', description: 'Exact words from the page' },
          locality: { type: 'string' },
          drive_minutes: { type: 'number', description: 'Estimated drive from the place, in minutes' },
          same_kind: { type: 'boolean', description: 'true if guests would see it as the same kind of offer' },
          note: { type: 'string' },
        },
        required: ['name', 'url', 'quote', 'locality', 'drive_minutes', 'same_kind'],
      },
      async run(input: Competitor & { quote: string }, c) {
        if (!(await confirmQuote(c as unknown as AgentContext, input.url, input.quote))) throw new ToolError('That quote is not on the page. Copy it exactly.');
        const list = ((c.scratch.competitors ??= []) as Competitor[]);
        if (list.some((x) => x.name.toLowerCase() === input.name.toLowerCase())) return 'Already recorded.';
        list.push({ name: input.name, url: input.url, locality: input.locality, drive_minutes: Number(input.drive_minutes), same_kind: Boolean(input.same_kind), note: input.note });
        return { recorded: list.length, within_60_same_kind: list.filter((x) => x.same_kind && x.drive_minutes <= 60).length };
      },
    };

    const commitCompetition: AgentTool<AnalystParams> = {
      name: 'commit_competition',
      description: 'Write the number of same-kind competitors within about 60 minutes (counted by code from what you recorded). The model adjusts expected occupancy for it.',
      input_schema: { type: 'object', properties: { searched: { type: 'string', description: 'Where you looked' } }, required: ['searched'] },
      async run(input: { searched: string }, c) {
        const list = ((c.scratch.competitors ?? []) as Competitor[]).filter((x) => x.same_kind && x.drive_minutes <= 60);
        const n = list.length;
        const ids = await writeAssumptions(c.run, 'pairing-analyst', [{
          subject_type: 'pairing',
          subject_id: c.params.pairing_id,
          key: 'demand.competitors_60min',
          value_num: n,
          low: n,
          // Directories miss some operators, so the real count may be higher.
          high: Math.ceil(n * 1.5 + 1),
          unit: 'businesses',
          currency: null,
          source_url: list[0]?.url ?? null,
          source_note: `${n} same-kind business(es) within ~60 minutes: ${list.map((x) => `${x.name} (${x.locality}, ~${x.drive_minutes} min) ${x.url}`).join('; ') || 'none found'}. Searched: ${input.searched}`.slice(0, 2000),
          confidence: n >= 3 && new Set(list.map((x) => hostOf(x.url))).size >= 2 ? 'medium' : 'low',
          stale_after: '180 days',
        }]);
        return { competitors_within_60_min: n, assumption_id: ids[0] };
      },
    };


    const recordDemand: AgentTool<AnalystParams> = {
      name: 'record_demand_signal',
      description:
        'Record one piece of evidence about demand pull, with an exact quote from a page you saw. scope "market": is this kind of business wanted at all (search interest, operators opening sites, industry data, press, pricing power). scope "area": do people within reach of this place want it (busy nearby operators, local interest, population and income, visitors, related demand such as gyms or yoga studios, crowding, seasonality). Record evidence against as well as for.',
      input_schema: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['market', 'area'] },
          kind: { type: 'string', enum: [...MARKET_KINDS, ...AREA_KINDS] },
          direction: { type: 'string', enum: ['for', 'against'] },
          strength: { type: 'integer', enum: [1, 2, 3], description: '1 a hint, 2 clear, 3 strong and specific (numbers, sell-outs, waitlists, many reviews)' },
          finding: { type: 'string', description: 'One plain sentence: what this shows' },
          url: { type: 'string' },
          quote: { type: 'string', description: 'Exact words from the page' },
        },
        required: ['scope', 'kind', 'direction', 'strength', 'finding', 'url', 'quote'],
      },
      async run(input: Omit<DemandSignal, 'host'> & { quote: string }, c) {
        const scope = input.scope as DemandScope;
        if (!kindsFor(scope).includes(input.kind as DemandKind)) throw new ToolError(`${input.kind} is not a ${scope} signal. Use one of: ${kindsFor(scope).join(', ')}.`);
        const direction = input.direction === 'against' ? 'against' : 'for';
        const wrongWay = kindDirectionProblem(input.kind as DemandKind, direction);
        if (wrongWay) throw new ToolError(wrongWay);
        if (!(await confirmQuote(c as unknown as AgentContext, input.url, input.quote))) throw new ToolError('That quote is not on the page. Copy it exactly.');
        const list = ((c.scratch.demand_signals ??= []) as DemandSignal[]);
        if (list.some((x) => x.url === input.url && x.kind === input.kind)) return 'Already recorded from that page.';
        const strength = Math.max(1, Math.min(3, Math.round(Number(input.strength)))) as 1 | 2 | 3;
        list.push({ scope, kind: input.kind, direction, strength, finding: String(input.finding).slice(0, 400), url: input.url, host: hostOf(input.url) });
        return { recorded: list.length, market: list.filter((x) => x.scope === 'market').length, area: list.filter((x) => x.scope === 'area').length };
      },
    };

    const assessDemand: AgentTool<AnalystParams> = {
      name: 'assess_demand',
      description: 'Score demand pull from the signals you recorded (computed by code: market, area, overall 0-10, with confidence by number of independent sources). Call it after your last signal.',
      input_schema: { type: 'object', properties: {} },
      async run(_input, c) {
        const signals = (c.scratch.demand_signals ?? []) as DemandSignal[];
        c.scratch.demand_assessed = signals.length;
        const pull = demandPull(signals);
        return { ...pull, note: pull.area.confidence === 'low' ? 'Area evidence comes from one source or less; look for one more independent source if you can.' : undefined };
      },
    };

    const recordRule: AgentTool<AnalystParams> = {
      name: 'record_rule',
      description:
        'Record a rule that applies to this business here, from an official page (government site or published code), with an exact quote: who issues the permit and what it requires (health and pool/spa rules, zoning and use, building, business licence, lodging tax). Names of agencies change; never write one from memory.',
      input_schema: {
        type: 'object',
        properties: {
          topic: { type: 'string', enum: [...RULE_TOPICS] },
          agency: { type: 'string', description: 'The authority exactly as its own page names it' },
          requirement: { type: 'string', description: 'One plain sentence: what is required and when' },
          url: { type: 'string' },
          quote: { type: 'string', description: 'Exact words from the page' },
        },
        required: ['topic', 'agency', 'requirement', 'url', 'quote'],
      },
      async run(input: RuleRecord, c) {
        if (!isOfficialHost(hostOf(input.url))) throw new ToolError(`${hostOf(input.url)} is not an official source. Find the rule on the government agency's own site or the published code.`);
        if (!(await confirmQuote(c as unknown as AgentContext, input.url, input.quote))) throw new ToolError('That quote is not on the page. Copy it exactly.');
        if (!(await confirmQuote(c as unknown as AgentContext, input.url, input.agency))) throw new ToolError(`"${input.agency}" is not named on that page. Use the agency name as the page shows it.`);
        const list = ((c.scratch.rules ??= []) as RuleRecord[]);
        if (list.some((r) => r.url === input.url && r.requirement === input.requirement)) return 'Already recorded.';
        list.push({ topic: input.topic, agency: String(input.agency).slice(0, 200), requirement: String(input.requirement).slice(0, 400), url: input.url, quote: String(input.quote).slice(0, 400) });
        return { recorded: list.length };
      },
    };

    const tools: AgentTool<AnalystParams>[] = [runModel, webSearch, fetchPage, record, commit, recordCompetitor, commitCompetition, recordDemand, assessDemand, recordRule];
    if (Deno.env.get('GOOGLE_MAPS_API_KEY')) tools.push(findPlaces);
    return tools;
  },
  async task(ctx) {
    const { p, niche, location } = await loadAll(ctx.params.pairing_id);
    ctx.scratch.location_id = location.id;
    ctx.scratch.country_id = location.parent_id ?? location.id;
    const card = niche.card as Record<string, unknown>;
    const spec = card.model as NicheModelSpec;
    ctx.scratch.stream_units = Object.fromEntries(spec.streams.filter((s) => s.priceUnit).map((s) => [s.key, s.priceUnit]));
    ctx.scratch.needs_permits = Array.isArray(card.permits) && (card.permits as unknown[]).length > 0;
    return [
      `Analyse this business idea: **${niche.name}** in **${location.name}** (${location.country_code}).`,
      card.summary || card.description ? `What it is: ${String(card.summary ?? card.description).slice(0, 600)}` : '',
      Array.isArray(card.competitor_terms) ? `Words competitors use: ${(card.competitor_terms as string[]).join(', ')}.` : '',
      Array.isArray(card.permits) && card.permits.length ? `Permits the write-up expects (unsourced, written from memory; confirm on official pages): ${(card.permits as string[]).join('; ')}.` : '',
      `Current screening score: ${p.score_total ?? 'n/a'}.`,
      await redTeamNote(p.latest_result_id),
      `Stop researching when the band from run_model is at or below ${ctx.settings.target_band}, or the top drivers are sourced, or more research would not change the decision.`,
      'Start with run_model.',
    ].filter(Boolean).join('\n');
  },
  finish: {
    description: 'Finish with the memo. Take every money figure from run_model; do not compute your own.',
    schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['pursue', 'maybe', 'avoid'] },
        headline: { type: 'string' },
        risks: { type: 'array', items: { type: 'string' } },
        kill_criteria: { type: 'array', items: { type: 'string' } },
        cheapest_validation: { type: 'array', items: { type: 'string' } },
        what_would_change_my_mind: { type: 'string' },
        research_summary: { type: 'string', description: 'What you researched, what changed, and what is still guessed' },
        demand: {
          type: 'object',
          description: 'Demand pull in words; the scores come from assess_demand',
          properties: {
            market_summary: { type: 'string', description: 'Two or three sentences: is this kind of business wanted, and is that growing?' },
            area_summary: { type: 'string', description: 'Two or three sentences: do people within reach of this place want it, and who exactly?' },
            unknowns: { type: 'array', items: { type: 'string' }, description: 'What about demand is still not known' },
          },
          required: ['market_summary', 'area_summary', 'unknowns'],
        },
      },
      required: ['verdict', 'headline', 'risks', 'kill_criteria', 'cheapest_validation', 'what_would_change_my_mind', 'research_summary', 'demand'],
    },
  },
  checkFinish(ctx) {
    return (
      demandGaps((ctx.scratch.demand_signals ?? []) as DemandSignal[], ctx.scratch.demand_assessed as number | undefined) ??
      rulesGap(Boolean(ctx.scratch.needs_permits), (ctx.scratch.rules ?? []) as RuleRecord[])
    );
  },
  async onFinish(ctx, result) {
    const { demand, ...memo } = result as Record<string, unknown> & { demand?: Record<string, unknown> };
    const pull = demandOf(ctx, demand ?? {});
    const out = await analyzePairing(ctx.run, ctx.params.pairing_id, {
      research: false,
      verify: true,
      verifyInBackground: true,
      extras: { memo: { ...memo, by: 'pairing-analyst', at: new Date().toISOString() }, research: research(ctx), demand: pull, rules: ctx.scratch.rules ?? [] },
    });
    await saveDemandScore(ctx.params.pairing_id, pull);
    // An independent agent re-researches the inputs that matter most, without seeing these sources.
    await db().rpc('queue_agent', { p_name: 'red-team', p_body: { result_id: out.resultId } });
    return out;
  },
  async onStop(ctx, reason) {
    // Out of budget or turns: still store the analysis with whatever was researched, unverified.
    const pull = demandOf(ctx);
    const out = await analyzePairing(ctx.run, ctx.params.pairing_id, { research: false, verify: false, extras: { research: { ...research(ctx), stopped: reason }, demand: pull, rules: ctx.scratch.rules ?? [] } });
    await saveDemandScore(ctx.params.pairing_id, pull);
    return out;
  },
};

/** Gaps an independent check found in the previous analysis: the analyst must reconcile them with sources. */
// deno-lint-ignore no-explicit-any
async function redTeamNote(resultId: string | null): Promise<string> {
  if (!resultId) return '';
  const ar = await db().from('analysis_results').select('result').eq('id', resultId).maybeSingle();
  const findings = ((ar.data?.result as Record<string, any> | undefined)?.red_team?.findings ?? []) as { key: string; label: string; current: number; found: number; urls: string[]; flagged: boolean }[];
  const flagged = findings.filter((f) => f.flagged);
  if (!flagged.length) return '';
  return [
    'An independent check of the previous analysis found different values. Research each again and commit the value the evidence supports (it may be either):',
    ...flagged.map((f) => `- ${f.key} (${f.label}): analysis used ${f.current}, the check found ${f.found} at ${f.urls.join(' ')}`),
  ].join('\n');
}

/** Keep the demand score with the idea, so the next screening scores demand for this place, not just the niche. */
async function saveDemandScore(pairingId: string, pull: ReturnType<typeof demandOf>) {
  if (!pull || pull.level === 'unclear') return;
  const p = must(await db().from('pairings').select('scores,niche_id,location_id').eq('id', pairingId).single(), 'pairing');
  const demand_pull = { overall: pull.overall, level: pull.level, market: pull.market.score, area: pull.area.score, at: new Date().toISOString() };
  await db().from('pairings').update({ scores: { ...(p.scores ?? {}), demand_pull } }).eq('id', pairingId);
  await db().rpc('queue_fit_screen', { p_niche: p.niche_id, p_location: p.location_id });
}

function definitionFor(key: string): string {
  if (key.startsWith('price.')) return 'Price per unit sold for this stream at comparable businesses near this place (USD)';
  if (key.startsWith('occupancy.') && key.endsWith('.mature')) return 'Share of sellable capacity sold once mature (0-1), from comparable operators or regional lodging statistics';
  if (key.startsWith('occupancy.')) return 'Share of sellable capacity sold in the first months (0-1)';
  return key;
}

/** Google Places text search, when a key is configured: names, ratings and review counts of nearby businesses. */
const findPlaces: AgentTool<AnalystParams> = {
  name: 'find_places',
  description: 'Search Google Maps for businesses near a place (e.g. "sauna near Marshall NC"). Returns names, addresses, ratings and review counts; review counts are a rough sign of demand.',
  input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  async run(input: { query: string }, c) {
    c.run.chargeSearch();
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Goog-Api-Key': Deno.env.get('GOOGLE_MAPS_API_KEY')!,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.googleMapsUri,places.websiteUri',
      },
      body: JSON.stringify({ textQuery: String(input.query).slice(0, 200), maxResultCount: 15 }),
    });
    if (!res.ok) throw new ToolError(`Places search failed (${res.status}).`);
    const body = await res.json();
    // deno-lint-ignore no-explicit-any
    const places = (body.places ?? []).map((p: any) => ({
      name: p.displayName?.text ?? '',
      address: p.formattedAddress ?? '',
      rating: p.rating ?? null,
      reviews: p.userRatingCount ?? 0,
      url: p.googleMapsUri ?? p.websiteUri ?? '',
      website: p.websiteUri ?? null,
    }));
    for (const p of places) if (p.url) c.scratch.evidence[p.url] = { url: p.url, title: p.name, snippet: `${p.name} — ${p.address} — rating ${p.rating ?? 'n/a'} (${p.reviews} reviews)` };
    return places;
  },
};
