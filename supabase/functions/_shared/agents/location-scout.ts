// Location scout agent: researches the ledger values one place still needs,
// choosing its own sources and search angles, and commits each value through
// the consensus rules in agent-tools.ts.
import type { AgentContext, AgentDef } from '../agent.ts';
import { fetchPage, figureTools, webSearch } from '../agent-tools.ts';
import { db, getSetting, must } from '../db.ts';
import { INDEX_RAW, KEY_GUIDE, PLAUSIBLE, REQUIRED_LOCATION_KEYS, type LocationRow } from '../ledger.ts';
import { COUNTRY_KEYS, writeIndex } from '../scout.ts';
import { ANSWER_KEY, rangeUsd } from '../evals/answer-key.ts';
import { gradeRanges } from '../evals/grading.ts';

export interface ScoutParams extends Record<string, unknown> {
  location_id: string;
  keys?: string[];
  force?: boolean;
  /** Evaluation: find the values but do not write them; grade them against the answer key. */
  dry_run?: boolean;
  eval_ids?: string[];
}

type Ctx = AgentContext<ScoutParams>;

async function load(ctx: Ctx) {
  const location = must(await db().from('locations').select('*').eq('id', ctx.params.location_id).single(), 'location') as LocationRow;
  const country = location.parent_id
    ? (must(await db().from('locations').select('name').eq('id', location.parent_id).maybeSingle(), 'country')?.name as string | undefined)
    : undefined;
  return { location, country };
}

/** Values to research: missing, stale or estimated (or the ones asked for), at this place's level; raw figures for index values. */
export async function wantedKeys(location: LocationRow, opts: { keys?: string[]; force?: boolean }) {
  const current = must(
    await db().from('current_assumptions').select('key,is_stale,written_by,value_num').eq('subject_type', 'location').eq('subject_id', location.id),
    'current values',
  ) as { key: string; is_stale: boolean; written_by: string; value_num: number | null }[];
  const have = new Map(current.map((c) => [c.key, c]));
  const misses = (location.profile?.scout_misses ?? {}) as Record<string, { count: number; last: string }>;
  const resting = (k: string) => !opts.force && misses[k] && misses[k].count >= 3 && Date.now() - Date.parse(misses[k].last) < 30 * 86_400_000;
  const base = (opts.keys?.length ? opts.keys : [...REQUIRED_LOCATION_KEYS]).filter((k) => {
    const c = have.get(k);
    return opts.force || opts.keys?.length || !c || c.is_stale || String(c.written_by).includes('estimate');
  });
  const levelKeys = base.filter((k) => (location.level === 'country' ? COUNTRY_KEYS.has(k) : !COUNTRY_KEYS.has(k)));
  const indexKeys = levelKeys.filter((k) => INDEX_RAW[k]);
  const raw = indexKeys.map((k) => INDEX_RAW[k]).filter((r) => opts.force || opts.keys?.length || !have.get(r) || have.get(r)!.is_stale);
  const keys = [...levelKeys.filter((k) => !INDEX_RAW[k]), ...raw].filter((k) => !resting(k));
  return { keys: [...new Set(keys)], indexKeys, have };
}

