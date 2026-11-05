// Places: judge how well each place matches the owner's own description, and
// suggest new places that might. The judgement is qualitative (AI); the money
// side of a place still comes only from ledger values through the engine.
import { db, defaultProfile, getSetting, must, type Models } from './db.ts';
import { loadLedger, type LocationRow } from './ledger.ts';
import { ask, clip } from './llm.ts';
import type { Run } from './runs.ts';
import { search } from './search.ts';

const FACT_KEYS: [string, string][] = [
  ['lease.finca_monthly_usd', 'rural house lease, USD/month'],
  ['land.price_per_acre_usd', 'land, USD/acre'],
  ['labor.monthly_wage_usd', 'one full-time worker, USD/month'],
  ['demand.population_40min', 'population within ~40 min'],
  ['safety.us_advisory_level', 'US travel advisory level'],
  ['visa.route_for_owner', 'owner residency route'],
];

export function wishesOf(params: Record<string, unknown>): string {
  return String(params.location_wishes ?? '').trim();
}

/** Score every active place (or one) against the owner's description. */
export async function scorePlaces(run: Run, opts: { locationId?: string } = {}) {
  const profile = await defaultProfile();
  const wishes = wishesOf(profile.params);
  if (!wishes) return { scored: 0, skipped: 'Add a description of what you want in a place first.' };
  const models = await getSetting<Models>('models');
  let q = db().from('locations').select('*').eq('level', 'micro_area').or('active.eq.true,origin.eq.ai_suggested');
  if (opts.locationId) q = q.eq('id', opts.locationId);
  const places = must(await q, 'places') as LocationRow[];
  if (!places.length) return { scored: 0 };

  const facts = await Promise.all(
    places.map(async (p) => {
      const ledger = await loadLedger(p);
      const known = FACT_KEYS.map(([k, label]) => {
        const v = ledger.get(k);
        return v ? `${label}: ${v.value_num ?? v.value_text}` : null;
      }).filter(Boolean);
      return `- ${p.slug}: ${p.name} (${p.country_code})${p.favorite ? ' [owner favourite]' : ''}${p.notes ? ` — owner notes: ${clip(p.notes, 300)}` : ''}\n  ${known.join('; ') || 'no data yet'}`;
    }),
  );

  const results: Record<string, { score: number; summary: string; pros: string[]; cons: string[]; unknowns: string[] }> = {};
  // Judge in batches so each call stays small and comparisons stay consistent.
  for (let i = 0; i < facts.length; i += 12) {
    const out = await ask<{ places: { slug: string; score: number; summary: string; pros: string[]; cons: string[]; unknowns: string[] }[] }>({
      run,
      model: models.judgment,
      system:
        'You help someone choose where to live and run a small land-based wellness business. Judge each place against their own description. Be concrete and honest; use your general knowledge of the place (climate, landscape, access, airports, safety, cost, expat life) plus the facts given. Score 0-10 where 10 is an excellent match to the description. Say what you are unsure of.',
      prompt: `What they want in a place, in their words:\n"""${clip(wishes, 3000)}"""\n\nOwner context: ${clip(JSON.stringify({ visa: profile.params.visa, climate_preference: profile.params.climate_preference, live_on_site: profile.params.live_on_site }), 600)}\n\nPlaces:\n${facts.slice(i, i + 12).join('\n')}`,
      tool: {
        name: 'judge_places',
        description: 'Judgement for each place',
        schema: {
          type: 'object',
          properties: {
            places: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  slug: { type: 'string' },
                  score: { type: 'number' },
                  summary: { type: 'string', description: 'One sentence: how well it matches and why' },
                  pros: { type: 'array', items: { type: 'string' } },
                  cons: { type: 'array', items: { type: 'string' } },
                  unknowns: { type: 'array', items: { type: 'string' } },
                },
                required: ['slug', 'score', 'summary', 'pros', 'cons', 'unknowns'],
              },
            },
          },
          required: ['places'],
        },
      },
      maxTokens: 6000,
    });
    for (const p of out.places) results[p.slug] = p;
  }

  const now = new Date().toISOString();
  let scored = 0;
  for (const p of places) {
    const r = results[p.slug];
    if (!r) continue;
    const score = Math.max(0, Math.min(10, Math.round(r.score * 10) / 10));
    await db().from('locations').update({ fit: { score, summary: r.summary, pros: r.pros, cons: r.cons, unknowns: r.unknowns, scored_at: now, run_id: run.id } }).eq('id', p.id);
    scored++;
  }
  return { scored };
}

function slugify(s: string) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}

/** Make sure a country row exists and return it. */
export async function ensureCountry(code: string, name: string) {
  const cc = code.toUpperCase().slice(0, 2);
  const existing = must(await db().from('locations').select('*').eq('level', 'country').eq('country_code', cc).maybeSingle(), 'country');
  if (existing) return existing;
  return must(
    await db().from('locations').insert({ slug: cc.toLowerCase(), name, country_code: cc, level: 'country', active: true, origin: 'user' }).select('*').single(),
    'new country',
  );
}

/** Suggest new places that match the owner's description and aren't on the list yet. */
/** Used until the owner writes their own description of what they want in a place. */
const DEFAULT_WISHES =
  'A rural or small-town area with land suitable for a small land-based wellness business (retreat, bathhouse, glamping or similar): pleasant climate, natural beauty, within about two hours of an international airport, reasonably safe, affordable land or rent, and visitors or nearby city residents who would pay for wellness.';

