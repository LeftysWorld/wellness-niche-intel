// Niche discovery, two modes:
//   mode=draft (default): for proposed niches that have enough examples (or a
//     given niche_id), research and draft a model card and cost template, test
//     them through the engine, and put the niche in front of the owner.
//   mode=brainstorm: search broadly for land-based wellness concepts and add
//     any not already in the library as proposed niches.
import { db, getSetting, must, type Budgets, type Models, type Thresholds } from '../_shared/db.ts';
import { ask, clip } from '../_shared/llm.ts';
import { buildModel, mergeLedger, type CostTemplate, type NicheModelSpec } from '../_shared/model-builder.ts';
import { analyze } from '../_shared/engine/index.ts';
import { withRun, type Run } from '../_shared/runs.ts';
import { search } from '../_shared/search.ts';

const tri = { type: 'object', properties: { low: { type: 'number' }, mode: { type: 'number' }, high: { type: 'number' } }, required: ['low', 'mode', 'high'] };

const CARD_SCHEMA = {
  type: 'object' as const,
  properties: {
    summary: { type: 'string' },
    structures: { type: 'string' },
    revenue_units: { type: 'string' },
    price_model: { type: 'string' },
    staffing: { type: 'string' },
    permits: { type: 'array', items: { type: 'string' } },
    demand_drivers: { type: 'array', items: { type: 'string' } },
    competitor_terms: { type: 'array', items: { type: 'string' } },
    risk_tags: { type: 'array', items: { type: 'string' }, description: 'Use psychedelic or medical_license when the business needs them' },
    min_land_acres: { type: 'number' },
    model: {
      type: 'object',
      description: 'US-baseline economics in USD (rural western North Carolina = 1.0 price and build index)',
      properties: {
        ownerFixedHours: { type: 'number' },
        variablePct: tri,
        requiresPopulation: { type: 'boolean', description: 'true if most revenue is local day visits' },
        streams: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              label: { type: 'string' },
              units: { type: 'number' },
              sellablePerUnitPerMonth: { type: 'number' },
              price: tri,
              startOccupancy: tri,
              matureOccupancy: tri,
              monthsToMature: tri,
              ownerHoursPerSale: { type: 'number' },
            },
            required: ['key', 'label', 'units', 'sellablePerUnitPerMonth', 'price', 'startOccupancy', 'matureOccupancy', 'monthsToMature'],
          },
        },
        perSale: { type: 'object', description: 'stream key → {usd: tri, scale: "price"|"none"}' },
        fixed: {
          type: 'array',
          items: {
            type: 'object',
            properties: { key: { type: 'string' }, label: { type: 'string' }, usd: tri, scale: { type: 'string', enum: ['price', 'none'] }, applies: { type: 'string', enum: ['own', 'lease', 'both'] } },
            required: ['key', 'label', 'usd', 'scale', 'applies'],
          },
        },
        staffing: {
          type: 'array',
          items: {
            type: 'object',
            properties: { key: { type: 'string' }, label: { type: 'string' }, wageMultiple: tri, fromMonth: { type: 'number' } },
            required: ['key', 'label', 'wageMultiple'],
          },
        },
        exit: {
          type: 'object',
          properties: { sdeMultiple: tri, ebitdaMultiple: tri, managerWageMultiple: { type: 'number' } },
          required: ['sdeMultiple', 'ebitdaMultiple', 'managerWageMultiple'],
        },
      },
      required: ['ownerFixedHours', 'variablePct', 'streams', 'perSale', 'fixed', 'staffing', 'exit'],
    },
    template: {
      type: 'object',
      properties: {
        land_acres: { type: 'number' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              label: { type: 'string' },
              qty: { type: 'number' },
              qtyFrom: { type: 'string', description: 'stream key whose unit count sets the quantity' },
              usd: tri,
              scale: { type: 'string', enum: ['build', 'equipment', 'none'] },
              applies: { type: 'string', enum: ['own', 'lease', 'both'] },
              leaseMonths: { type: 'number', description: 'only for a lease deposit item; no usd' },
            },
            required: ['key', 'label', 'applies'],
          },
        },
      },
      required: ['land_acres', 'items'],
    },
    sources: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'structures', 'revenue_units', 'price_model', 'staffing', 'competitor_terms', 'risk_tags', 'model', 'template', 'sources'],
};

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
  const hits = [
    ...(await search(run, `${niche.name} prices per night packages`, 6)),
    ...(await search(run, `how much does it cost to build ${niche.name} startup cost`, 6)),
  ];
  const reference = must(await db().from('niches').select('card').eq('slug', 'dark-retreat').maybeSingle(), 'reference card');
  const draft = await ask<Record<string, unknown> & { model: NicheModelSpec; template: CostTemplate; risk_tags: string[] }>({
    run,
    model: models.judgment,
    system:
      'You design unit economics for small wellness businesses tied to land or a structure, for a solo owner-operator with $100-150k. Use only evidence in the material given plus conservative industry norms; prefer wide ranges to false precision. All money in USD at a rural western North Carolina baseline.',
    prompt: [
      `Niche: ${niche.name}${niche.card?.description ? ` — ${niche.card.description}` : ''}`,
      `Known operating examples:\n${examples.map((e) => `- ${e.name} (${e.locality}, ${e.country}) ${e.url}: ${clip(e.description ?? '', 300)} prices=${JSON.stringify(e.prices)}`).join('\n') || '(none)'}`,
      `Search results:\n${hits.map((h) => `- ${h.url}\n  ${h.title}: ${clip(h.snippet, 400)}`).join('\n')}`,
      `Reference card for a different niche, to show the expected shape and scale:\n${clip(JSON.stringify(reference?.card?.model ?? {}), 3500)}`,
      'Draft the card. Streams with one unit and one sale a month are flat monthly revenue lines. Template items: build-scaled for construction, equipment-scaled for kit; include a lease deposit item (leaseMonths) and items marked own/lease where they differ. List the URLs you relied on in sources.',
    ].join('\n\n'),
    tool: { name: 'niche_card', description: 'The drafted niche card', schema: CARD_SCHEMA },
    maxTokens: 6000,
  });

  const problems = smokeTest(draft.model, draft.template);
  const { model, template, risk_tags, ...rest } = draft;
  const card = { ...(niche.card ?? {}), ...rest, model: { ...model, basis: 'AI draft from examples and search results; review before approving.' }, drafted_by_run: run.id, smoke_test: problems };
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
      : `${niche.name}: card and cost template drafted from ${examples.length} examples. Approve to include it in fit screens.`,
    payload: { risk_tags, streams: model.streams?.map((s) => s.label), sources: rest.sources },
  });
  return { niche: niche.slug, ok: problems.length === 0, problems };
}

