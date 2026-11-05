// Location scout: fills missing or stale ledger values for one location by
// searching and extracting sourced numbers. Only values with a source URL
// that came back in the search results are written.
import { db, getSetting, must, type Models } from './db.ts';
import { KEY_GUIDE, REQUIRED_LOCATION_KEYS, writeAssumptions, type LocationRow, type NewAssumption } from './ledger.ts';
import { ask } from './llm.ts';
import type { Run } from './runs.ts';
import { search } from './search.ts';

export async function scoutLocation(run: Run, locationId: string, opts: { keys?: string[]; force?: boolean } = {}) {
  const models = await getSetting<Models>('models');
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
  const countryOnly = new Set(['tax.revenue_pct', 'exit.country_discount', 'labor.monthly_wage_usd', 'finance.rate_pct']);
  const keys = wanted.filter((k) => location.level === 'country' || !countryOnly.has(k));
  if (!keys.length) return { location: location.slug, written: 0, skipped: 'nothing missing or stale' };

  const written: string[] = [];
  const skipped: { key: string; reason: string; note: string }[] = [];
  for (const key of keys) {
    const q = queryFor(key, location);
    // Two searches per value: the local-language query and an English one.
    const seen = new Set<string>();
    const hits = [...(await search(run, q, 6)), ...(await search(run, `${KEY_GUIDE[key] ?? key} ${location.name}`, 5))].filter((h) => !seen.has(h.url) && seen.add(h.url));
    if (!hits.length) {
      skipped.push({ key, reason: 'no search results', note: q });
      continue;
    }
    type Out = { found: boolean; value: number; low: number; high: number; unit: string; source_index: number; note: string; confidence: 'high' | 'medium' | 'low' };
    const out = await ask<Out>({
      run,
      model: models.extraction,
      system: 'You extract one numeric fact from search results with its source. Use numbers stated in the results; you may convert currency and units (e.g. hectares to acres, yearly to monthly) and say so in the note. Give a range across the listings you see. The description of the value is a target, not a filter: if the closest evidence differs (fewer bedrooms, smaller or larger lots, a nearby town), still report it, set confidence to low, and say in the note how it differs and which way it likely biases the number. Set found=false only when nothing in the results is about this value in or near this place.',
      prompt: [
        `Location: ${location.name} (${location.country_code}).`,
        `Value wanted (${key}): ${KEY_GUIDE[key] ?? key}.`,
        `Exchange rate: ${fx.cop_per_usd ?? 'n/a'} COP per USD. Report money in USD.`,
        `Results:\n${hits.map((h, i) => `[${i}] ${h.url}\n${h.title}\n${h.snippet}`).join('\n\n')}`,
      ].join('\n\n'),
      tool: {
        name: 'value',
        description: 'Report the extracted value',
        schema: {
          type: 'object',
          properties: {
            found: { type: 'boolean' },
            value: { type: 'number' },
            low: { type: 'number' },
            high: { type: 'number' },
            unit: { type: 'string' },
            source_index: { type: 'integer', description: 'The [n] of the result the value comes from' },
            note: { type: 'string' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: ['found', 'value', 'low', 'high', 'unit', 'source_index', 'note', 'confidence'],
        },
      },
      maxTokens: 800,
    });
    const source = hits[out.source_index];
    if (!out.found || !source || !(out.value > 0)) {
      skipped.push({ key, reason: !out.found ? 'not found in results' : !source ? 'bad source index' : 'non-positive value', note: out.note });
      continue;
    }
    const row: NewAssumption = {
      subject_type: 'location',
      subject_id: location.id,
      key,
      value_num: out.value,
      low: Math.min(out.low, out.value),
      high: Math.max(out.high, out.value),
      unit: out.unit,
      currency: key.endsWith('_usd') ? 'USD' : null,
      source_url: source.url,
      source_note: out.note,
      confidence: out.confidence,
      stale_after: key.startsWith('lease') || key.startsWith('land') ? '120 days' : '365 days',
    };
    written.push(...(await writeAssumptions(run, 'location-scout', [row])));
  }
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