/** A place counts as in play when it is on the owner's list or an undismissed suggestion. */
export const inPlay = (l: { active: boolean; origin?: string | null; fit?: unknown }) =>
  l.active || (l.origin === 'ai_suggested' && !(l.fit as { dismissed?: boolean } | null)?.dismissed);

/**
 * The country with the fewest places in play, among the countries already on
 * the list, so suggestions even out the spread.
 */
export async function leastCoveredCountry(): Promise<{ code: string; name: string } | null> {
  const all = must(await db().from('locations').select('country_code,name,level,active,origin,fit'), 'places');
  const countries = all.filter((l: { level: string; active: boolean }) => l.level === 'country' && l.active);
  if (!countries.length) return null;
  const count = (code: string) => all.filter((l: { level: string; country_code: string } & Parameters<typeof inPlay>[0]) => l.level === 'micro_area' && l.country_code === code && inPlay(l)).length;
  const c = [...countries].sort((a: { country_code: string }, b: { country_code: string }) => count(a.country_code) - count(b.country_code))[0];
  return { code: c.country_code, name: c.name };
}

export async function suggestPlaces(run: Run, count = 5, opts: { country?: { code: string; name: string } } = {}) {
  const profile = await defaultProfile();
  const wishes = wishesOf(profile.params) || DEFAULT_WISHES;
  const models = await getSetting<Models>('models');
  const known = must(await db().from('locations').select('name,country_code').eq('level', 'micro_area'), 'known places');
  const where = opts.country ? `\n\nOnly suggest places in ${opts.country.name} (${opts.country.code}).` : '';

  const plan = await ask<{ queries: string[] }>({
    run,
    model: models.judgment,
    system: 'You write web search queries that find specific small towns or rural areas matching a description.',
    prompt: `Description:\n"""${clip(wishes, 2000)}"""\n\nAlready on their list: ${known.map((k) => `${k.name} (${k.country_code})`).join('; ')}\n\nWrite 4 short, varied search queries (some in Spanish if Latin America fits) to find other places worth considering.${where}`,
    tool: { name: 'queries', description: 'Search queries', schema: { type: 'object', properties: { queries: { type: 'array', items: { type: 'string' } } }, required: ['queries'] } },
    maxTokens: 600,
  });
  const hits = (await Promise.all(plan.queries.slice(0, 4).map((q) => search(run, q, 6)))).flat();
  const seen = new Set<string>();
  const unique = hits.filter((h) => !seen.has(h.url) && seen.add(h.url));

  const out = await ask<{ places: { name: string; region: string; country_code: string; country_name: string; why: string; watch_outs: string; score: number; source_index: number }[] }>({
    run,
    model: models.judgment,
    system:
      'You suggest specific towns or rural areas (not whole countries or big cities) where someone could live and run a small land-based wellness business. Only suggest places that the search results discuss, and that are not already on their list.',
    prompt: `What they want:\n"""${clip(wishes, 2000)}"""\n\nAlready on their list (do not repeat): ${known.map((k) => k.name).join('; ')}\n\nSearch results:\n${unique.map((h, i) => `[${i}] ${h.url}\n${h.title}: ${clip(h.snippet, 350)}`).join('\n\n')}\n\nSuggest up to ${count} places.${where}`,
    tool: {
      name: 'places',
      description: 'Suggested places',
      schema: {
        type: 'object',
        properties: {
          places: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Town or area name' },
                region: { type: 'string', description: 'State, department or province' },
                country_code: { type: 'string', description: 'ISO 3166 alpha-2' },
                country_name: { type: 'string' },
                why: { type: 'string' },
                watch_outs: { type: 'string' },
                score: { type: 'number', description: '0-10 match to the description' },
                source_index: { type: 'integer' },
              },
              required: ['name', 'region', 'country_code', 'country_name', 'why', 'watch_outs', 'score', 'source_index'],
            },
          },
        },
        required: ['places'],
      },
    },
    maxTokens: 3000,
  });

  const knownNames = new Set(known.map((k) => k.name.toLowerCase()));
  let suggested = 0;
  for (const p of out.places.slice(0, count)) {
    const source = unique[p.source_index];
    if (!source || knownNames.has(p.name.toLowerCase()) || !/^[A-Za-z]{2}$/.test(p.country_code)) continue;
    if (opts.country && p.country_code.toUpperCase() !== opts.country.code) continue;
    const country = await ensureCountry(p.country_code, p.country_name);
    const slug = `${p.country_code.toLowerCase()}-${slugify(`${p.region} ${p.name}`)}`;
    const { error } = await db().from('locations').insert({
      slug,
      name: `${p.name}, ${p.region}`,
      country_code: p.country_code.toUpperCase(),
      level: 'micro_area',
      parent_id: country.id,
      active: false,
      origin: 'ai_suggested',
      notes: `${p.why}\nWatch out: ${p.watch_outs}\nSource: ${source.url}`,
      fit: { score: Math.max(0, Math.min(10, p.score)), summary: p.why, cons: [p.watch_outs], scored_at: new Date().toISOString(), run_id: run.id },
    });
    if (!error) {
      suggested++;
      // Screen it against every niche straight away; the daily refresh researches its costs.
      const { data: row } = await db().from('locations').select('id').eq('slug', slug).maybeSingle();
      if (row?.id) await db().rpc('queue_fit_screen', { p_niche: null, p_location: row.id });
    }
  }
  return { suggested, country: opts.country?.code ?? 'any' };
}
