// Niche scout agent (brainstorm): explores angles of its own choosing, finds
// real operating examples, and proposes new kinds of business. Each proposal
// passes code checks (quotes on the page, two separate sites, not a duplicate,
// fits the owner's capital and exclusions) and then an independent critic
// before it is added to the library for the owner to review.
import { ToolError, type AgentContext, type AgentDef, type AgentTool } from '../agent.ts';
import { confirmQuote, fetchPage, webSearch } from '../agent-tools.ts';
import { db, defaultProfile, must } from '../db.ts';
import { ask, clip } from '../llm.ts';
import { displayName, intakeProblems } from '../niche-intake.ts';

type Params = Record<string, unknown> & { target?: number };
type Ctx = AgentContext<Params>;

interface Proposal {
  name: string;
  aliases: string[];
  description: string;
  how_it_makes_money: string;
  why_now: string;
  structures: string;
  example_businesses: { name: string; url: string; quote: string; locality: string; country: string }[];
  est_startup_usd: { low: number; high: number };
  solo_operable: boolean;
  needs_land_or_structure: boolean;
  risk_tags: string[];
}

const slugify = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

async function library() {
  return must(await db().from('niches').select('slug,name,aliases,family,status,card'), 'library') as {
    slug: string; name: string; aliases: string[]; family: string; status: string; card: Record<string, unknown>;
  }[];
}

const listLibrary: AgentTool<Params> = {
  name: 'list_library',
  description: 'Every kind of business already in the library (name, aliases, status, one-line description), including ones the owner rejected.',
  input_schema: { type: 'object', properties: {} },
  async run() {
    return (await library()).map((n) => ({
      name: n.name,
      aliases: n.aliases,
      status: n.status === 'approved' ? 'in use' : n.status === 'rejected' ? 'rejected by owner' : 'proposed',
      about: clip(String(n.card?.summary ?? n.card?.description ?? ''), 160),
    }));
  },
};

const checkDuplicate: AgentTool<Params> = {
  name: 'check_duplicate',
  description: 'The closest existing kinds of business to a name (with similarity 0-1). Above about 0.5 it is probably the same thing.',
  input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  async run(input: { name: string }) {
    const rows = must(await db().rpc('match_niches', { q: String(input.name), min_similarity: 0.25, max_rows: 5 }), 'match');
    return rows.map((r: { name: string; similarity: number; status: string }) => ({ name: r.name, similarity: Math.round(r.similarity * 100) / 100, status: r.status }));
  },
};

