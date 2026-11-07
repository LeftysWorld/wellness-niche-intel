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
import { DESCRIBE_SCHEMA, ECONOMICS_SCHEMA, obj, str, strs, toModelAndTemplate, type Describe, type Economics } from '../_shared/niche-schemas.ts';
import { search } from '../_shared/search.ts';

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
      const r = analyze(b.model, { simulations: 100, seed: 7, sensitivity: false });
      const vals = [r.year1.profit.p50, r.year3.profit.p50, r.startup.total.p50];
      if (vals.some((v) => !Number.isFinite(v))) problems.push(`${tenure}: non-numeric result`);
      if (r.startup.total.p50 <= 0) problems.push(`${tenure}: zero startup cost`);
      if (r.year3.revenue.p50 <= 0) problems.push(`${tenure}: no revenue`);
    } catch (e) {
      problems.push(`${tenure}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return problems;
}

/** A design from the Builder: the owner's requirements, extra searches, and an optional niche to build on. */
export interface DesignBrief {
  text: string;
  queries: string[];
  baseNicheId?: string | null;
}

export async function draftNiche(run: Run, models: Models, nicheId: string, design?: DesignBrief) {
  const niche = must(await db().from('niches').select('*').eq('id', nicheId).single(), 'niche');
  const examples = must(await db().from('example_businesses').select('name,locality,country,url,description,prices').eq('niche_id', design?.baseNicheId ?? nicheId).limit(8), 'examples');
  const seen = new Set<string>();
  const hits = [
    ...(await search(run, `${niche.name} retreat business`, 8)),
    ...(await search(run, `${niche.name} prices per night packages`, 6)),
    ...(await search(run, `how much does it cost to build ${niche.name} startup cost`, 6)),
    ...(design ? (await Promise.all(design.queries.map((q) => search(run, q, 5)))).flat() : []),
  ].filter((h) => !seen.has(h.url) && seen.add(h.url));
  // A design built on an existing niche uses that niche's economics as the reference shape.
  const base = design?.baseNicheId ? must(await db().from('niches').select('name,card').eq('id', design.baseNicheId).maybeSingle(), 'base niche') : null;
  const reference = base?.card?.model ? base : must(await db().from('niches').select('card').eq('slug', 'dark-retreat').maybeSingle(), 'reference card');
  const context = [
    `Niche: ${niche.name}${niche.card?.description ? ` — ${niche.card.description}` : ''}${niche.card?.note ? ` — ${niche.card.note}` : ''}`,
    design ? `The owner designed this business in the Builder. Follow the design exactly: model every offer and facility it lists, with its quantities and any prices given (treat a given price as the owner's intended price and check it against the evidence). Add only what is needed to operate (permits, parking, utilities). Respect the property, money and operations choices.

${design.text}` : '',
    base ? `It builds on the existing niche "${base.name}": ${clip(String(base.card?.summary ?? base.card?.description ?? ''), 600)}` : '',
    `Known operating examples:\n${examples.map((e) => `- ${e.name} (${e.locality}, ${e.country}) ${e.url}: ${clip(e.description ?? '', 300)} prices=${JSON.stringify(e.prices)}`).join('\n') || '(none)'}`,
    `Search results:\n${hits.map((h, i) => `[${i}] ${h.url}\n  ${h.title}: ${clip(h.snippet, 400)}`).join('\n')}`,
  ].join('\n\n');

  // The two calls are independent, so run them side by side.
  const [describe, economics] = await Promise.all([
  ask<Describe>({
    run,
    model: models.judgment,
    system: 'You describe small wellness businesses that need land or a dedicated structure, for someone deciding which to start. Be concrete and plain. Use only what the material supports.',
    prompt: `${context}\n\nDescribe this niche. Under operating_examples list real businesses you can see in the results, citing the [n], and mark matches_definition false for anything only loosely related (e.g. a planetarium is not a sound-healing dome). List the site prerequisites honestly: things that cannot be built anywhere (a natural hot spring) must be listed.`,
    tool: { name: 'niche_description', description: 'A description of the niche', schema: DESCRIBE_SCHEMA },
    maxTokens: 8000,
  }),
  ask<Economics>({
    run,
    model: models.judgment,
    system:
      'You design unit economics for small wellness businesses tied to land or a structure, for a solo owner-operator with $100-150k. Use the evidence given plus conservative industry norms; prefer wide ranges to false precision. All money in USD at a rural western North Carolina baseline.',
    prompt: [
      context,
      `Reference economics for a different niche, to show the expected shape and scale:\n${clip(JSON.stringify(reference?.card?.model ?? {}), 3000)}`,
      'Give the economics. Set openHoursPerMonth to every hour someone has to be on site to serve guests (opening hours, check-ins, sessions), and ownerHoursPerSale only for extra work per sale. Mark each stream local or destination. Do not include rent, lease or land in fixed costs (the place\'s lease is added separately). List paid staff the business would need if the owner did not do the work; the owner runs it solo when the hours fit. ownerFixedHours must include all hours someone has to be on site (open hours, check-ins), not just admin. A stream with one unit and one sale a month is a flat monthly revenue line. wageMultiple is a multiple of one full-time local wage. Include a lease deposit startup item (leaseMonths 2, applies lease) and mark items own/lease where they differ (buildings are "own"; converting a leased house is "lease").',
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
    if (!src || !ex.name || ex.matches_definition === false) continue;
    const fp = must(await db().rpc('business_fingerprint', { name: ex.name, locality: ex.locality, country: ex.country }), 'fingerprint') as string;
    const [dupe] = must(await db().rpc('match_examples', { q: fp, min_similarity: 0.6, max_rows: 1 }), 'match');
    if (dupe) continue;
    const { error } = await db().from('example_businesses').insert({ niche_id: nicheId, name: ex.name, locality: ex.locality, country: ex.country, url: src.url, description: ex.note, fingerprint: fp, status: 'operating' });
    if (!error) examplesAdded++;
  }
  if (examplesAdded) await db().rpc('refresh_niche_signals');
  // An independent check of the draft before it reaches the owner: the stronger
  // model reviews the key assumptions against the same search results.
  const review = await ask<{ verdict: 'pass' | 'flag' | 'fail'; concerns: string[]; key_assumptions: { name: string; value: string; supported: 'yes' | 'partly' | 'no' }[] }>({
    run,
    model: models.verification,
    system: 'You independently check a draft business model for a small wellness business. You did not write it. Be specific; do not invent problems. Judge prices, occupancy, opening hours, build costs and time to open against the evidence and common sense.',
    prompt: [
      `Niche: ${niche.name}. ${describe.summary}`,
      `Draft economics (USD, rural western North Carolina baseline):\n${clip(JSON.stringify({ model, template }), 7000)}`,
      `Evidence (search results):\n${hits.map((h, i) => `[${i}] ${h.title}: ${clip(h.snippet, 250)}`).join('\n')}`,
      'List the 4-6 assumptions that matter most with their values and whether the evidence supports them, then a verdict: pass, flag (owner should look at the concerns), or fail (likely wrong).',
    ].join('\n\n'),
    tool: {
      name: 'niche_review',
      description: 'Independent review of the draft',
      schema: obj({
        verdict: { type: 'string', enum: ['pass', 'flag', 'fail'] },
        concerns: strs,
        key_assumptions: { type: 'array', items: obj({ name: str, value: str, supported: { type: 'string', enum: ['yes', 'partly', 'no'] } }) },
      }),
    },
    maxTokens: 5000,
  });
  const card = {
    ...(niche.card ?? {}),
    ...rest,
    sources: hits.map((h) => ({ url: h.url, title: h.title })),
    model: { ...model, basis: 'AI draft from examples and search results; review before approving.' },
    review: { ...review, model: models.verification, at: new Date().toISOString() },
    drafted_by_run: run.id,
    smoke_test: problems,
  };
  await db().from('niches').update({ card, risk_tags: risk_tags ?? [] }).eq('id', nicheId);
  if (!problems.length) {
    const last = must(await db().from('cost_templates').select('version').eq('niche_id', nicheId).order('version', { ascending: false }).limit(1).maybeSingle(), 'template version');
    await db().from('cost_templates').insert({ niche_id: nicheId, version: (last?.version ?? 0) + 1, template, notes: `Drafted by run ${run.id}` });
    // Screen the new niche in every place right away, so its ideas appear today.
    await db().rpc('queue_fit_screen', { p_niche: nicheId, p_location: null });
  }
  await db().from('review_queue').insert({
    item_type: 'niche',
    item_id: nicheId,
    summary: problems.length
      ? `${niche.name}: draft card failed checks (${problems.join('; ')}). Needs more research.`
      : `${niche.name}: ${rest.unique_angle ?? 'drafted'} (${examples.length + examplesAdded} operating examples; independent check: ${review.verdict}).`,
    payload: { risk_tags, streams: model.streams?.map((s) => s.label), review: review.verdict, concerns: review.concerns },
  });
  return { niche: niche.slug, ok: problems.length === 0, problems, examplesAdded, review: review.verdict };
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
    maxTokens: 5000,
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
