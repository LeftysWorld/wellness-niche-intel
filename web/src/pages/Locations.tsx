import { useEffect, useState, type FormEvent } from 'react';
import { callAgent, supabase, usd } from '../supabase.ts';
import { FilterLayout, ratingField, useFilters } from '../filters.tsx';
import { Err, Loading, RunButton, Section, useLoad } from '../ui.tsx';

interface Place {
  id: string;
  slug: string;
  name: string;
  country_code: string;
  level: string;
  parent_id: string | null;
  active: boolean;
  favorite: boolean;
  origin: string;
  notes: string | null;
  fit: { score?: number; summary?: string; pros?: string[]; cons?: string[]; unknowns?: string[]; dismissed?: boolean };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  profile?: Record<string, any>;
}

const FACTS: [string, string, (v: number) => string][] = [
  ['lease.finca_monthly_usd', 'House lease', (v) => `${usd(v)}/mo`],
  ['lease.commercial_monthly_usd', 'Commercial lease', (v) => `${usd(v)}/mo`],
  ['lease.estate_monthly_usd', 'Estate lease', (v) => `${usd(v)}/mo`],
  ['land.price_per_acre_usd', 'Land', (v) => `${usd(v)}/acre`],
  ['labor.monthly_wage_usd', 'Worker', (v) => `${usd(v)}/mo`],
  ['demand.population_40min', 'People within 40 min', (v) => Math.round(v).toLocaleString()],
];

interface Fact {
  subject_id: string;
  key: string;
  value_num: number | null;
  written_by: string;
  source_url: string | null;
}

/** One value with where it came from. Guessed or missing values are found by the scout automatically. */
function FactCell({ label, fmt, fact, searching }: { label: string; fmt: (v: number) => string; fact?: Fact; searching: boolean }) {
  const guessed = fact && (fact.written_by.includes('estimate') || !fact.source_url);
  return (
    <span>
      {label}: <b>{fact?.value_num != null ? fmt(Number(fact.value_num)) : '—'}</b>
      {fact?.source_url && !guessed && (
        <>
          {' '}
          <a href={fact.source_url} target="_blank" rel="noreferrer" title="Source">
            ↗
          </a>
        </>
      )}
      {guessed && <small className="muted" title="Starting estimate; the scout replaces it with sourced figures"> est.</small>}
      {(searching || !fact || guessed) && <small className="muted" title="The scout keeps searching automatically, trying a different strategy each time"> · searching</small>}
    </span>
  );
}