const proposeNiche: AgentTool<Params> = {
  name: 'propose_niche',
  description:
    'Propose a new kind of business. Code checks the examples (quotes must be on their pages, at least two different websites), duplicates, capital and exclusions; then an independent critic decides. The reply says accepted or why not.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Plain words, e.g. "Riverside barrel-sauna camp"' },
      aliases: { type: 'array', items: { type: 'string' }, description: 'Other names, including in Spanish' },
      description: { type: 'string', description: 'Two or three sentences: what the guest gets and how it works' },
      how_it_makes_money: { type: 'string' },
      why_now: { type: 'string' },
      structures: { type: 'string', description: 'What has to be built or adapted' },
      example_businesses: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, url: { type: 'string' }, quote: { type: 'string', description: 'Exact words from its page showing what it sells' }, locality: { type: 'string' }, country: { type: 'string' } },
          required: ['name', 'url', 'quote', 'locality', 'country'],
        },
      },
      est_startup_usd: { type: 'object', properties: { low: { type: 'number' }, high: { type: 'number' } }, required: ['low', 'high'] },
      solo_operable: { type: 'boolean' },
      needs_land_or_structure: { type: 'boolean' },
      risk_tags: { type: 'array', items: { type: 'string' }, description: 'e.g. psychedelic, medical_license, water_rights, lodging, food_service' },
    },
    required: ['name', 'aliases', 'description', 'how_it_makes_money', 'why_now', 'structures', 'example_businesses', 'est_startup_usd', 'solo_operable', 'needs_land_or_structure', 'risk_tags'],
  },
  async run(input: Proposal, c) {
    const accepted = ((c.scratch.accepted ??= []) as string[]);
    const target = Number(c.params.target ?? c.settings.max_proposals);
    if (accepted.length >= target) return `You already have ${accepted.length} accepted proposals (the target). Call finish.`;
    const name = displayName(String(input.name ?? ''));
    // 1. Examples must be real: quotes found on pages this session has seen.
    const confirmed: Proposal['example_businesses'] = [];
    const rejectedExamples: string[] = [];
    for (const ex of (input.example_businesses ?? []).slice(0, 6)) {
      try {
        if (await confirmQuote(c as unknown as AgentContext, ex.url, ex.quote)) confirmed.push(ex);
        else rejectedExamples.push(`${ex.name}: quote not on the page`);
      } catch (e) {
        rejectedExamples.push(`${ex.name}: ${(e as Error).message}`);
      }
    }
    // 2. Code rules: plain name, land/structure, solo, two sites, capital, exclusions.
    const profile = await defaultProfile();
    const problems = intakeProblems(
      { ...input, name, confirmedExamples: confirmed },
      { capital_max: Number(profile.params?.capital_usd?.max ?? 150000), excluded_tags: profile.params?.excluded_niche_tags ?? [] },
    );
    // 3. Not a duplicate of something in the library.
    const [dupe] = must(await db().rpc('match_niches', { q: name, min_similarity: 0.5, max_rows: 1 }), 'match');
    if (dupe) problems.push(`Too close to "${dupe.name}" already in the library.`);
    const log = ((c.scratch.proposals ??= []) as unknown[]);
    if (problems.length) {
      log.push({ name, verdict: 'rejected_by_rules', problems });
      throw new ToolError(`Not accepted: ${problems.join(' ')}${rejectedExamples.length ? ` Examples not confirmed: ${rejectedExamples.join('; ')}.` : ''}`);
    }
    // 4. Independent critic (a different, stronger model that did not do the research).
    const lib = await library();
    const critic = await ask<{ novelty: number; fit: number; evidence: number; verdict: 'accept' | 'reject'; reason: string }>({
      run: c.run,
      model: c.models.verification,
      system:
        'You review proposed new kinds of wellness business for a library. You did not research them. Accept only proposals that are genuinely distinct from everything in the library, have real operating examples, and suit a solo owner with $100-150k who wants land or a dedicated structure. Be strict about duplicates under new names and about generic ideas; do not invent problems.',
      prompt: [
        `Proposal: ${name}\n${input.description}\nMoney: ${input.how_it_makes_money}\nWhy now: ${input.why_now}\nStructures: ${input.structures}\nStartup estimate: $${input.est_startup_usd.low}-$${input.est_startup_usd.high}`,
        `Confirmed examples:\n${confirmed.map((e) => `- ${e.name} (${e.locality}, ${e.country}) ${e.url}: "${e.quote}"`).join('\n')}`,
        `Library (${lib.length}):\n${lib.map((n) => `- ${n.name}${n.aliases?.length ? ` (${n.aliases.slice(0, 4).join(', ')})` : ''}`).join('\n')}`,
        'Score novelty, fit for the owner and strength of evidence 0-10, then accept or reject with a one-sentence reason.',
      ].join('\n\n'),
      tool: {
        name: 'review',
        description: 'Critic review',
        schema: {
          type: 'object',
          properties: {
            novelty: { type: 'number' },
            fit: { type: 'number' },
            evidence: { type: 'number' },
            verdict: { type: 'string', enum: ['accept', 'reject'] },
            reason: { type: 'string' },
          },
          required: ['novelty', 'fit', 'evidence', 'verdict', 'reason'],
        },
      },
      maxTokens: 1500,
    });
    if (critic.verdict !== 'accept') {
      log.push({ name, verdict: 'rejected_by_critic', critic });
      throw new ToolError(`The critic rejected it (novelty ${critic.novelty}, fit ${critic.fit}, evidence ${critic.evidence}): ${critic.reason}`);
    }
    // 5. Add it, with its examples, for the owner to review.
    const slug = slugify(name);
    const { data: row, error } = await db()
      .from('niches')
      .insert({
        slug,
        name,
        family: 'brainstorm',
        aliases: (input.aliases ?? []).slice(0, 8),
        status: 'proposed',
        risk_tags: input.risk_tags ?? [],
        card: {
          description: input.description,
          how_it_makes_money: input.how_it_makes_money,
          why_interesting: input.why_now,
          structures: input.structures,
          est_startup_usd: input.est_startup_usd,
          critic: { ...critic, model: c.models.verification },
          discovered_by: { agent: 'niche-scout', session_id: c.sessionId, run_id: c.run.id },
          discovered_from: confirmed[0]?.url,
        },
      })
      .select('id')
      .single();
    if (error) throw new ToolError(`Could not save it: ${error.message}`);
    for (const ex of confirmed) {
      const fp = must(await db().rpc('business_fingerprint', { name: ex.name, locality: ex.locality, country: ex.country }), 'fingerprint') as string;
      const [seen] = must(await db().rpc('match_examples', { q: fp, min_similarity: 0.6, max_rows: 1 }), 'match');
      if (!seen) await db().from('example_businesses').insert({ niche_id: row.id, name: ex.name, locality: ex.locality, country: ex.country, url: ex.url, description: ex.quote, fingerprint: fp, status: 'operating' });
    }
    await db().from('review_queue').insert({
      item_type: 'niche',
      item_id: row.id,
      summary: `${name}: new kind of business found by the niche scout (${confirmed.length} operating examples; critic: novelty ${critic.novelty}, fit ${critic.fit}).`,
      payload: { critic, examples: confirmed.map((e) => e.url) },
    });
    accepted.push(name);
    log.push({ name, verdict: 'accepted', critic });
    return { accepted: name, total_accepted: accepted.length, target };
  },
};

export const nicheScout: AgentDef<Params> = {
  name: 'niche-scout',
  runKind: 'niche_discovery',
  model: (m) => m.judgment,
  thinking: true,
  tools: () => [listLibrary, webSearch, fetchPage, checkDuplicate, proposeNiche],
  async task(ctx) {
    const target = Number(ctx.params.target ?? ctx.settings.max_proposals);
    const recent = must(
      await db().from('agent_sessions').select('result').eq('agent', 'niche-scout').eq('status', 'finished').order('created_at', { ascending: false }).limit(3),
      'recent sessions',
    ) as { result: { angles_tried?: string[] } | null }[];
    const tried = recent.flatMap((r) => r.result?.angles_tried ?? []);
    return [
      `Find up to ${target} new kinds of land- or structure-based wellness business for the library.`,
      tried.length ? `Angles used in recent runs (try different ones first): ${[...new Set(tried)].slice(0, 15).join('; ')}.` : '',
      'Start with list_library, plan your angles, then search, read and propose.',
    ].filter(Boolean).join('\n');
  },
  finish: {
    description: 'Finish the brainstorm.',
    schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        angles_tried: { type: 'array', items: { type: 'string' } },
      },
      required: ['summary', 'angles_tried'],
    },
  },
  async onFinish(ctx) {
    if (((ctx.scratch.accepted ?? []) as string[]).length) await db().rpc('refresh_niche_signals');
    return { accepted: ctx.scratch.accepted ?? [], proposals: ctx.scratch.proposals ?? [] };
  },
};
