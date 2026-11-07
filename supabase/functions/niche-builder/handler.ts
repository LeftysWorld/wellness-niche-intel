// Niche Builder: turns a design composed of blocks in the Builder tab into a
// researched niche. phase=start (from the app) composes the brief, creates or
// updates the design's niche and starts two background jobs, then returns:
//   phase=draft     — the standard niche write-up, with the design as hard
//                     requirements; the new niche is screened in every place.
//   phase=questions — answers the design's research questions with sources.
import { db, getSetting, must, type Budgets, type Models } from '../_shared/db.ts';
import { HttpError } from '../_shared/http.ts';
import { ask, clip } from '../_shared/llm.ts';
import { withRun, type Run } from '../_shared/runs.ts';
import { search } from '../_shared/search.ts';
import { BLOCK, composeBrief, type BlockInstance } from '../_shared/blocks.ts';
import { draftNiche } from '../niche-discovery/handler.ts';

interface Design {
  id: string;
  name: string;
  blocks: BlockInstance[];
  niche_id: string | null;
  research: Record<string, unknown>;
}

const TENURE_FOR: Record<string, string[] | undefined> = {
  'Buy land and build': ['own'],
  'Rent land and build my own': ['ground'],
  'Lease an existing property': ['lease'],
};

const slugify = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

async function load(id: string) {
  const design = must(await db().from('designs').select('id,name,blocks,niche_id,research').eq('id', id).maybeSingle(), 'design') as Design | null;
  if (!design) throw new HttpError(404, 'No such design');
  const niches = must(await db().from('niches').select('id,name'), 'niches') as { id: string; name: string }[];
  const places = must(await db().from('locations').select('id,name'), 'places') as { id: string; name: string }[];
  const names = { niches: Object.fromEntries(niches.map((n) => [n.id, n.name])), places: Object.fromEntries(places.map((p) => [p.id, p.name])) };
  return { design, brief: composeBrief(design.name, design.blocks ?? [], names) };
}

const save = (id: string, key: string, value: unknown, status?: string) =>
  db().rpc('design_research_set', { p_id: id, p_key: key, p_value: value, p_status: status ?? null });

async function start(id: string) {
  const { design, brief } = await load(id);
  if (!(design.blocks ?? []).some((b) => BLOCK[b.type]?.category === 'offers')) {
    throw new HttpError(400, 'Add at least one offer (what guests pay for) before researching.');
  }
  // The design's own niche: created once, its brief refreshed on every run.
  let nicheId = design.niche_id;
  const card = { description: brief.summary, design_id: design.id, brief: brief.text };
  if (!nicheId) {
    const slug = `design-${slugify(design.name) || 'untitled'}-${design.id.slice(0, 6)}`;
    const row = must(
      await db().from('niches').insert({ slug, name: design.name, family: 'builder', status: 'proposed', favorite: true, card }).select('id').single(),
      'new niche',
    ) as { id: string };
    nicheId = row.id;
  } else {
    const current = must(await db().from('niches').select('card').eq('id', nicheId).single(), 'niche') as { card: Record<string, unknown> };
    await db().from('niches').update({ name: design.name, card: { ...current.card, ...card } }).eq('id', nicheId);
  }
  await db()
    .from('designs')
    .update({ status: 'researching', niche_id: nicheId, research: { brief: brief.text, started_at: new Date().toISOString(), questions: brief.questions } })
    .eq('id', id);
  await db().rpc('queue_agent', { p_name: 'niche-builder', p_body: { design_id: id, phase: 'draft' } });
  if (brief.questions.length) await db().rpc('queue_agent', { p_name: 'niche-builder', p_body: { design_id: id, phase: 'questions' } });
  return {
    started: true,
    niche_id: nicheId,
    questions: brief.questions.length,
    note: 'Research runs in the background and takes a few minutes. Results appear here when it finishes; its ideas then appear on Business ideas.',
  };
}

