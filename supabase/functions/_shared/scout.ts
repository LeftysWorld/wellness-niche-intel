// Location scout: fills missing, stale or estimated ledger values for one
// location, fully automatically. Each value is gathered from several sources,
// each quote is checked against its page, and the median of the confirmed
// figures is written with a confidence set by how many separate sites agree.
import { db, getSetting, must, type Models } from './db.ts';
import { fetchText } from './search.ts';
import { KEY_GUIDE, REQUIRED_LOCATION_KEYS, writeAssumptions, type LocationRow, type NewAssumption } from './ledger.ts';
import { ask } from './llm.ts';
import { BudgetExceeded, type Run } from './runs.ts';
import { search, type SearchHit } from './search.ts';
import { consensus, type Observation } from './consensus.ts';

/** Values that belong to a country; everything else belongs to a place within it. */
export const COUNTRY_KEYS = new Set(['tax.revenue_pct', 'tax.income_effective_pct', 'exit.country_discount', 'labor.monthly_wage_usd', 'finance.rate_pct']);

export async function scoutLocation(run: Run, locationId: string, opts: { keys?: string[]; force?: boolean } = {}) {
  const models = await getSetting<Models & { numbers?: string }>('models');
  const fx = await getSetting<{ cop_per_usd?: number }>('currency');
  const location = must(await db().from('locations').select('*').eq('id', locationId).single(), 'location') as LocationRow;
  const current = must(
    await db().from('current_assumptions').select('key,is_stale,written_by').eq('subject_type', 'location').eq('subject_id', locationId),
    'current values',
  );
  const have = new Map<string, { is_stale: boolean; written_by: string }>(current.map((c: { key: string; is_stale: boolean; written_by: string }) => [c.key, c]));
  const wanted = (opts.keys?.length ? opts.keys : [...REQUIRED_LOCATION_KEYS]).filter((k) => {
    const c = have.get(k);
    return opts.force || !c || c.is_stale || String(c.written_by).includes('estimate');
  });
  // Country-level keys belong on the country; micro-area keys on the micro-area.
  const countryOnly = COUNTRY_KEYS;
  // Fully automated: a value the scout can't find is retried with a different
  // search strategy each time; after three failed strategies it waits a month,
  // then starts the cycle again. Nothing is handed to the owner.
  const misses = ((location.profile?.scout_misses ?? {}) as Record<string, { count: number; last: string }>);
  const resting = (k: string) => {
    const m = misses[k];
    return !opts.force && m && m.count > 0 && m.count % 3 === 0 && Date.now() - Date.parse(m.last) < 30 * 86_400_000;
  };
  const keys = wanted.filter((k) => (location.level === 'country' ? countryOnly.has(k) : !countryOnly.has(k)) && !resting(k));
  if (!keys.length) return { location: location.slug, written: 0, skipped: 'nothing missing or stale' };

  const country = location.parent_id
    ? (must(await db().from('locations').select('name').eq('id', location.parent_id).maybeSingle(), 'country')?.name as string | undefined)
    : undefined;
  const written: string[] = [];
  const skipped: { key: string; reason: string; note: string }[] = [];
  const squash = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();

  for (const key of keys) {
    const attempt = misses[key]?.count ?? 0;
    const queries = strategy(key, location, country, attempt);
    const seen = new Set<string>();
    const hits: SearchHit[] = [];
    for (const q of queries) for (const h of await search(run, q, 8)) if (!seen.has(h.url) && seen.add(h.url)) hits.push(h);
    if (!hits.length) {
      skipped.push({ key, reason: 'no search results', note: queries.join(' | ') });
      misses[key] = { count: attempt + 1, last: new Date().toISOString() };
      continue;
    }
    type Out = { found: boolean; unit: string; note: string; values: { value: number; source_index: number; quote: string }[] };
    let out: Out;
    try {
    out = await ask<Out>({
      run,
      // Numbers feed the money model directly, so they get the mid-tier model.
      model: models.numbers ?? models.judgment,
      system:
        'You extract every figure for one value from search results, each with its source and an exact quote. Report one entry per listing, statistic or source (not one summary figure), at most 12 entries. Keep each quote short: just the words around the figure, under 25 words. Keep the note under 40 words. Convert currency and units to what is asked (e.g. hectares to acres, yearly to monthly) and say how in the note. Use figures about this place or the closest comparable nearby. Set found=false only when nothing in the results is about this value.',
      prompt: [
        `Location: ${location.name}${country ? `, ${country}` : ''} (${location.country_code}).`,
        `Value wanted (${key}): ${KEY_GUIDE[key] ?? key}.`,
        `Exchange rate: ${fx.cop_per_usd ?? 'n/a'} COP per USD. Report money in USD.`,
        `Results:\n${hits.map((h, i) => `[${i}] ${h.url}\n${h.title}\n${h.snippet}`).join('\n\n')}`,
      ].join('\n\n'),
      tool: {
        name: 'values',
        description: 'Every figure found for the value',
        schema: {
          type: 'object',
          properties: {
            found: { type: 'boolean' },
            unit: { type: 'string' },
            note: { type: 'string', description: 'How figures were converted and how they differ from what was asked' },
            values: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  value: { type: 'number', description: 'Converted to the unit asked for' },
                  source_index: { type: 'integer', description: 'The [n] of the result' },
                  quote: { type: 'string', description: 'The exact words from that result that contain the original figure, copied character for character' },
                },
                required: ['value', 'source_index', 'quote'],
              },
            },
          },
          required: ['found', 'unit', 'note', 'values'],
        },
      },
      maxTokens: 4000,
    });
    } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
      // One value failing must not stop the rest; it is retried with the next strategy.
      skipped.push({ key, reason: 'extraction failed', note: (e as Error).message });
      misses[key] = { count: attempt + 1, last: new Date().toISOString() };
      continue;
    }

    // Confirm each quote against the result text, then the page itself (a few pages at most).
    const observations: Observation[] = [];
    let fetched = 0;
    for (const v of out.found ? out.values.slice(0, 12) : []) {
      const source = hits[v.source_index];
      if (!source) continue;
      const quote = squash(v.quote ?? '');
      let confirmed = quote.length >= 4 && squash(`${source.title} ${source.snippet}`).includes(quote);
      if (!confirmed && quote.length >= 4 && fetched < 4) {
        fetched++;
        confirmed = squash(await fetchText(source.url, 60000)).includes(quote);
      }
      observations.push({ value: v.value, url: source.url, confirmed });
    }
    const c = consensus(observations);
    if (!c) {
      skipped.push({ key, reason: 'no usable figures', note: out.note });
      misses[key] = { count: attempt + 1, last: new Date().toISOString() };
      continue;
    }
    delete misses[key];
    // The cited source is the kept observation closest to the median.
    const best = [...c.kept].sort((a, b) => Math.abs(a.value - c.value) - Math.abs(b.value - c.value))[0];
    const row: NewAssumption = {
      subject_type: 'location',
      subject_id: location.id,
      key,
      value_num: Math.round(c.value * 1000) / 1000,
      low: Math.round(c.low * 1000) / 1000,
      high: Math.round(c.high * 1000) / 1000,
      unit: out.unit,
      currency: key.endsWith('_usd') ? 'USD' : null,
      source_url: best.url,
      source_note: `Median of ${c.kept.length} figure(s) from ${c.sources} site(s)${c.dropped.length ? `, ${c.dropped.length} outlier(s) dropped` : ''}. ${out.note} Sources: ${[...new Set(c.kept.map((o) => o.url))].slice(0, 6).join(' ')}`.slice(0, 2000),
      confidence: c.confidence,
      stale_after: key.startsWith('lease') || key.startsWith('land') ? '90 days' : key.startsWith('demand.population') ? '1095 days' : '365 days',
    };
    written.push(...(await writeAssumptions(run, 'location-scout', [row])));
  }
  await db().from('locations').update({ profile: { ...(location.profile ?? {}), scout_misses: misses } }).eq('id', location.id);
  return { location: location.slug, asked: keys.length, written: written.length, skipped };
}

