import { useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * One filter system for every tab.
 *
 * Layout: a toolbar above the results (search, sort, result count, active
 * filter chips) and a slim panel on the left. The panel leads with one-click
 * views and "show only" toggles, then ratings as thresholds; everything else
 * sits in collapsed sections that open on their own when they hold an active
 * filter. Choices are kept per tab in this browser.
 */
export type FieldType = 'enum' | 'number' | 'bool' | 'text' | 'rating';

export interface Field<T> {
  key: string;
  label: string;
  type: FieldType;
  /** enum: a label or list of labels; number/rating: a number or null; bool: truthy; text: searchable words. */
  get: (row: T) => unknown;
  fmt?: (v: number) => string;
  /** Section the field sits in (collapsed by default). */
  group?: string;
  /** enum: preferred order of values. */
  order?: string[];
  /** bool: show as a one-click toggle at the top of the panel. */
  quick?: boolean;
}

export interface SortDef<T> {
  key: string;
  label: string;
  /** Best first. */
  cmp: (a: T, b: T) => number;
  /** Optional whole-list ordering (e.g. spreading results across groups); runs after cmp. */
  order?: (rows: T[]) => T[];
}

export interface FilterState {
  q: string;
  enums: Record<string, string[]>;
  ranges: Record<string, [number | null, number | null]>;
  bools: Record<string, boolean>;
  sort: string;
  reverse: boolean;
}

type Criteria = Pick<FilterState, 'enums' | 'ranges' | 'bools'>;
export interface View {
  label: string;
  criteria?: Partial<Criteria>;
}

const NONE = '(none)';
const RATING_STEPS = [4, 6, 8];

const asList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.length ? v.map(String) : [NONE];
  return v === null || v === undefined || v === '' ? [NONE] : [String(v)];
};
const asNum = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Criteria without empty entries, so equal filters compare equal. */
function clean(c: Partial<Criteria>): Criteria {
  const enums = Object.fromEntries(Object.entries(c.enums ?? {}).filter(([, v]) => v.length).map(([k, v]) => [k, [...v].sort()]));
  const ranges = Object.fromEntries(Object.entries(c.ranges ?? {}).filter(([, [a, b]]) => a !== null || b !== null));
  return { enums, ranges, bools: { ...(c.bools ?? {}) } };
}
const sameCriteria = (a: Partial<Criteria>, b: Partial<Criteria>) => JSON.stringify(sortKeys(clean(a))) === JSON.stringify(sortKeys(clean(b)));
function sortKeys(c: Criteria) {
  const o = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).sort(([x], [y]) => x.localeCompare(y)));
  return { enums: o(c.enums), ranges: o(c.ranges), bools: o(c.bools) };
}

function stored<S>(key: string, fallback: S): S {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}
function keep(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: filters still work for this visit */
  }
}

