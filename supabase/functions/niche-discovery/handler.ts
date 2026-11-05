// Niche discovery, two modes:
//   mode=draft (default): for proposed niches not yet written up (or a given
//     niche_id), search for real examples, describe the niche, draft its
//     economics and cost template, test them through the engine, and put the
//     niche in front of the owner.
//   mode=brainstorm: search broadly for land-based wellness concepts and add
//     any not already in the library as proposed niches.
import { db, getSetting, must, type Budgets, type Models } from '../_shared/db.ts';
import { ask, clip } from '../_shared/llm.ts';
import { buildModel, mergeLedger, type CostTemplate, type NicheModelSpec } from '../_shared/model-builder.ts';
import { analyze } from '../_shared/engine/index.ts';
import { withRun, type Run } from '../_shared/runs.ts';
import { search } from '../_shared/search.ts';

const tri = { type: 'object', properties: { low: { type: 'number' }, mode: { type: 'number' }, high: { type: 'number' } }, required: ['low', 'mode', 'high'] };

const str = { type: 'string' };
const strs = { type: 'array', items: str };
const num = { type: 'number' };
const obj = (properties: Record<string, unknown>) => ({ type: 'object' as const, properties, required: Object.keys(properties) });

// Two compact schemas instead of one large one: structured outputs compile
// each schema to a grammar, and every field required keeps that grammar small.
const DESCRIBE_SCHEMA = obj({
  summary: { ...str, description: 'Two or three plain sentences: what the guest gets and how the business makes money' },
  why_interesting: { ...str, description: 'Why this could work now: demand, trend, gap in supply' },
  unique_angle: { ...str, description: 'One sentence: what makes it different from an ordinary retreat or spa' },
  structures: str,
  revenue_units: str,
  price_model: str,
  staffing: str,
  permits: strs,
  demand_drivers: strs,
  competitor_terms: strs,
  risk_tags: { ...strs, description: 'Include psychedelic or medical_license if the business needs them; otherwise empty' },
  operating_examples: { type: 'array', items: obj({ name: str, locality: str, country: str, source_index: { type: 'integer' }, note: str }) },
});

const ECONOMICS_SCHEMA = obj({
  ownerFixedHours: num,
  variablePct: tri,
  requiresPopulation: { type: 'boolean', description: 'true if most revenue is local day visits' },
  streams: {
    type: 'array',
    items: obj({ key: str, label: str, units: num, sellablePerUnitPerMonth: num, price: tri, startOccupancy: tri, matureOccupancy: tri, monthsToMature: tri, ownerHoursPerSale: num }),
  },
  perSale: { type: 'array', items: obj({ stream: str, usd: tri, scale: { type: 'string', enum: ['price', 'none'] } }) },
  fixed: { type: 'array', items: obj({ key: str, label: str, usd: tri, scale: { type: 'string', enum: ['price', 'none'] }, applies: { type: 'string', enum: ['own', 'lease', 'both'] } }) },
  staffing: { type: 'array', items: obj({ key: str, label: str, wageMultiple: tri, fromMonth: num }) },
  exit: obj({ sdeMultiple: tri, ebitdaMultiple: tri, managerWageMultiple: num }),
  land_acres: num,
  startup_items: {
    type: 'array',
    description: 'One-off costs. qty: count, or 0 when qtyFrom names a stream whose unit count sets it. leaseMonths: only for the lease deposit item (usd ignored), else 0.',
    items: obj({
      key: str,
      label: str,
      qty: num,
      qtyFrom: str,
      usd: tri,
      scale: { type: 'string', enum: ['build', 'equipment', 'none'] },
      applies: { type: 'string', enum: ['own', 'lease', 'both'] },
      leaseMonths: num,
    }),
  },
});

type Describe = {
  summary: string; why_interesting: string; unique_angle: string; structures: string; revenue_units: string; price_model: string; staffing: string;
  permits: string[]; demand_drivers: string[]; competitor_terms: string[]; risk_tags: string[];
  operating_examples: { name: string; locality: string; country: string; source_index: number; note: string }[];
};
// deno-lint-ignore no-explicit-any
type Economics = any;