function queryFor(key: string, l: LocationRow): string {
  const place = l.name;
  const es = l.country_code === 'CO' || l.country_code === 'SV' || l.country_code === 'CR';
  switch (key) {
    case 'land.price_per_acre_usd':
      return es ? `lote rural en venta ${place} precio hectárea` : `land for sale ${place} acres price`;
    case 'lease.finca_monthly_usd':
      return es ? `finca en arriendo ${place} mensual` : `rural house rent monthly ${place} 4 bedroom`;
    case 'lease.commercial_monthly_usd':
      return es ? `local comercial en arriendo ${place} rural parqueadero` : `commercial property for lease ${place} rural retail`;
    case 'lease.estate_monthly_usd':
      return es ? `finca grande en arriendo ${place} hectáreas` : `estate for rent ${place} acres farm`;
    case 'tax.income_effective_pct':
      return es ? `tarifa régimen simple de tributación 2026 servicios` : `self-employment tax and income tax rate small business ${place}`;
    case 'labor.monthly_wage_usd':
      return es ? `salario mínimo ${place} 2026 carga prestacional` : `hospitality worker wage ${place} 2026`;
    case 'tax.revenue_pct':
      return es ? `régimen simple tributación tarifa hoteles ${place}` : `lodging tax rate ${place}`;
    case 'demand.population_40min':
      return `population ${place} metropolitan area`;
    case 'exit.country_discount':
      return `foreign buyer risk real estate ${place} title currency`;
    default:
      return `${KEY_GUIDE[key] ?? key} ${place}`;
  }
}