export function useFilters<T>(opts: {
  tab: string;
  fields: Field<T>[];
  rows: T[];
  sorts?: SortDef<T>[];
  /** One-click presets; the first is the default. */
  views?: View[];
  /** What the rows are called, e.g. "ideas". */
  noun?: string;
}) {
  const { tab, fields, rows, sorts = [], views = [], noun = 'items' } = opts;
  const base: Criteria = clean(views[0]?.criteria ?? {});
  const initial: FilterState = { q: '', ...base, sort: sorts[0]?.key ?? '', reverse: false };
  const [state, setState] = useState<FilterState>(() => stored(`filters3:${tab}`, initial));
  useEffect(() => keep(`filters3:${tab}`, state), [tab, state]);

  const passes = (row: T, skip?: string) => {
    if (state.q.trim()) {
      const hay = fields
        .filter((f) => f.type === 'text' || f.type === 'enum')
        .map((f) => asList(f.get(row)).join(' '))
        .join(' ')
        .toLowerCase();
      if (!state.q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))) return false;
    }
    for (const f of fields) {
      if (f.key === skip) continue;
      if (f.type === 'enum') {
        const sel = state.enums[f.key];
        if (sel && sel.length && !asList(f.get(row)).some((v) => sel.includes(v))) return false;
      } else if (f.type === 'number' || f.type === 'rating') {
        const [lo, hi] = state.ranges[f.key] ?? [null, null];
        if (lo === null && hi === null) continue;
        const v = asNum(f.get(row));
        if (v === null || (lo !== null && v < lo) || (hi !== null && v > hi)) return false;
      } else if (f.type === 'bool') {
        const want = state.bools[f.key];
        if (want !== undefined && Boolean(f.get(row)) !== want) return false;
      }
    }
    return true;
  };

  const result = useMemo(() => {
    const kept = rows.filter((r) => passes(r));
    const custom = sorts.find((s) => s.key === state.sort);
    const numField = fields.find((f) => (f.type === 'number' || f.type === 'rating') && `field:${f.key}` === state.sort);
    let cmp: ((a: T, b: T) => number) | null = custom?.cmp ?? null;
    if (!cmp && numField) cmp = (a, b) => (asNum(numField.get(b)) ?? -Infinity) - (asNum(numField.get(a)) ?? -Infinity);
    if (cmp) {
      const c = cmp;
      kept.sort((a, b) => c(a, b));
    }
    const ordered = custom?.order ? custom.order(kept) : kept;
    return state.reverse ? [...ordered].reverse() : ordered;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, state]);

  const set = (patch: Partial<FilterState>) => setState((s) => ({ ...s, ...patch }));
  const applyView = (v: View) => set({ ...clean(v.criteria ?? {}) });
  const reset = () => set({ q: '', ...base });
  const current = clean(state);
  const activeView = views.findIndex((v) => sameCriteria(v.criteria ?? {}, current));

  // Chips list only what differs from the default view, so defaults don't read as clutter.
  const chips: { label: string; clear: () => void }[] = [];
  if (state.q.trim()) chips.push({ label: `“${state.q.trim()}”`, clear: () => set({ q: '' }) });
  for (const f of fields) {
    const sel = current.enums[f.key];
    if (sel && JSON.stringify(sel) !== JSON.stringify(base.enums[f.key] ?? [])) {
      const text = sel.length > 2 ? `${sel.slice(0, 2).join(', ')} +${sel.length - 2}` : sel.join(', ');
      chips.push({ label: `${f.label}: ${text}`, clear: () => set({ enums: { ...state.enums, [f.key]: base.enums[f.key] ?? [] } }) });
    }
    const r = current.ranges[f.key];
    if (r && JSON.stringify(r) !== JSON.stringify(base.ranges[f.key])) {
      const fmt = f.fmt ?? ((n: number) => n.toLocaleString());
      const text = r[0] !== null && r[1] !== null ? `${fmt(r[0])}–${fmt(r[1])}` : r[0] !== null ? `${fmt(r[0])}+` : `≤ ${fmt(r[1]!)}`;
      chips.push({
        label: `${f.label} ${text}`,
        clear: () => {
          const { [f.key]: _drop, ...rest } = state.ranges;
          set({ ranges: base.ranges[f.key] ? { ...rest, [f.key]: base.ranges[f.key] } : rest });
        },
      });
    }
    if (current.bools[f.key] !== undefined && current.bools[f.key] !== base.bools[f.key]) {
      chips.push({
        label: current.bools[f.key] ? f.label : `Not: ${f.label}`,
        clear: () => {
          const { [f.key]: _drop, ...rest } = state.bools;
          set({ bools: rest });
        },
      });
    }
  }
  const active = chips.length;

  const sortOptions = [
    ...sorts.map((s) => ({ key: s.key, label: s.label })),
    ...fields.filter((f) => f.type === 'number' || f.type === 'rating').map((f) => ({ key: `field:${f.key}`, label: `${f.label}, high to low` })),
  ];

  const toolbar = (
    <div className="ft">
      <div className="ft-row">
        <input className="ft-search" type="search" placeholder={`Search ${noun}…`} value={state.q} onChange={(e) => set({ q: e.target.value })} />
        {sortOptions.length > 0 && (
          <span className="ft-sort">
            <select aria-label="Sort" value={state.sort} onChange={(e) => set({ sort: e.target.value })}>
              {sortOptions.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
            <button className="icon" title={state.reverse ? 'Reversed order' : 'Reverse the order'} aria-pressed={state.reverse} onClick={() => set({ reverse: !state.reverse })}>
              {state.reverse ? '↑' : '↓'}
            </button>
          </span>
        )}
        <span className="ft-count">
          <b>{result.length}</b> of {rows.length} {noun}
        </span>
      </div>
      {chips.length > 0 && (
        <div className="ft-chips">
          {chips.map((c) => (
            <button key={c.label} className="chip on" onClick={c.clear} title="Remove this filter">
              {c.label} <span aria-hidden>×</span>
            </button>
          ))}
          <button className="link small" onClick={reset}>
            Reset
          </button>
        </div>
      )}
    </div>
  );

  const panel = (
    <Panel tab={tab} fields={fields} rows={rows} views={views} activeView={activeView} applyView={applyView} state={state} set={set} passes={passes} />
  );
  return { rows: result, panel, toolbar, active, state, set, shown: result.length, noun };
}