/** Map the flat economics reply onto the model card and cost template the engine uses. */
export function toModelAndTemplate(e: Economics): { model: NicheModelSpec; template: CostTemplate } {
  const model: NicheModelSpec = {
    ownerFixedHours: e.ownerFixedHours,
    variablePct: e.variablePct,
    requiresPopulation: e.requiresPopulation,
    streams: e.streams,
    perSale: Object.fromEntries((e.perSale ?? []).map((p: { stream: string; usd: unknown; scale: string }) => [p.stream, { usd: p.usd, scale: p.scale }])),
    fixed: e.fixed,
    staffing: (e.staffing ?? []).map((s: { fromMonth: number }) => ({ ...s, fromMonth: Math.max(1, Math.round(s.fromMonth || 1)) })),
    exit: e.exit,
  };
  const template: CostTemplate = {
    land_acres: e.land_acres,
    items: (e.startup_items ?? []).map((i: { key: string; label: string; qty: number; qtyFrom: string; usd: unknown; scale: string; applies: string; leaseMonths: number }) =>
      i.leaseMonths > 0
        ? { key: i.key, label: i.label, applies: i.applies, leaseMonths: i.leaseMonths }
        : { key: i.key, label: i.label, applies: i.applies, usd: i.usd, scale: i.scale, ...(i.qtyFrom ? { qtyFrom: i.qtyFrom } : { qty: i.qty || 1 }) },
    ),
  };
  return { model, template };
}

