// Site check: can this place physically and legally host this niche? Each
// niche lists prerequisites (a natural hot spring, 20+ acres, public-use
// permission); the judgement model checks them against every active place.
// "no" removes the idea from rankings with the reason; "unknown" is shown.
import { db, getSetting, must, type Models } from './db.ts';
import { ask, clip } from './llm.ts';
import type { Run } from './runs.ts';

export async function checkSites(run: Run, opts: { nicheId?: string; locationId?: string; force?: boolean } = {}) {
  const models = await getSetting<Models>('models');
  let nq = db().from('niches').select('id,name,card').in('status', ['approved', 'proposed']);
  if (opts.nicheId) nq = nq.eq('id', opts.nicheId);
  // deno-lint-ignore no-explicit-any
  const niches = (must(await nq, 'niches') as any[]).filter((n) => n.card?.model && (n.card.prerequisites ?? []).length);
  let lq = db().from('locations').select('id,slug,name,country_code,notes').eq('level', 'micro_area').eq('active', true);
  if (opts.locationId) lq = lq.eq('id', opts.locationId);
  const places = must(await lq, 'places');
  const existing = must(await db().from('niche_place_checks').select('niche_id,location_id,checked_at'), 'checks');
  const fresh = (n: string, l: string) =>
    existing.some((c: { niche_id: string; location_id: string; checked_at: string }) => c.niche_id === n && c.location_id === l && Date.now() - Date.parse(c.checked_at) < 90 * 86_400_000);

  let checked = 0;
  for (const niche of niches) {
    const todo = places.filter((p: { id: string }) => opts.force || !fresh(niche.id, p.id));
    if (!todo.length) continue;
    const out = await ask<{ places: { slug: string; verdict: 'yes' | 'no' | 'unknown'; reason: string }[] }>({
      run,
      model: models.judgment,
      system:
        'You check whether a place can realistically host a specific business, given its physical and legal prerequisites. Use your knowledge of the geography (geothermal activity, terrain, land sizes, zoning norms). Say "no" only when a prerequisite is clearly impossible or very unlikely there; "unknown" when it depends on the specific property; "yes" when typical properties there can meet it.',
      prompt: `Business: ${niche.name}. ${clip(niche.card.summary ?? niche.card.description ?? '', 400)}\nPrerequisites:\n${(niche.card.prerequisites as string[]).map((p) => `- ${p}`).join('\n')}\n\nPlaces:\n${todo
        .map((p: { slug: string; name: string; country_code: string; notes?: string }) => `- ${p.slug}: ${p.name} (${p.country_code})${p.notes ? ` — ${clip(p.notes, 150)}` : ''}`)
        .join('\n')}`,
      tool: {
        name: 'site_checks',
        description: 'A verdict per place',
        schema: {
          type: 'object',
          properties: {
            places: {
              type: 'array',
              items: {
                type: 'object',
                properties: { slug: { type: 'string' }, verdict: { type: 'string', enum: ['yes', 'no', 'unknown'] }, reason: { type: 'string', description: 'One short sentence' } },
                required: ['slug', 'verdict', 'reason'],
              },
            },
          },
          required: ['places'],
        },
      },
      maxTokens: 3000,
    });
    for (const r of out.places) {
      const place = todo.find((p: { slug: string }) => p.slug === r.slug);
      if (!place) continue;
      await db()
        .from('niche_place_checks')
        .upsert({ niche_id: niche.id, location_id: place.id, verdict: r.verdict, reason: r.reason, checked_at: new Date().toISOString(), run_id: run.id }, { onConflict: 'niche_id,location_id' });
      checked++;
    }
  }
  return { niches: niches.length, checked };
}
