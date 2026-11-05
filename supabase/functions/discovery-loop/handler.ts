// The continuous loop: search for wellness businesses tied to land or a
// structure that already operate, de-duplicate against everything seen, and
// file each as a known niche example, a change, or a new niche for review.
//   mode=daily  → a rotating slice of concept queries
//   mode=weekly → every concept query plus businesses-for-sale queries
import { db, getSetting, must, type Budgets, type Models } from '../_shared/db.ts';
import { ask } from '../_shared/llm.ts';
import { withRun, type Run } from '../_shared/runs.ts';
import { search, type SearchHit } from '../_shared/search.ts';

interface Discovery {
  regions: string[];
  concept_queries: string[];
  sale_queries: string[];
  max_results_per_query: number;
}

interface Extracted {
  index: number;
  relevant: boolean;
  name: string;
  locality: string;
  region: string;
  country: string;
  niche_guess: string;
  description: string;
  status: 'operating' | 'closed' | 'for_sale' | 'planned' | 'unknown';
  prices: { item: string; amount: number; currency: string }[];
  land_or_structure: boolean;
}

function slugify(s: string) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

async function classify(run: Run, model: string, hits: SearchHit[]): Promise<Extracted[]> {
  const out = await ask<{ items: Extracted[] }>({
    run,
    model,
    system:
      'You read search results and identify real wellness businesses that depend on land or a purpose-built structure (retreats, bathhouses, saunas, glamping, hot springs, farms, dark retreats, float centres, venues). Ignore listicles unless they name one specific business, ignore news about chains in cities, and never invent details.',
    prompt: `For each result, say whether it describes one specific relevant business, and extract its details. Use a short generic niche label (e.g. "wood-fired sauna on farm", "darkness retreat").\n\n${hits
      .map((h, i) => `[${i}] ${h.url}\n${h.title}\n${h.snippet}`)
      .join('\n\n')}`,
    tool: {
      name: 'businesses',
      description: 'Classify each search result',
      schema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer' },
                relevant: { type: 'boolean' },
                name: { type: 'string' },
                locality: { type: 'string' },
                region: { type: 'string' },
                country: { type: 'string' },
                niche_guess: { type: 'string' },
                description: { type: 'string' },
                status: { type: 'string', enum: ['operating', 'closed', 'for_sale', 'planned', 'unknown'] },
                prices: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, amount: { type: 'number' }, currency: { type: 'string' } }, required: ['item', 'amount', 'currency'] } },
                land_or_structure: { type: 'boolean' },
              },
              required: ['index', 'relevant', 'name', 'locality', 'region', 'country', 'niche_guess', 'description', 'status', 'prices', 'land_or_structure'],
            },
          },
        },
        required: ['items'],
      },
    },
    maxTokens: 6000,
  });
  return out.items ?? [];
}