async function brainstorm(run: Run, models: Models) {
  const queries = [
    'unusual wellness retreat concepts rural property',
    'new types of wellness tourism on farmland',
    'land-based wellness business ideas small acreage',
    'experiential wellness lodging trend 2026',
  ];
  const hits = (await Promise.all(queries.map((q) => search(run, q, 8)))).flat();
  const known = must(await db().from('niches').select('slug,name'), 'niches');
  const out = await ask<{ ideas: { name: string; description: string; example_url: string }[] }>({
    run,
    model: models.judgment,
    system: 'You find distinct wellness business concepts that need land or a dedicated structure and that already operate somewhere. Skip anything in the known list, anything purely urban, and anything needing a medical licence.',
    prompt: `Known niches: ${known.map((k) => k.name).join('; ')}\n\nSearch results:\n${hits.map((h) => `- ${h.url}\n  ${h.title}: ${clip(h.snippet, 300)}`).join('\n')}`,
    tool: {
      name: 'ideas',
      description: 'New niche ideas, each backed by a result URL',
      schema: {
        type: 'object',
        properties: { ideas: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, example_url: { type: 'string' } }, required: ['name', 'description', 'example_url'] } } },
        required: ['ideas'],
      },
    },
    maxTokens: 2500,
  });
  const urls = new Set(hits.map((h) => h.url));
  let added = 0;
  for (const idea of out.ideas.filter((i) => urls.has(i.example_url))) {
    const [match] = must(await db().rpc('match_niches', { q: idea.name, min_similarity: 0.35, max_rows: 1 }), 'match');
    if (match) continue;
    const slug = idea.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    const { error } = await db().from('niches').insert({ slug, name: idea.name, family: 'brainstorm', status: 'proposed', card: { description: idea.description, discovered_from: idea.example_url } });
    if (!error) added++;
  }
  return { ideas: out.ideas.length, added };
}

export async function run(body: Record<string, unknown>) {
  const budgets = await getSetting<Budgets>('budgets');
  const models = await getSetting<Models>('models');
  const th = await getSetting<Thresholds>('thresholds');
  return withRun('niche_discovery', { tokenBudget: budgets.niche_discovery_tokens, searchBudget: 30, subjectId: body.niche_id as string | undefined, input: body }, async (run) => {
    if (body.mode === 'brainstorm') return await brainstorm(run, models);
    let ids: string[];
    if (body.niche_id) ids = [String(body.niche_id)];
    else {
      // Proposed niches without a model card, with enough real examples, strongest signal first.
      const rows = must(await db().from('niches').select('id,card,signal_score,example_businesses(count)').eq('status', 'proposed').order('signal_score', { ascending: false }).limit(20), 'proposed');
      ids = rows
        // deno-lint-ignore no-explicit-any
        .filter((r: any) => !r.card?.model && (r.example_businesses?.[0]?.count ?? 0) >= th.min_examples_for_niche)
        .slice(0, Number(body.limit ?? 3))
        .map((r) => r.id);
    }
    const drafted: unknown[] = [];
    for (const id of ids) drafted.push(await draftNiche(run, models, id));
    return { drafted };
  });
}