function Panel<T>({
  tab,
  fields,
  rows,
  views,
  activeView,
  applyView,
  state,
  set,
  passes,
}: {
  tab: string;
  fields: Field<T>[];
  rows: T[];
  views: View[];
  activeView: number;
  applyView: (v: View) => void;
  state: FilterState;
  set: (p: Partial<FilterState>) => void;
  passes: (row: T, skip?: string) => boolean;
}) {
  const quick = fields.filter((f) => f.type === 'bool' && f.quick);
  const ratings = fields.filter((f) => f.type === 'rating');
  const groups = new Map<string, Field<T>[]>();
  for (const f of fields) {
    if (f.type === 'text' || f.type === 'rating' || (f.type === 'bool' && f.quick)) continue;
    const g = f.group ?? 'More';
    groups.set(g, [...(groups.get(g) ?? []), f]);
  }
  const [open, setOpen] = useState<Record<string, boolean>>(() => stored(`filters2-open:${tab}`, {}));
  useEffect(() => keep(`filters2-open:${tab}`, open), [tab, open]);
  const hasActive = (fs: Field<T>[]) =>
    fs.some((f) => (state.enums[f.key]?.length ?? 0) > 0 || state.ranges[f.key] !== undefined || state.bools[f.key] !== undefined);
  const toggleBool = (f: Field<T>) => {
    const { [f.key]: _drop, ...rest } = state.bools;
    set({ bools: state.bools[f.key] ? rest : { ...rest, [f.key]: true } });
  };

  return (
    <div className="fp">
      {views.length > 0 && (
        <section className="fp-sec">
          <h4>Views</h4>
          <div className="fp-views">
            {views.map((v, i) => (
              <button key={v.label} className={i === activeView ? 'on' : ''} aria-pressed={i === activeView} onClick={() => applyView(v)}>
                {v.label}
              </button>
            ))}
          </div>
        </section>
      )}
      {quick.length > 0 && (
        <section className="fp-sec">
          <h4>Show only</h4>
          <div className="fp-chips">
            {quick.map((f) => (
              <button key={f.key} className={`chip ${state.bools[f.key] ? 'on' : ''}`} aria-pressed={Boolean(state.bools[f.key])} onClick={() => toggleBool(f)}>
                {f.label}
              </button>
            ))}
          </div>
        </section>
      )}
      {ratings.length > 0 && (
        <section className="fp-sec">
          <h4>Ratings</h4>
          {ratings.map((f) => (
            <RatingFilter key={f.key} f={f} state={state} set={set} />
          ))}
        </section>
      )}
      {[...groups.entries()].map(([g, fs]) => {
        const isOpen = open[g] ?? hasActive(fs);
        const n = fs.filter((f) => hasActive([f])).length;
        return (
          <section key={g} className="fp-sec fp-fold">
            <button className="fp-fold-head" aria-expanded={isOpen} onClick={() => setOpen({ ...open, [g]: !isOpen })}>
              <span>{g}</span>
              {n > 0 && <span className="fp-badge">{n}</span>}
              <span className="fp-caret" aria-hidden>
                {isOpen ? '−' : '+'}
              </span>
            </button>
            {isOpen && (
              <div className="fp-fold-body">
                {fs.map((f) =>
                  f.type === 'bool' ? (
                    <button key={f.key} className={`chip ${state.bools[f.key] ? 'on' : ''}`} aria-pressed={Boolean(state.bools[f.key])} onClick={() => toggleBool(f)}>
                      {f.label}
                    </button>
                  ) : f.type === 'number' ? (
                    <RangeFilter key={f.key} f={f} rows={rows} state={state} set={set} />
                  ) : (
                    <EnumFilter key={f.key} f={f} rows={rows} state={state} set={set} passes={passes} />
                  ),
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function RatingFilter<T>({ f, state, set }: { f: Field<T>; state: FilterState; set: (p: Partial<FilterState>) => void }) {
  const min = state.ranges[f.key]?.[0] ?? null;
  const pick = (v: number | null) => {
    const { [f.key]: _drop, ...rest } = state.ranges;
    set({ ranges: v === null ? rest : { ...rest, [f.key]: [v, null] } });
  };
  return (
    <div className="fp-rating">
      <span>{f.label}</span>
      <span className="seg" role="group" aria-label={f.label}>
        <button className={min === null ? 'on' : ''} onClick={() => pick(null)}>
          Any
        </button>
        {RATING_STEPS.map((s) => (
          <button key={s} className={min === s ? 'on' : ''} onClick={() => pick(s)}>
            {s}+
          </button>
        ))}
      </span>
    </div>
  );
}

function RangeFilter<T>({ f, rows, state, set }: { f: Field<T>; rows: T[]; state: FilterState; set: (p: Partial<FilterState>) => void }) {
  const vals = rows.map((r) => asNum(f.get(r))).filter((v): v is number => v !== null);
  const fmt = f.fmt ?? ((n: number) => (Math.round(n * 100) / 100).toLocaleString());
  const [lo, hi] = state.ranges[f.key] ?? [null, null];
  if (!vals.length) return null;
  const put = (i: 0 | 1, raw: string) => {
    const next: [number | null, number | null] = [lo, hi];
    next[i] = raw === '' || !Number.isFinite(Number(raw)) ? null : Number(raw);
    const { [f.key]: _drop, ...rest } = state.ranges;
    set({ ranges: next[0] === null && next[1] === null ? rest : { ...rest, [f.key]: next } });
  };
  return (
    <div className="fp-range">
      <span className="fp-range-label">{f.label}</span>
      <span className="fp-range-inputs">
        <input type="number" inputMode="decimal" aria-label={`${f.label} minimum`} placeholder={fmt(Math.min(...vals))} value={lo ?? ''} onChange={(e) => put(0, e.target.value)} />
        <span aria-hidden>–</span>
        <input type="number" inputMode="decimal" aria-label={`${f.label} maximum`} placeholder={fmt(Math.max(...vals))} value={hi ?? ''} onChange={(e) => put(1, e.target.value)} />
      </span>
    </div>
  );
}

function EnumFilter<T>({
  f,
  rows,
  state,
  set,
  passes,
}: {
  f: Field<T>;
  rows: T[];
  state: FilterState;
  set: (p: Partial<FilterState>) => void;
  passes: (row: T, skip?: string) => boolean;
}) {
  const [all, setAll] = useState(false);
  // Counts reflect every other active filter, so you see what each choice would leave.
  const counts = new Map<string, number>();
  for (const r of rows) for (const v of asList(f.get(r))) if (!counts.has(v)) counts.set(v, 0);
  for (const r of rows) if (passes(r, f.key)) for (const v of asList(f.get(r))) counts.set(v, (counts.get(v) ?? 0) + 1);
  const sel = state.enums[f.key] ?? [];
  const order = f.order ?? [];
  const values = [...counts.keys()]
    .filter((v) => (counts.get(v) ?? 0) > 0 || sel.includes(v))
    .sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
      return (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b);
    });
  if (values.length < 2 && !sel.length) return null;
  const toggle = (v: string) => set({ enums: { ...state.enums, [f.key]: sel.includes(v) ? sel.filter((x) => x !== v) : [...sel, v] } });
  const limit = 6;
  const visible = all ? values : values.slice(0, limit);
  return (
    <div className="fp-enum">
      <span className="fp-enum-label">{f.label}</span>
      <div className="fp-chips">
        {visible.map((v) => (
          <button key={v} className={`chip ${sel.includes(v) ? 'on' : ''}`} aria-pressed={sel.includes(v)} onClick={() => toggle(v)}>
            {v} <small>{counts.get(v)}</small>
          </button>
        ))}
        {values.length > limit && (
          <button className="link small" onClick={() => setAll(!all)}>
            {all ? 'Less' : `+${values.length - limit} more`}
          </button>
        )}
      </div>
    </div>
  );
}

/** A 0–10 score filtered by threshold (Any, 4+, 6+, 8+), listed under Ratings. */
export function ratingField<T>(key: string, label: string, get: (row: T) => unknown): Field<T> {
  return { key: `rating:${key}`, label, type: 'rating', get };
}

/**
 * Page layout: the panel on the left, toolbar above the results. On wide
 * screens the panel can be hidden; on narrow screens it opens as a drawer.
 */
export function FilterLayout({
  f,
  children,
}: {
  f: { panel: ReactNode; toolbar: ReactNode; active: number; shown: number; noun: string };
  children: ReactNode;
}) {
  const [hidden, setHidden] = useState<boolean>(() => stored('filters2-hidden', { v: false }).v);
  const [drawer, setDrawer] = useState(false);
  useEffect(() => keep('filters2-hidden', { v: hidden }), [hidden]);
  return (
    <div className={`fl ${hidden ? 'fl-hidden' : ''}`}>
      <aside className={`fl-panel ${drawer ? 'open' : ''}`} aria-label="Filters">
        <div className="fl-panel-head">
          <b>Filters</b>
          <button className="link small fl-desk" onClick={() => setHidden(true)}>
            Hide
          </button>
          <button className="link small fl-mob" onClick={() => setDrawer(false)}>
            Close
          </button>
        </div>
        {f.panel}
        <button className="fl-done fl-mob" onClick={() => setDrawer(false)}>
          Show {f.shown} {f.noun}
        </button>
      </aside>
      {drawer && <div className="fl-scrim" onClick={() => setDrawer(false)} />}
      <div className="fl-main">
        <div className="fl-top">
          <button className={`fl-open ${hidden ? '' : 'fl-mob-only'}`} onClick={() => (window.matchMedia('(max-width: 860px)').matches ? setDrawer(true) : setHidden(false))}>
            Filters{f.active ? ` · ${f.active}` : ''}
          </button>
          {f.toolbar}
        </div>
        {children}
      </div>
    </div>
  );
}