export async function run(body: Record<string, unknown>) {
  const mode = body.mode === 'weekly' ? 'weekly' : 'daily';
  const cfg = await getSetting<Discovery>('discovery');
  const budgets = await getSetting<Budgets>('budgets');
  const models = await getSetting<Models>('models');
  const tokenBudget = mode === 'weekly' ? budgets.discovery_weekly_tokens : budgets.discovery_daily_tokens;
  const searchBudget = mode === 'weekly' ? budgets.search_calls_weekly : budgets.search_calls_daily;

  return withRun(mode === 'weekly' ? 'discovery_weekly' : 'discovery_daily', { tokenBudget, searchBudget, input: body }, async (run) => {
    // Daily: rotate through the concept queries, paired with a rotating region.
    const day = Math.floor(Date.now() / 86_400_000);
    let queries: string[];
    if (mode === 'weekly') {
      // The weekly sweep is split into pages so each call fits the function time limit.
      const pages = Math.max(1, Number(body.pages ?? 1));
      const page = Number(body.page ?? 0) % pages;
      queries = [...cfg.concept_queries, ...cfg.sale_queries].filter((_, i) => i % pages === page);
    } else {
      const per = 5;
      queries = Array.from({ length: per }, (_, i) => {
        const q = cfg.concept_queries[(day * per + i) % cfg.concept_queries.length];
        const r = cfg.regions[(day + i) % cfg.regions.length];
        return `${q} ${r}`;
      });
    }
    queries = queries.slice(0, searchBudget);

    const hits = new Map<string, SearchHit>();
    for (const q of queries) for (const h of await search(run, q, cfg.max_results_per_query)) if (h.url) hits.set(h.url, h);
    const seen = new Set(
      must(await db().from('seen_items').select('url').in('url', [...hits.keys()]), 'seen urls').map((r) => r.url),
    );
    const fresh = [...hits.values()].filter((h) => !seen.has(h.url));

    const tally = { new_niche: 0, new_example: 0, change: 0, seen: 0, irrelevant: 0 };
    for (let i = 0; i < fresh.length; i += 15) {
      const batch = fresh.slice(i, i + 15);
      const items = await classify(run, models.extraction, batch);
      for (let j = 0; j < batch.length; j++) {
        const hit = batch[j];
        const x = items.find((it) => it.index === j);
        let classification: keyof typeof tally = 'irrelevant';
        let exampleId: string | null = null;
        let nicheId: string | null = null;

        if (x?.relevant && x.land_or_structure && x.name) {
          const fp = must(await db().rpc('business_fingerprint', { name: x.name, locality: x.locality, country: x.country }), 'fingerprint') as string;
          const [dupe] = must(await db().rpc('match_examples', { q: fp, min_similarity: 0.6, max_rows: 1 }), 'match examples') as { id: string; niche_id: string }[];
          if (dupe) {
            const prev = must(await db().from('example_businesses').select('status').eq('id', dupe.id).single(), 'example');
            await db().from('example_businesses').update({ last_seen_at: new Date().toISOString(), status: x.status }).eq('id', dupe.id);
            classification = prev.status !== x.status ? 'change' : 'seen';
            exampleId = dupe.id;
            nicheId = dupe.niche_id;
          } else {
            const [match] = must(await db().rpc('match_niches', { q: x.niche_guess, min_similarity: 0.35, max_rows: 1 }), 'match niches') as { id: string; status: string }[];
            if (match) {
              nicheId = match.id;
              classification = 'new_example';
            } else {
              const slug = slugify(x.niche_guess) || slugify(x.name);
              const existing = must(await db().from('niches').select('id').eq('slug', slug).maybeSingle(), 'niche slug');
              if (existing) {
                nicheId = existing.id;
                classification = 'new_example';
              } else {
                const created = must(
                  await db()
                    .from('niches')
                    .insert({ slug, name: x.niche_guess, family: 'discovered', aliases: [], status: 'proposed', card: { discovered_from: hit.url, description: x.description }, risk_tags: [] })
                    .select('id')
                    .single(),
                  'new niche',
                );
                nicheId = created.id;
                classification = 'new_niche';
                await db().from('review_queue').insert({
                  item_type: 'niche',
                  item_id: created.id,
                  summary: `New niche spotted: ${x.niche_guess} (e.g. ${x.name}, ${x.locality || x.region}, ${x.country})`,
                  payload: { url: hit.url, description: x.description },
                });
              }
            }
            const ex = must(
              await db()
                .from('example_businesses')
                .insert({
                  niche_id: nicheId,
                  name: x.name,
                  country: x.country,
                  region: x.region,
                  locality: x.locality,
                  url: hit.url,
                  description: x.description,
                  prices: { items: x.prices },
                  status: x.status,
                  fingerprint: fp,
                })
                .select('id')
                .single(),
              'new example',
            );
            exampleId = ex.id;
          }
        }
        tally[classification]++;
        await db().from('seen_items').upsert(
          { url: hit.url, classification, example_id: exampleId, niche_id: nicheId, raw: { title: hit.title, snippet: hit.snippet, extracted: x ?? null }, run_id: run.id },
          { onConflict: 'url' },
        );
      }
    }
    await db().rpc('refresh_niche_signals');
    return { mode, queries: queries.length, results: hits.size, fresh: fresh.length, ...tally };
  });
}