export const locationScout: AgentDef<ScoutParams> = {
  name: 'location-scout',
  runKind: 'location_scout',
  model: (m) => m.numbers ?? m.judgment,
  tools(ctx) {
    // The values this run may write: set by the task (and refreshed by location_status).
    const allowed = () => new Set((ctx.scratch.keys as string[] | undefined) ?? []);
    const status = {
      name: 'location_status',
      description: 'The place, the values it needs (with definitions, plausible ranges and current values), and exchange rates. Call once at the start.',
      input_schema: { type: 'object' as const, properties: {} },
      async run(_input: unknown, c: Ctx) {
        const { location, country } = await load(c);
        const { keys, have } = await wantedKeys(location, c.params);
        c.scratch.keys = keys;
        const fx = await getSetting<Record<string, unknown>>('currency');
        return {
          place: location.name,
          country: country ?? location.name,
          country_code: location.country_code,
          level: location.level,
          exchange_rates: { cop_per_usd: fx.cop_per_usd, crc_per_usd: fx.crc_per_usd },
          values_needed: keys.map((k) => ({
            key: k,
            definition: KEY_GUIDE[k] ?? k,
            plausible_range: PLAUSIBLE[k] ?? null,
            current: have.get(k) ? { value: have.get(k)!.value_num, written_by: have.get(k)!.written_by, stale: have.get(k)!.is_stale } : null,
            total_of_parts: k === 'demand.population_40min',
          })),
        };
      },
    };
    const rules = {
      agent: 'location-scout',
      dryRun: Boolean(ctx.params.dry_run),
      allowed: (k: string) => allowed().has(k),
      range: (k: string) => PLAUSIBLE[k] ?? null,
      subject: () => ({ subject_type: 'location' as const, subject_id: ctx.params.location_id }),
    };
    const [record, commit, giveUp] = figureTools(rules);
    return [status, webSearch, fetchPage, record, commit, giveUp];
  },
  async task(ctx) {
    const { location, country } = await load(ctx);
    const { keys } = await wantedKeys(location, ctx.params);
    ctx.scratch.keys = keys;
    if (!keys.length) return `Nothing is missing or stale for ${location.name}. Call finish with a one-line summary.`;
    return [
      `Scout ${location.name}${country ? `, ${country}` : ''} (${location.country_code}).`,
      `Values to research (${keys.length}): ${keys.join(', ')}.`,
      ctx.params.dry_run ? 'This is a test run: values are graded, not written. Work exactly as you normally would.' : '',
      'Start with location_status. Work through the values, most important first: land and lease prices, wages, then taxes, then the rest.',
    ].filter(Boolean).join('\n');
  },
  finish: {
    description: 'Finish the scouting run.',
    schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What was committed and what is still missing, and why' },
        missing: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, reason: { type: 'string' } }, required: ['key', 'reason'] } },
      },
      required: ['summary', 'missing'],
    },
  },
  async onFinish(ctx, result) {
    const { location } = await load(ctx);
    const committed = (ctx.scratch.committed ?? {}) as Record<string, { value: number }>;
    if (ctx.params.dry_run) return await gradeDryRun(ctx, committed);
    // Index values are computed from the raw figures just found.
    const { indexKeys } = await wantedKeys(location, { ...ctx.params, force: true });
    const indexes: Record<string, unknown> = {};
    for (const k of indexKeys) if (committed[INDEX_RAW[k]]) indexes[k] = await writeIndex(ctx.run, location, k);
    // Values not found count as misses, so the next run tries harder or rests them.
    const misses = (location.profile?.scout_misses ?? {}) as Record<string, { count: number; last: string }>;
    const gave = (ctx.scratch.gave_up ?? {}) as Record<string, string>;
    const notFound = [...new Set([...Object.keys(gave), ...((result.missing as { key: string }[]) ?? []).map((m) => m.key)])].filter((k) => !committed[k]);
    for (const k of Object.keys(committed)) delete misses[k];
    for (const k of notFound) misses[k] = { count: (misses[k]?.count ?? 0) + 1, last: new Date().toISOString() };
    await db().from('locations').update({ profile: { ...(location.profile ?? {}), scout_misses: misses } }).eq('id', location.id);
    return { location: location.slug, committed: Object.keys(committed), indexes: Object.keys(indexes), not_found: notFound };
  },
};

async function gradeDryRun(ctx: Ctx, committed: Record<string, { value: number }>) {
  const fx = await getSetting<{ cop_per_usd?: number; crc_per_usd?: number }>('currency');
  const entries = ANSWER_KEY.filter((e) => (ctx.params.eval_ids ?? []).includes(e.id));
  const graded = gradeRanges(entries.map((e) => ({ id: e.id, value: committed[e.key]?.value ?? null, range: rangeUsd(e, fx) })));
  for (const g of graded) {
    await db().from('eval_results').insert({
      suite: 'scout_live',
      metric: g.id,
      value: g.value,
      passed: g.pass,
      sample_size: 1,
      details: { range: g.range, miss: g.miss, session_id: ctx.sessionId },
      run_id: ctx.run.id,
    });
  }
  return { graded };
}
