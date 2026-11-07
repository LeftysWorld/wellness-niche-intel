import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { callAgent, supabase, usd } from '../supabase.ts';
import { Err, Loading, Section, useLoad } from '../ui.tsx';
import { BLOCK, BLOCKS, CATEGORIES, composeBrief, type BlockDef, type BlockInstance, type Param } from '../../../supabase/functions/_shared/blocks.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
interface Design {
  id: string;
  name: string;
  blocks: BlockInstance[];
  status: 'draft' | 'researching' | 'ready' | 'failed';
  niche_id: string | null;
  research: Any;
  updated_at: string;
}

const COUNTRY_OPTIONS = [
  ['US', 'USA'],
  ['CO', 'Colombia'],
  ['CR', 'Costa Rica'],
  ['SV', 'El Salvador'],
];
const uid = () => Math.random().toString(36).slice(2, 10);
const defaults = (def: BlockDef) => Object.fromEntries(def.params.filter((p) => p.default !== undefined).map((p) => [p.key, p.default]));

export function Builder() {
  const { data, error, reload } = useLoad(async () => {
    const [designs, niches, places] = await Promise.all([
      supabase.from('designs').select('*').order('updated_at', { ascending: false }),
      supabase.from('niches').select('id,name,status,card').neq('status', 'rejected').order('name'),
      supabase.from('locations').select('id,name,country_code,active,origin,fit').eq('level', 'micro_area').order('name'),
    ]);
    if (designs.error) throw designs.error;
    return { designs: (designs.data ?? []) as Design[], niches: niches.data ?? [], places: places.data ?? [] };
  });
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<BlockInstance[]>([]);
  const [name, setName] = useState('');
  const [saved, setSaved] = useState<'saved' | 'saving' | 'unsaved'>('saved');
  const [q, setQ] = useState('');
  const [drag, setDrag] = useState<{ type?: string; uid?: string } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loadedFor = useRef<string | null>(null);

  const designs = data?.designs ?? [];
  const current = designs.find((d) => d.id === currentId) ?? null;

  // Open the most recent design, or none.
  useEffect(() => {
    if (!data) return;
    if (!currentId && designs.length) setCurrentId(designs[0].id);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (current && loadedFor.current !== current.id) {
      loadedFor.current = current.id;
      setBlocks(current.blocks ?? []);
      setName(current.name);
      setSaved('saved');
    }
  }, [current]);

  // Autosave after a short pause.
  useEffect(() => {
    if (!current || saved !== 'unsaved') return;
    const t = setTimeout(async () => {
      setSaved('saving');
      await supabase.from('designs').update({ blocks, name: name.trim() || 'Untitled design' }).eq('id', current.id);
      setSaved('saved');
    }, 700);
    return () => clearTimeout(t);
  }, [blocks, name, saved, current]);

  // While research runs, check back every 10 seconds.
  useEffect(() => {
    if (current?.status !== 'researching') return;
    const t = setInterval(reload, 10000);
    return () => clearInterval(t);
  }, [current?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const names = useMemo(
    () => ({
      niches: Object.fromEntries((data?.niches ?? []).map((n: Any) => [n.id, n.name])),
      places: Object.fromEntries((data?.places ?? []).map((p: Any) => [p.id, p.name])),
    }),
    [data],
  );
  const brief = useMemo(() => composeBrief(name || 'Untitled design', blocks, names), [name, blocks, names]);

  const change = (next: BlockInstance[]) => {
    setBlocks(next);
    setSaved('unsaved');
  };
  const add = (type: string, at?: { before?: string }) => {
    const def = BLOCK[type];
    const existing = def.single ? blocks.find((b) => b.type === type) : null;
    if (existing) {
      setFlash(existing.uid);
      setTimeout(() => setFlash(null), 900);
      return;
    }
    const b: BlockInstance = { uid: uid(), type, params: defaults(def) };
    const i = at?.before ? blocks.findIndex((x) => x.uid === at.before) : -1;
    change(i >= 0 ? [...blocks.slice(0, i), b, ...blocks.slice(i)] : [...blocks, b]);
    setFlash(b.uid);
    setTimeout(() => setFlash(null), 900);
  };
  const move = (id: string, before?: string) => {
    if (id === before) return;
    const b = blocks.find((x) => x.uid === id)!;
    const rest = blocks.filter((x) => x.uid !== id);
    const i = before ? rest.findIndex((x) => x.uid === before) : -1;
    change(i >= 0 ? [...rest.slice(0, i), b, ...rest.slice(i)] : [...rest, b]);
  };
  const nudge = (id: string, dir: -1 | 1) => {
    const b = blocks.find((x) => x.uid === id)!;
    const same = blocks.filter((x) => BLOCK[x.type]?.category === BLOCK[b.type]?.category);
    const k = same.findIndex((x) => x.uid === id) + dir;
    if (k < 0 || k >= same.length) return;
    const other = same[k];
    const order = blocks.map((x) => (x.uid === id ? other : x.uid === other.uid ? b : x));
    change(order);
  };
  const setParam = (id: string, key: string, value: unknown) => change(blocks.map((b) => (b.uid === id ? { ...b, params: { ...b.params, [key]: value } } : b)));
  const remove = (id: string) => change(blocks.filter((b) => b.uid !== id));
  const duplicate = (id: string) => {
    const b = blocks.find((x) => x.uid === id)!;
    if (BLOCK[b.type]?.single) return;
    const i = blocks.findIndex((x) => x.uid === id);
    change([...blocks.slice(0, i + 1), { ...b, uid: uid(), params: { ...b.params } }, ...blocks.slice(i + 1)]);
  };

  async function createDesign(seed?: { name: string; blocks: BlockInstance[] }) {
    const { data: row, error } = await supabase
      .from('designs')
      .insert({ name: seed?.name ?? 'Untitled design', blocks: seed?.blocks ?? [] })
      .select('*')
      .single();
    if (error) return setMsg(error.message);
    loadedFor.current = null;
    setCurrentId(row.id);
    reload();
  }
  function fromNiche(nicheId: string) {
    const n: Any = data?.niches.find((x: Any) => x.id === nicheId);
    if (!n) return;
    const m = n.card?.model;
    const seeded: BlockInstance[] = [{ uid: uid(), type: 'base_niche', params: { niche: n.id } }];
    if (n.card?.unique_angle || n.card?.summary) seeded.push({ uid: uid(), type: 'theme', params: { text: String(n.card.unique_angle ?? n.card.summary).slice(0, 160) } });
    for (const s of m?.streams ?? []) {
      seeded.push({ uid: uid(), type: 'custom_offer', params: { label: s.label, units: s.units, price: Math.round(s.price?.mode ?? 0) || undefined, per: s.sellablePerUnitPerMonth > 1 ? `${s.sellablePerUnitPerMonth} sales per unit a month` : 'per month' } });
    }
    if (m?.siteType) {
      const kind = { house: 'A house with land', commercial: 'A public-facing commercial property', estate: 'A large estate (20+ acres)' }[m.siteType as string];
      if (kind) seeded.push({ uid: uid(), type: 'site_type', params: { kind } });
    }
    createDesign({ name: `${n.name} (my version)`, blocks: seeded });
  }
  async function del() {
    if (!current) return;
    await supabase.from('designs').delete().eq('id', current.id);
    loadedFor.current = null;
    setCurrentId(null);
    setBlocks([]);
    reload();
  }
  async function research() {
    if (!current) return;
    setBusy(true);
    setMsg(null);
    try {
      await supabase.from('designs').update({ blocks, name: name.trim() || 'Untitled design' }).eq('id', current.id);
      const r: Any = await callAgent('niche-builder', { design_id: current.id });
      setMsg(r?.note ?? 'Research started.');
    } catch (e) {
      setMsg((e as Error).message);
    }
    setBusy(false);
    reload();
  }

  if (error) return <Err error={error} />;
  if (!data) return <Loading />;

  const dragCategory = drag?.type ? BLOCK[drag.type]?.category : drag?.uid ? BLOCK[blocks.find((b) => b.uid === drag.uid)?.type ?? '']?.category : undefined;
  const onDropTo = (before?: string) => (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const type = e.dataTransfer.getData('text/block-type');
    const id = e.dataTransfer.getData('text/block-uid');
    if (type) add(type, { before });
    else if (id) move(id, before);
    setDrag(null);
  };
  const needle = q.trim().toLowerCase();
  const palette = BLOCKS.filter((b) => !needle || `${b.label} ${b.hint} ${b.category}`.toLowerCase().includes(needle));

  return (
    <div className="builder">
      <div className="bd-top">
        <select value={currentId ?? ''} onChange={(e) => { loadedFor.current = null; setCurrentId(e.target.value || null); }} aria-label="Design">
          {!designs.length && <option value="">No designs yet</option>}
          {designs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <button onClick={() => createDesign()}>New design</button>
        <select value="" onChange={(e) => e.target.value && fromNiche(e.target.value)} aria-label="Start from a niche">
          <option value="">Start from a niche…</option>
          {data.niches.map((n: Any) => (
            <option key={n.id} value={n.id}>
              {n.name}
            </option>
          ))}
        </select>
        {current && (
          <>
            <input className="bd-name" value={name} onChange={(e) => { setName(e.target.value); setSaved('unsaved'); }} aria-label="Design name" />
            <small className="muted">{saved === 'saved' ? 'Saved' : 'Saving…'}</small>
            <button className="link small muted" onClick={() => createDesign({ name: `${name} (copy)`, blocks: blocks.map((b) => ({ ...b, uid: uid() })) })}>
              Duplicate
            </button>
            <button className="link small muted" onClick={del}>
              Delete
            </button>
          </>
        )}
      </div>

      {!current ? (
        <Section title="Builder">
          <p>Compose your own niche from blocks: what guests pay for, what gets built, the site, the money and how it runs. Then press Research and the agents write it up with real prices and costs, answer your questions, and screen it in every place.</p>
          <button onClick={() => createDesign()}>Start a blank design</button>
        </Section>
      ) : (
        <div className="bd-grid">
          <aside className="bd-palette" aria-label="Blocks">
            <input type="search" placeholder="Search blocks…" value={q} onChange={(e) => setQ(e.target.value)} />
            {CATEGORIES.map((c) => {
              const items = palette.filter((b) => b.category === c.key);
              if (!items.length) return null;
              return (
                <details key={c.key} open={Boolean(needle) || c.key === 'concept' || c.key === 'offers'} className={`bd-cat cat-${c.key}`}>
                  <summary>
                    {c.label} <small className="muted">{items.length}</small>
                  </summary>
                  {items.map((b) => {
                    const used = b.single && blocks.some((x) => x.type === b.type);
                    return (
                      <div
                        key={b.type}
                        className={`bd-tile cat-${b.category} ${used ? 'used' : ''}`}
                        draggable={!used}
                        onDragStart={(e) => {
                          e.dataTransfer.setData('text/block-type', b.type);
                          e.dataTransfer.effectAllowed = 'copy';
                          setDrag({ type: b.type });
                        }}
                        onDragEnd={() => setDrag(null)}
                        title={b.hint}
                      >
                        <span>
                          {b.label}
                          <small>{b.hint}</small>
                        </span>
                        <button className="icon" aria-label={`Add ${b.label}`} disabled={used} onClick={() => add(b.type)}>
                          +
                        </button>
                      </div>
                    );
                  })}
                </details>
              );
            })}
          </aside>

          <div className="bd-canvas" onDragOver={(e) => e.preventDefault()} onDrop={onDropTo()}>
            {CATEGORIES.map((c) => {
              const inZone = blocks.filter((b) => BLOCK[b.type]?.category === c.key);
              return (
                <section
                  key={c.key}
                  className={`bd-zone cat-${c.key} ${dragCategory === c.key ? 'target' : ''}`}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={onDropTo()}
                >
                  <header>
                    <b>{c.label}</b> <small className="muted">{c.hint}</small>
                  </header>
                  {inZone.length === 0 && <p className="bd-empty small muted">Drag blocks here, or press + in the list.</p>}
                  {inZone.map((b) => (
                    <BlockCard
                      key={b.uid}
                      b={b}
                      flash={flash === b.uid}
                      niches={data.niches}
                      places={data.places}
                      onParam={(k, v) => setParam(b.uid, k, v)}
                      onRemove={() => remove(b.uid)}
                      onDuplicate={() => duplicate(b.uid)}
                      onUp={() => nudge(b.uid, -1)}
                      onDown={() => nudge(b.uid, 1)}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/block-uid', b.uid);
                        e.dataTransfer.effectAllowed = 'move';
                        setDrag({ uid: b.uid });
                      }}
                      onDragEnd={() => setDrag(null)}
                      onDrop={onDropTo(b.uid)}
                    />
                  ))}
                </section>
              );
            })}
          </div>

          <aside className="bd-side">
            <Section title="Research">
              <p className="small muted">
                The agents search for real operators, prices and build costs for this exact mix, write it up as a niche with your blocks as requirements, have it checked independently, answer your
                research asks with sources, and screen it in every place. Uses AI credit (roughly $0.15–0.40 a run; see Activity).
              </p>
              <button className="primary" disabled={busy || current.status === 'researching' || !blocks.some((b) => BLOCK[b.type]?.category === 'offers')} onClick={research}>
                {current.status === 'researching' ? 'Researching…' : current.status === 'ready' || current.status === 'failed' ? 'Research again' : 'Research this design'}
              </button>
              {!blocks.some((b) => BLOCK[b.type]?.category === 'offers') && <p className="small muted">Add at least one offer first.</p>}
              {msg && <p className="small">{msg}</p>}
              <Results design={current} />
            </Section>
            <Section title="What the researcher gets">
              <pre className="bd-brief">{brief.text}</pre>
            </Section>
          </aside>
        </div>
      )}
    </div>
  );
}

function BlockCard(props: {
  b: BlockInstance;
  flash: boolean;
  niches: Any[];
  places: Any[];
  onParam: (k: string, v: unknown) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onUp: () => void;
  onDown: () => void;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onDrop: (e: DragEvent) => void;
}) {
  const def = BLOCK[props.b.type];
  if (!def) return null;
  return (
    <div
      className={`bd-block cat-${def.category} ${props.flash ? 'flash' : ''}`}
      draggable
      onDragStart={props.onDragStart}
      onDragEnd={props.onDragEnd}
      onDragOver={(e) => e.preventDefault()}
      onDrop={props.onDrop}
    >
      <div className="bd-block-head">
        <span className="bd-grip" aria-hidden>
          ⋮⋮
        </span>
        <b>{def.label}</b>
        <span className="bd-tools">
          <button className="icon" title="Move up" onClick={props.onUp}>
            ↑
          </button>
          <button className="icon" title="Move down" onClick={props.onDown}>
            ↓
          </button>
          {!def.single && (
            <button className="icon" title="Duplicate" onClick={props.onDuplicate}>
              ⧉
            </button>
          )}
          <button className="icon" title="Remove" onClick={props.onRemove}>
            ×
          </button>
        </span>
      </div>
      {def.params.length > 0 && (
        <div className="bd-params">
          {def.params.map((p) => (
            <ParamField key={p.key} p={p} value={props.b.params[p.key] ?? p.default} onChange={(v) => props.onParam(p.key, v)} niches={props.niches} places={props.places} />
          ))}
        </div>
      )}
    </div>
  );
}

function ParamField({ p, value, onChange, niches, places }: { p: Param; value: unknown; onChange: (v: unknown) => void; niches: Any[]; places: Any[] }) {
  const list = (Array.isArray(value) ? value : []) as string[];
  const toggle = (v: string) => onChange(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const chips = (opts: [string, string][]) => (
    <span className="fp-chips">
      {opts.map(([v, label]) => (
        <button key={v} className={`chip ${list.includes(v) ? 'on' : ''}`} aria-pressed={list.includes(v)} onClick={() => toggle(v)}>
          {label}
        </button>
      ))}
    </span>
  );
  let field: ReactNode;
  switch (p.type) {
    case 'number':
    case 'money':
      field = (
        <span className="bd-num">
          {p.type === 'money' && <span className="muted">$</span>}
          <input
            type="number"
            min={0}
            value={value === undefined || value === null ? '' : String(value)}
            placeholder={p.type === 'money' ? 'let research decide' : ''}
            onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          />
          {p.unit && <small className="muted">{p.unit}</small>}
        </span>
      );
      break;
    case 'text':
      field = <input type="text" value={String(value ?? '')} placeholder={p.placeholder} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'select':
      field = (
        <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          {(p.options ?? []).map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      );
      break;
    case 'bool':
      field = <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />;
      break;
    case 'multi':
      field = chips((p.options ?? []).map((o) => [o, o]));
      break;
    case 'countries':
      field = chips(COUNTRY_OPTIONS as [string, string][]);
      break;
    case 'places':
      field = chips(places.map((pl: Any) => [pl.id, pl.name]));
      break;
    case 'niche':
      field = (
        <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">Choose…</option>
          {niches.map((n: Any) => (
            <option key={n.id} value={n.id}>
              {n.name}
            </option>
          ))}
        </select>
      );
      break;
  }
  return (
    <label className={`bd-param ${p.type === 'multi' || p.type === 'places' || p.type === 'countries' ? 'wide' : ''}`}>
      <span>{p.label}</span>
      {field}
    </label>
  );
}

function Results({ design }: { design: Design }) {
  const { data } = useLoad(async () => {
    if (!design.niche_id) return null;
    const [niche, ideas] = await Promise.all([
      supabase.from('niches').select('id,name,card').eq('id', design.niche_id).maybeSingle(),
      supabase
        .from('pairings')
        .select('id,status,score_total,scores,locations(name,country_code)')
        .eq('niche_id', design.niche_id)
        .eq('status', 'candidate'),
    ]);
    return { niche: niche.data, ideas: ideas.data ?? [] };
  }, [design.niche_id, design.status, design.updated_at]);
  const r = design.research ?? {};
  const ideas = [...(data?.ideas ?? [])].sort(
    (a: Any, b: Any) => Number(b.scores?.fundable) - Number(a.scores?.fundable) || (b.scores?.target_year_figure ?? -1e9) - (a.scores?.target_year_figure ?? -1e9),
  );
  return (
    <div className="bd-results">
      <p className="small">
        <span className={`pill ${design.status}`}>{design.status === 'ready' ? 'researched' : design.status}</span>
        {r.started_at && <small className="muted"> started {new Date(r.started_at).toLocaleString()}</small>}
      </p>
      {r.error && <p className="err small">{String(r.error)}</p>}
      {r.draft && (
        <p className="small">
          Write-up {r.draft.ok ? 'passed its checks' : `failed checks: ${(r.draft.problems ?? []).join('; ')}`} · independent review: <b>{r.draft.review}</b>
          {r.draft.examplesAdded ? ` · ${r.draft.examplesAdded} real operators found` : ''}
        </p>
      )}
      {data?.niche?.card?.review?.concerns?.length > 0 && (
        <details className="small">
          <summary>Reviewer's concerns ({data.niche.card.review.concerns.length})</summary>
          <ul>
            {data.niche.card.review.concerns.map((c: string) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </details>
      )}
      {ideas.length > 0 && (
        <>
          <h4>Best places for this design</h4>
          <table className="small">
            <tbody>
              {ideas.slice(0, 8).map((p: Any) => (
                <tr key={p.id}>
                  <td>
                    <a href={`#pairing/${p.id}`}>{p.locations?.name}</a>
                  </td>
                  <td>{usd(p.scores?.target_year_figure)}/mo</td>
                  <td className={p.scores?.fundable ? 'ok' : 'err'}>{p.scores?.fundable ? 'fundable' : 'not fundable'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">Year-1 take-home per month. All of this design's ideas are on Business ideas (filter by niche: {design.name}).</p>
        </>
      )}
      {design.status === 'ready' && !ideas.length && <p className="small muted">Screening in every place is running; ideas appear here in a minute or two.</p>}
      {(r.answers ?? []).length > 0 && (
        <>
          <h4>Answers</h4>
          {r.answers.map((a: Any) => (
            <div key={a.question} className="bd-answer small">
              <b>{a.question}</b>
              <p>{a.answer}</p>
              {(a.points ?? []).length > 0 && (
                <ul>
                  {a.points.map((pt: Any, i: number) => (
                    <li key={i}>
                      {pt.claim}{' '}
                      <a href={pt.url} target="_blank" rel="noreferrer">
                        source
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </>
      )}
      {(r.questions ?? []).length > 0 && !(r.answers ?? []).length && design.status === 'researching' && <p className="small muted">Answering {r.questions.length} question(s)…</p>}
    </div>
  );
}