/** Run the drafted card through the engine with a neutral US ledger to catch broken drafts. */
function smokeTest(model: NicheModelSpec, template: CostTemplate): string[] {
  const problems: string[] = [];
  const row = (key: string, v: number) => ({ id: key, key, value_num: v, value_text: null, low: null, high: null, confidence: 'high' as const, source_url: null, written_by: 'test' });
  const ledger = mergeLedger([{ scope: 'country', rows: [row('labor.monthly_wage_usd', 2800), row('land.price_per_acre_usd', 25000), row('lease.finca_monthly_usd', 3500)] }]);
  for (const tenure of ['own', 'lease'] as const) {
    try {
      const b = buildModel({
        niche: { slug: 'draft', name: 'draft', model },
        template,
        location: { slug: 'test', name: 'test', country_code: 'US' },
        ledger,
        profile: { capital_usd: { min: 100000, max: 150000 }, financing_allowed: ['cash', 'sba', 'lease'] },
        tenure,
      });
      const r = analyze(b.model, { simulations: 100, seed: 7 });
      const vals = [r.month12.profit.p50, r.month36.profit.p50, r.startup.total.p50];
      if (vals.some((v) => !Number.isFinite(v))) problems.push(`${tenure}: non-numeric result`);
      if (r.startup.total.p50 <= 0) problems.push(`${tenure}: zero startup cost`);
      if (r.month36.revenue.p50 <= 0) problems.push(`${tenure}: no revenue`);
    } catch (e) {
      problems.push(`${tenure}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return problems;
}

async function draftNiche(run: Run, models: Models, nicheId: string) {
  const niche = must(await db().from('niches').select('*').eq('id', nicheId).single(), 'niche');
  const examples = must(await db().from('example_businesses').select('name,locality,country,url,description,prices').eq('niche_id', nicheId).limit(8), 'examples');
  const seen = new Set<string>();
  const hits = [
    ...(await search(run, `${niche.name} retreat business`, 8)),
    ...(await search(run, `${niche.name} prices per night packages`, 6)),
    ...(await search(run, `how much does it cost to build ${niche.name} startup cost`, 6)),
  ].filter((h) => !seen.has(h.url) && seen.add(h.url));
  const reference = must(await db().from('niches').select('card').eq('slug', 'dark-retreat').maybeSingle(), 'reference card');
  const context = [
    `Niche: ${niche.name}${niche.card?.description ? ` — ${niche.card.description}` : ''}${niche.card?.note ? ` — ${niche.card.note}` : ''}`,
    `Known operating examples:\n${examples.map((e) => `- ${e.name} (${e.locality}, ${e.country}) ${e.url}: ${clip(e.description ?? '', 300)} prices=${JSON.stringify(e.prices)}`).join('\n') || '(none)'}`,
    `Search results:\n${hits.map((h, i) => `[${i}] ${h.url}\n  ${h.title}: ${clip(h.snippet, 400)}`).join('\n')}`,
  ].join('\n\n');

  // The two calls are independent, so run them side by side.
  const [describe, economics] = await Promise.all([
  ask<Describe>({
    run,
    model: models.judgment,
    system: 'You describe small wellness businesses that need land or a dedicated structure, for someone deciding which to start. Be concrete and plain. Use only what the material supports.',
    prompt: `${context}\n\nDescribe this niche. Under operating_examples list real businesses of this kind you can see in the results, citing the [n].`,
    tool: { name: 'niche_description', description: 'A description of the niche', schema: DESCRIBE_SCHEMA },
    maxTokens: 4000,
  }),
  ask<Economics>({
    run,
    model: models.judgment,
    system:
      'You design unit economics for small wellness businesses tied to land or a structure, for a solo owner-operator with $100-150k. Use the evidence given plus conservative industry norms; prefer wide ranges to false precision. All money in USD at a rural western North Carolina baseline.',
    prompt: [
      context,
      `Reference economics for a different niche, to show the expected shape and scale:\n${clip(JSON.stringify(reference?.card?.model ?? {}), 3000)}`,
      'Give the economics. Do not include rent, lease or land in fixed costs (the place\'s lease is added separately). List paid staff the business would need if the owner did not do the work; the owner runs it solo when the hours fit. ownerFixedHours must include all hours someone has to be on site (open hours, check-ins), not just admin. A stream with one unit and one sale a month is a flat monthly revenue line. wageMultiple is a multiple of one full-time local wage. Include a lease deposit startup item (leaseMonths 2, applies lease) and mark items own/lease where they differ (buildings are "own"; converting a leased house is "lease").',
    ].join('\n\n'),
    tool: { name: 'niche_economics', description: 'Unit economics and start-up costs', schema: ECONOMICS_SCHEMA },
    maxTokens: 12000,
  }),
  ]);

  const { model, template } = toModelAndTemplate(economics);
  const problems = smokeTest(model, template);
  const { risk_tags, operating_examples, ...rest } = describe;
  let examplesAdded = 0;
  for (const ex of operating_examples ?? []) {
    const src = hits[ex.source_index];
    if (!src || !ex.name) continue;
    const fp = must(await db().rpc('business_fingerprint', { name: ex.name, locality: ex.locality, country: ex.country }), 'fingerprint') as string;
    const [dupe] = must(await db().rpc('match_examples', { q: fp, min_similarity: 0.6, max_rows: 1 }), 'match');
    if (dupe) continue;
    const { error } = await db().from('example_businesses').insert({ niche_id: nicheId, name: ex.name, locality: ex.locality, country: ex.country, url: src.url, description: ex.note, fingerprint: fp, status: 'operating' });
    if (!error) examplesAdded++;
  }
  if (examplesAdded) await db().rpc('refresh_niche_signals');
  const card = { ...(niche.card ?? {}), ...rest, sources: hits.map((h) => h.url), model: { ...model, basis: 'AI draft from examples and search results; review before approving.' }, drafted_by_run: run.id, smoke_test: problems };
  await db().from('niches').update({ card, risk_tags: risk_tags ?? [] }).eq('id', nicheId);
  if (!problems.length) {
    const last = must(await db().from('cost_templates').select('version').eq('niche_id', nicheId).order('version', { ascending: false }).limit(1).maybeSingle(), 'template version');
    await db().from('cost_templates').insert({ niche_id: nicheId, version: (last?.version ?? 0) + 1, template, notes: `Drafted by run ${run.id}` });
  }
  await db().from('review_queue').insert({
    item_type: 'niche',
    item_id: nicheId,
    summary: problems.length
      ? `${niche.name}: draft card failed checks (${problems.join('; ')}). Needs more research.`
      : `${niche.name}: ${rest.unique_angle ?? 'drafted'} (${examples.length + examplesAdded} operating examples). Approve to pair it with your places.`,
    payload: { risk_tags, streams: model.streams?.map((s) => s.label) },
  });
  return { niche: niche.slug, ok: problems.length === 0, problems, examplesAdded };
}

async function brainstorm(run: Run, models: Models) {
  const queries = [
    'unusual wellness retreat concepts rural property',
    'new types of wellness tourism on farmland',
    'unique sauna bathhouse concept opens countryside',
    'experiential wellness lodging trend 2026',
    'niche retreat concept nobody else offers',
    'nuevo concepto de bienestar en finca',
  ];
  const hits = (await Promise.all(queries.map((q) => search(run, q, 8)))).flat();
  const known = must(await db().from('niches').select('slug,name'), 'niches');
  const out = await ask<{ ideas: { name: string; description: string; source_index: number }[] }>({
    run,
    model: models.judgment,
    system: 'You find distinct, unusual wellness business concepts that need land or a dedicated structure and that already operate somewhere. Favour specific, surprising formats over generic retreats. Skip anything in the known list, anything purely urban, and anything needing a medical licence or psychedelics.',
    prompt: `Known niches: ${known.map((k) => k.name).join('; ')}\n\nSearch results:\n${hits.map((h, i) => `[${i}] ${h.url}\n  ${h.title}: ${clip(h.snippet, 300)}`).join('\n')}`,
    tool: {
      name: 'ideas',
      description: 'New niche ideas, each backed by a result URL',
      schema: {
        type: 'object',
        properties: { ideas: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, source_index: { type: 'integer' } }, required: ['name', 'description', 'source_index'] } } },
        required: ['ideas'],
      },
    },
    maxTokens: 2500,
  });
  const added: string[] = [];
  const skipped: string[] = [];
  for (const idea of out.ideas) {
    const source = hits[idea.source_index];
    if (!source) {
      skipped.push(`${idea.name} (no source)`);
      continue;
    }
    const [match] = must(await db().rpc('match_niches', { q: idea.name, min_similarity: 0.55, max_rows: 1 }), 'match');
    if (match) {
      skipped.push(`${idea.name} (same as ${match.name})`);
      continue;
    }
    const slug = idea.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    const { error } = await db().from('niches').insert({ slug, name: idea.name, family: 'brainstorm', status: 'proposed', card: { description: idea.description, discovered_from: source.url } });
    if (error) skipped.push(`${idea.name} (${error.message})`);
    else added.push(idea.name);
  }
  return { ideas: out.ideas.length, added, skipped };
}

export async function run(body: Record<string, unknown>) {
  const budgets = await getSetting<Budgets>('budgets');
  const models = await getSetting<Models>('models');
  return withRun('niche_discovery', { tokenBudget: budgets.niche_discovery_tokens, searchBudget: 40, subjectId: body.niche_id as string | undefined, input: body }, async (run) => {
    if (body.mode === 'brainstorm') return await brainstorm(run, models);
    let ids: string[];
    if (body.niche_id) ids = [String(body.niche_id)];
    else {
      // Proposed niches not yet written up: starred first, then strongest signal.
      // The write-up searches for operating examples itself.
      const rows = must(
        await db().from('niches').select('id,card,signal_score,favorite').eq('status', 'proposed').order('favorite', { ascending: false }).order('signal_score', { ascending: false }).limit(40),
        'proposed',
      );
      ids = rows
        // deno-lint-ignore no-explicit-any
        .filter((r: any) => !r.card?.model && !r.card?.smoke_test)
        .slice(0, Number(body.limit ?? 3))
        .map((r) => r.id);
    }
    const drafted: unknown[] = [];
    for (const id of ids) drafted.push(await draftNiche(run, models, id));
    return { drafted };
  });
}