async function answer(run: Run, models: Models, question: string, briefText: string) {
  const hits = await search(run, question.slice(0, 200), 6);
  if (!hits.length) return { question, answer: 'No search results.', points: [] as { claim: string; url: string; title: string }[] };
  const out = await ask<{ answer: string; points: { claim: string; source_index: number }[] }>({
    run,
    model: models.judgment,
    system: 'You answer research questions for someone designing a small wellness business. Use only the search results; cite each claim with the [n] of its result. Say plainly when the results do not answer the question.',
    prompt: `The business design:\n${clip(briefText, 3000)}\n\nQuestion: ${question}\n\nSearch results:\n${hits.map((h, i) => `[${i}] ${h.url}\n${h.title}: ${clip(h.snippet, 500)}`).join('\n\n')}`,
    tool: {
      name: 'answer',
      description: 'A sourced answer',
      schema: {
        type: 'object',
        properties: {
          answer: { type: 'string', description: 'A short, direct answer in plain language' },
          points: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, source_index: { type: 'integer' } }, required: ['claim', 'source_index'] } },
        },
        required: ['answer', 'points'],
      },
    },
    maxTokens: 2500,
  });
  // Only claims whose source came back in this run's search results.
  const points = out.points.filter((p) => hits[p.source_index]).map((p) => ({ claim: p.claim, url: hits[p.source_index].url, title: hits[p.source_index].title }));
  return { question, answer: out.answer, points };
}

export async function run(body: Record<string, unknown>) {
  const id = String(body.design_id ?? '');
  if (!id) throw new HttpError(400, 'design_id is required');
  const phase = String(body.phase ?? 'start');
  if (phase === 'start') return start(id);

  const budgets = await getSetting<Budgets>('budgets');
  const models = await getSetting<Models>('models');
  const { design, brief } = await load(id);

  if (phase === 'questions') {
    return withRun('niche_builder', { tokenBudget: 60000, searchBudget: 8, subjectId: id, input: body }, async (r) => {
      const answers: Awaited<ReturnType<typeof answer>>[] = [];
      for (const q of brief.questions) answers.push(await answer(r, models, q, brief.text));
      await save(id, 'answers', answers);
      return { answered: answers.length };
    });
  }

  if (phase === 'draft') {
    if (!design.niche_id) throw new HttpError(400, 'Start research from the Builder first');
    const result = await withRun('niche_builder', { tokenBudget: budgets.niche_discovery_tokens, searchBudget: 40, subjectId: id, input: body }, async (r) => {
      await db().from('designs').update({ last_run_id: r.id }).eq('id', id);
      try {
        const drafted = await draftNiche(r, models, design.niche_id!, { text: brief.text, queries: brief.queries, baseNicheId: brief.baseNicheId });
        // The design's property choice limits how its ideas hold the site, then re-screen.
        const choice = String((design.blocks ?? []).find((b) => b.type === 'property')?.params?.choice ?? '');
        const tenures = TENURE_FOR[choice];
        if (drafted.ok) {
          const n = must(await db().from('niches').select('card').eq('id', design.niche_id!).single(), 'niche') as { card: { model?: Record<string, unknown> } };
          if (n.card?.model) {
            const model = { ...n.card.model };
            if (tenures) model.tenures = tenures;
            else delete model.tenures;
            await db().from('niches').update({ card: { ...n.card, model } }).eq('id', design.niche_id!);
            await db().rpc('queue_fit_screen', { p_niche: design.niche_id, p_location: null });
          }
        }
        await save(id, 'draft', { ...drafted, finished_at: new Date().toISOString() }, drafted.ok ? 'ready' : 'failed');
        return drafted;
      } catch (e) {
        await save(id, 'error', (e as Error).message, 'failed');
        throw e;
      }
    });
    if (result.status !== 'succeeded') await save(id, 'error', String((result as { error?: string }).error ?? result.status), 'failed');
    return result;
  }
  throw new HttpError(400, `Unknown phase "${phase}"`);
}