/**
 * Search strategy by attempt: listing and local-language searches first, then
 * official statistics and the big listing portals, then the wider region.
 * After three failed strategies the scout rests for a month and starts again.
 */
export function strategy(key: string, l: LocationRow, country: string | undefined, attempt: number): string[] {
  const guide = KEY_GUIDE[key] ?? key;
  const region = `${l.name}${country ? ` ${country}` : ''}`;
  switch (attempt % 3) {
    case 0:
      return [queryFor(key, l), `${guide} ${l.name}`];
    case 1:
      return [officialQuery(key, l, country), portalQuery(key, l)];
    default:
      return [`${guide} ${country ?? region}`, `${guide} near ${region} average`];
  }
}

function officialQuery(key: string, l: LocationRow, country?: string): string {
  const cc = l.country_code;
  const place = l.name;
  switch (key) {
    case 'demand.population_40min':
      return cc === 'US' ? `${place} county population census estimate` : cc === 'CO' ? `población ${place} DANE proyección` : `population ${place} ${country ?? ''} census`;
    case 'labor.monthly_wage_usd':
      return cc === 'US' ? `BLS hotel desk clerk hourly wage ${place}` : cc === 'CO' ? 'salario mínimo 2026 Colombia decreto auxilio de transporte' : `minimum wage 2026 ${country ?? place}`;
    case 'tax.income_effective_pct':
      return cc === 'US' ? 'IRS self-employment tax rate 2026' : cc === 'CO' ? 'DIAN régimen simple de tributación tarifas 2026' : `small business income tax rate ${country ?? place} 2026`;
    case 'tax.revenue_pct':
      return cc === 'CO' ? 'DIAN régimen simple tarifas actividades hoteleras' : `lodging occupancy tax rate ${place}`;
    default:
      return `${KEY_GUIDE[key] ?? key} ${place} statistics`;
  }
}

function portalQuery(key: string, l: LocationRow): string {
  const portal = l.country_code === 'US' ? 'land.com OR zillow' : l.country_code === 'CO' ? 'fincaraiz OR metrocuadrado' : 'encuentra24';
  if (key.startsWith('land')) return `${portal} land for sale ${l.name}`;
  if (key.startsWith('lease')) return `${portal} rent ${l.name} ${key.includes('commercial') ? 'commercial' : key.includes('estate') ? 'farm estate' : 'house'}`;
  return `${KEY_GUIDE[key] ?? key} ${l.name}`;
}