function Wishes() {
  const profile = useLoad(async () => {
    const { data, error } = await supabase.from('parameter_profiles').select('id,params').eq('is_default', true).single();
    if (error) throw error;
    return data;
  });
  const [text, setText] = useState('');
  const [state, setState] = useState<string | null>(null);
  useEffect(() => {
    if (profile.data) setText(String(profile.data.params?.location_wishes ?? ''));
  }, [profile.data]);

  async function save() {
    if (!profile.data) return;
    setState('Saving…');
    const params = { ...profile.data.params, location_wishes: text };
    const { error } = await supabase.from('parameter_profiles').update({ params }).eq('id', profile.data.id);
    if (error) return setState(error.message);
    setState('Saved. Re-scoring your places against it…');
    try {
      await callAgent('location-fit');
      setState('Saved and re-scored.');
    } catch (e) {
      setState(`Saved. Re-scoring failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  return (
    <Section title="What I'm looking for in a place">
      <p className="muted small">In your own words: climate, landscape, how remote, distance to an airport or city, community, cost, safety, language, anything that matters.</p>
      <textarea
        rows={6}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. Cool mountain climate, green and quiet, under 1 hour from an international airport, a town nearby with good food, safe for my family, land with a view…"
      />
      <div className="actions">
        <button onClick={save} disabled={!profile.data}>
          Save and re-score places
        </button>
        {state && <small className="muted">{state}</small>}
      </div>
    </Section>
  );
}

function AddPlace({ countries, onAdded }: { countries: Place[]; onAdded: () => void }) {
  const [name, setName] = useState('');
  const [country, setCountry] = useState('');
  const [otherCode, setOtherCode] = useState('');
  const [otherName, setOtherName] = useState('');
  const [notes, setNotes] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    setMsg('Adding…');
    let parent = countries.find((c) => c.id === country);
    if (country === 'other') {
      const code = otherCode.trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(code)) return setMsg('Use a 2-letter country code, e.g. PT, MX, EC');
      const { data, error } = await supabase.from('locations').insert({ slug: code.toLowerCase(), name: otherName || code, country_code: code, level: 'country', active: true, origin: 'user' }).select('*').single();
      if (error) return setMsg(error.message);
      parent = data as Place;
    }
    if (!parent) return setMsg('Pick a country');
    const slug = `${parent.country_code.toLowerCase()}-${name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    const { data: place, error } = await supabase
      .from('locations')
      .insert({ slug, name, country_code: parent.country_code, level: 'micro_area', parent_id: parent.id, active: true, favorite: true, origin: 'user', notes: notes || null })
      .select('id')
      .single();
    if (error) return setMsg(error.message.includes('duplicate') ? 'That place is already on your list' : error.message);
    setName('');
    setNotes('');
    setMsg('Added. Looking up local costs and scoring it (about a minute)…');
    onAdded();
    try {
      await callAgent('location-fit', { location_id: place.id });
      onAdded();
      await callAgent('location-scout', { location_id: place.id });
      setMsg('Added, scored and researched.');
    } catch (err) {
      setMsg(`Added. Research will finish on the next daily run (${err instanceof Error ? err.message : err}).`);
    }
    onAdded();
  }

  return (
    <Section title="Add a place">
      <form className="add-place" onSubmit={add}>
        <input required placeholder="Town or area, e.g. Jardín" value={name} onChange={(e) => setName(e.target.value)} />
        <select required value={country} onChange={(e) => setCountry(e.target.value)}>
          <option value="">Country…</option>
          {countries.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
          <option value="other">Other…</option>
        </select>
        {country === 'other' && (
          <>
            <input placeholder="Code (PT)" size={4} value={otherCode} onChange={(e) => setOtherCode(e.target.value)} />
            <input placeholder="Country name" value={otherName} onChange={(e) => setOtherName(e.target.value)} />
          </>
        )}
        <input className="grow" placeholder="Why you like it (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <button type="submit">Add place</button>
      </form>
      {msg && <p className="small muted">{msg}</p>}
    </Section>
  );
}

type PlaceRow = { p: Place; list: 'My places' | 'Suggested' | 'Removed'; facts: Record<string, Fact | undefined>; country: string; missed: string[] };

const ORIGIN: Record<string, string> = { user: 'Added by me', ai_suggested: 'AI suggested', seed: 'Starter list' };

export function Locations() {
  const { data, error, reload } = useLoad(async () => {
    const { data: places, error } = await supabase.from('locations').select('*').order('name');
    if (error) throw error;
    const ids = (places ?? []).map((p) => p.id);
    const { data: facts } = await supabase
      .from('current_assumptions')
      .select('subject_id,key,value_num,written_by,source_url')
      .eq('subject_type', 'location')
      .in('subject_id', ids)
      .in('key', FACTS.map((f) => f[0]));
    return { places: (places ?? []) as Place[], facts: (facts ?? []) as Fact[] };
  });

  const places = data?.places ?? [];
  const byId = new Map(places.map((p) => [p.id, p]));
  const fact = (p: Place, key: string): Fact | undefined =>
    (data?.facts.find((f) => f.subject_id === p.id && f.key === key) ?? data?.facts.find((f) => f.subject_id === p.parent_id && f.key === key)) as Fact | undefined;
  const isGuess = (f?: Fact) => !f || f.written_by.includes('estimate') || !f.source_url;
  const rows: PlaceRow[] = places
    .filter((p) => p.level === 'micro_area')
    .map((p): PlaceRow => ({
      p,
      list: p.active ? 'My places' : p.origin === 'ai_suggested' && !p.fit?.dismissed ? 'Suggested' : 'Removed',
      facts: Object.fromEntries(FACTS.map(([k]) => [k, fact(p, k)])),
      country: byId.get(p.parent_id ?? '')?.name ?? p.country_code,
      missed: Object.keys((p.profile?.scout_misses ?? {}) as Record<string, unknown>),
    }));
  const num = (key: string) => (r: PlaceRow) => r.facts[key]?.value_num ?? null;
  const f = useFilters<PlaceRow>({
    tab: 'locations',
    rows,
    defaults: { enums: { list: ['My places', 'Suggested'] } },
    sorts: [
      { key: 'starred', label: 'Starred, then best match', cmp: (a, b) => Number(b.p.favorite) - Number(a.p.favorite) || (b.p.fit?.score ?? -1) - (a.p.fit?.score ?? -1) },
      { key: 'match', label: 'Best match', cmp: (a, b) => (b.p.fit?.score ?? -1) - (a.p.fit?.score ?? -1) },
      { key: 'cheapLease', label: 'Cheapest house lease', cmp: (a, b) => (num('lease.finca_monthly_usd')(a) ?? 1e12) - (num('lease.finca_monthly_usd')(b) ?? 1e12) },
      { key: 'cheapLand', label: 'Cheapest land', cmp: (a, b) => (num('land.price_per_acre_usd')(a) ?? 1e12) - (num('land.price_per_acre_usd')(b) ?? 1e12) },
      { key: 'name', label: 'Name A–Z', cmp: (a, b) => a.p.name.localeCompare(b.p.name) },
    ],
    fields: [
      { key: 'text', label: 'Text', type: 'text', get: (r) => [r.p.notes, r.p.fit?.summary, ...(r.p.fit?.pros ?? []), ...(r.p.fit?.cons ?? []), ...(r.p.fit?.unknowns ?? [])].join(' ') },
      ratingField<PlaceRow>('match', 'Match to my description', (r) => r.p.fit?.score),
      { key: 'list', label: 'List', type: 'enum', group: 'Place', get: (r) => r.list, order: ['My places', 'Suggested', 'Removed'] },
      { key: 'country', label: 'Country', type: 'enum', group: 'Place', get: (r) => r.country },
      { key: 'fav', label: 'Starred', type: 'bool', group: 'Place', get: (r) => r.p.favorite },
      { key: 'origin', label: 'Where it came from', type: 'enum', group: 'Place', get: (r) => ORIGIN[r.p.origin] ?? r.p.origin },
      { key: 'match', label: 'Match to my description /10', type: 'number', group: 'Place', get: (r) => r.p.fit?.score },
      { key: 'scored', label: 'Scored against my description', type: 'bool', group: 'Place', get: (r) => r.p.fit?.score !== undefined },
      ...FACTS.map(([key, label]) => ({ key, label, type: 'number' as const, group: 'Local costs', get: num(key), fmt: key.startsWith('demand') ? (v: number) => Math.round(v).toLocaleString() : usd })),
      {
        key: 'data',
        label: 'Data quality',
        type: 'enum',
        group: 'Data',
        get: (r) => {
          const guessed = FACTS.filter(([k]) => isGuess(r.facts[k])).length;
          return guessed === 0 ? 'All sourced' : guessed <= FACTS.length / 2 ? 'Some estimates' : 'Mostly estimates';
        },
        order: ['All sourced', 'Some estimates', 'Mostly estimates'],
      },
      { key: 'searching', label: 'Scout still searching', type: 'bool', group: 'Data', get: (r) => r.missed.length > 0 || FACTS.some(([k]) => isGuess(r.facts[k])) },
    ],
  });

  if (error) return <Err error={error} />;
  if (!data) return <Loading />;
  const countries = places.filter((p) => p.level === 'country');
  const mine = f.rows.filter((r) => r.list === 'My places').map((r) => r.p);
  const suggested = f.rows.filter((r) => r.list === 'Suggested').map((r) => r.p);
  const removed = f.rows.filter((r) => r.list === 'Removed').map((r) => r.p);
  const missedKeys = (p: Place): string[] => Object.keys((p.profile?.scout_misses ?? {}) as Record<string, unknown>);

  const update = async (id: string, patch: Partial<Place>) => {
    await supabase.from('locations').update(patch).eq('id', id);
    reload();
  };

  return (
    <FilterLayout panel={f.panel} active={f.active}>
      <Wishes />
      <AddPlace countries={countries} onAdded={reload} />
      {f.summary}
      <Section title="My places" actions={<RunButton label="Re-score all" action={() => callAgent('location-fit')} onDone={reload} />}>
        {mine.length === 0 && <p className="muted small">No places match these filters.</p>}
        <div className="cards">
          {mine.map((p) => (
            <article key={p.id} className="idea">
              <header>
                <h3>
                  <button className="star" title={p.favorite ? 'Unstar' : 'Star'} onClick={() => update(p.id, { favorite: !p.favorite })}>
                    {p.favorite ? '★' : '☆'}
                  </button>{' '}
                  {p.name}
                  <small className="muted"> · {byId.get(p.parent_id ?? '')?.name ?? p.country_code}</small>
                </h3>
                <span className="score" title="Match to your description, 0–10">
                  {p.fit?.score ?? '—'}
                </span>
              </header>
              {p.fit?.summary ? <p className="small">{p.fit.summary}</p> : <p className="small muted">Not scored yet — save a description above.</p>}
              {(p.fit?.pros?.length ?? 0) > 0 && <p className="small ok">+ {p.fit.pros!.join(' · ')}</p>}
              {(p.fit?.cons?.length ?? 0) > 0 && <p className="small err">− {p.fit.cons!.join(' · ')}</p>}
              <div className="facts small">
                {FACTS.map(([key, label, fmt]) => (
                  <FactCell key={key} label={label} fmt={fmt} fact={fact(p, key)} searching={missedKeys(p).includes(key)} />
                ))}
              </div>
              {p.notes && <p className="small muted">{p.notes}</p>}
              <footer>
                <RunButton label="Update local data" action={() => callAgent('location-scout', { location_id: p.id })} onDone={reload} />
                <button className="link muted" onClick={() => update(p.id, { active: false, favorite: false })}>
                  Remove
                </button>
              </footer>
            </article>
          ))}
        </div>
      </Section>
      <Section title="Suggested places" actions={<RunButton label="Suggest new places" action={() => callAgent('location-ideas', { count: 5 })} onDone={reload} />}>
        <p className="muted small">The AI looks for towns that match your description. Add the ones you like; they'll be researched and paired with your niches.</p>
        {suggested.length === 0 ? (
          <p className="muted small">None right now.</p>
        ) : (
          <div className="cards">
            {suggested.map((p) => (
              <article key={p.id} className="idea">
                <header>
                  <h3>
                    {p.name} <small className="muted">· {byId.get(p.parent_id ?? '')?.name ?? p.country_code}</small>
                  </h3>
                  <span className="score">{p.fit?.score ?? '—'}</span>
                </header>
                <p className="small" style={{ whiteSpace: 'pre-line' }}>
                  {p.notes}
                </p>
                <footer>
                  <button
                    onClick={async () => {
                      await update(p.id, { active: true });
                      callAgent('location-scout', { location_id: p.id }).then(reload, reload);
                    }}
                  >
                    Add to my places
                  </button>
                  <button className="link muted" onClick={() => update(p.id, { fit: { ...p.fit, dismissed: true } })}>
                    Dismiss
                  </button>
                </footer>
              </article>
            ))}
          </div>
        )}
      </Section>
      {removed.length > 0 && (
        <Section title="Removed places">
          <ul className="queue">
            {removed.map((p) => (
              <li key={p.id}>
                <span className="summary">
                  {p.name} <small className="muted">· {byId.get(p.parent_id ?? '')?.name ?? p.country_code}</small>
                </span>
                <button onClick={() => update(p.id, { active: true, fit: { ...p.fit, dismissed: false } })}>Restore</button>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </FilterLayout>
  );
}
