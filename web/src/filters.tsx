import { useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * One filter system for every tab: each page lists the fields its rows have,
 * and the left panel builds search, sort, checkbox lists (with counts),
 * min/max ranges and yes/no switches from them. Choices are kept per tab in
 * this browser.
 */
export type FieldType = 'enum' | 'number' | 'bool' | 'text';

export interface Field<T> {
  key: string;
  label: string;
  type: FieldType;
  /** enum: a label or list of labels; number: a number or null; bool: truthy; text: searchable words. */
  get: (row: T) => unknown;
  fmt?: (v: number) => string;
  /** Heading the field sits under in the panel. */
  group?: string;
  /** enum: preferred order of values. */
  order?: string[];
}

export interface SortDef<T> {
  key: string;
  label: string;
  /** Best first. */
  cmp: (a: T, b: T) => number;
}

export interface FilterState {
  q: string;
  enums: Record<string, string[]>;
  ranges: Record<string, [number | null, number | null]>;
  bools: Record<string, boolean>;
  sort: string;
  reverse: boolean;
}

const NONE = '(none)';
const empty = (sort: string): FilterState => ({ q: '', enums: {}, ranges: {}, bools: {}, sort, reverse: false });

function load(tab: string, fallback: FilterState): FilterState {
  try {
    const raw = localStorage.getItem(`filters:${tab}`);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

const asList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.length ? v.map(String) : [NONE];
  return v === null || v === undefined || v === '' ? [NONE] : [String(v)];
};
const asNum = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export function useFilters<T>(opts: {
  tab: string;
  fields: Field<T>[];
  rows: T[];
  sorts?: SortDef<T>[];
  defaults?: Partial<FilterState>;
}) {
  const { tab, fields, rows, sorts = [] } = opts;
  const firstSort = sorts[0]?.key ?? '';
  const defaults: FilterState = { ...empty(firstSort), ...opts.defaults };
  const [state, setState] = useState<FilterState>(() => load(tab, defaults));
  useEffect(() => {
    try {
      localStorage.setItem(`filters:${tab}`, JSON.stringify(state));
    } catch {
      /* storage unavailable: filters still work for this visit */
    }
  }, [tab, state]);

  const passes = (row: T, skip?: string) => {
    if (state.q.trim() && skip !== '__q') {
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
      } else if (f.type === 'number') {
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
    const numField = fields.find((f) => f.type === 'number' && `field:${f.key}` === state.sort);
    let cmp: ((a: T, b: T) => number) | null = custom?.cmp ?? null;
    if (!cmp && numField) {
      cmp = (a, b) => (asNum(numField.get(b)) ?? -Infinity) - (asNum(numField.get(a)) ?? -Infinity);
    }
    if (cmp) {
      const c = cmp;
      kept.sort((a, b) => (state.reverse ? -c(a, b) : c(a, b)));
    }
    return kept;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, state]);

  const active =
    (state.q.trim() ? 1 : 0) +
    Object.values(state.enums).filter((v) => v.length).length +
    Object.values(state.ranges).filter(([a, b]) => a !== null || b !== null).length +
    Object.keys(state.bools).length;

  const set = (patch: Partial<FilterState>) => setState((s) => ({ ...s, ...patch }));
  const reset = () => setState({ ...defaults, sort: state.sort, reverse: state.reverse });

  const chips: { label: string; clear: () => void }[] = [];
  if (state.q.trim()) chips.push({ label: `“${state.q.trim()}”`, clear: () => set({ q: '' }) });
  for (const f of fields) {
    const sel = state.enums[f.key];
    if (sel?.length) chips.push({ label: `${f.label}: ${sel.join(', ')}`, clear: () => set({ enums: { ...state.enums, [f.key]: [] } }) });
    const r = state.ranges[f.key];
    if (r && (r[0] !== null || r[1] !== null)) {
      const fmt = f.fmt ?? ((n: number) => n.toLocaleString());
      const text = r[0] !== null && r[1] !== null ? `${fmt(r[0])}–${fmt(r[1])}` : r[0] !== null ? `≥ ${fmt(r[0])}` : `≤ ${fmt(r[1]!)}`;
      chips.push({
        label: `${f.label} ${text}`,
        clear: () => {
          const { [f.key]: _, ...rest } = state.ranges;
          set({ ranges: rest });
        },
      });
    }
    if (state.bools[f.key] !== undefined) {
      chips.push({
        label: `${f.label}: ${state.bools[f.key] ? 'yes' : 'no'}`,
        clear: () => {
          const { [f.key]: _, ...rest } = state.bools;
          set({ bools: rest });
        },
      });
    }
  }

  const summary = (
    <div className="filter-summary small">
      <span className="muted">
        Showing <b>{result.length}</b> of {rows.length}
      </span>
      {chips.map((c) => (
        <button key={c.label} className="chip" onClick={c.clear} title="Remove this filter">
          {c.label} ×
        </button>
      ))}
      {active > 0 && (
        <button className="link small" onClick={reset}>
          Clear all
        </button>
      )}
    </div>
  );

  const panel = <Panel fields={fields} rows={rows} sorts={sorts} state={state} set={set} reset={reset} active={active} passes={passes} shown={result.length} />;
  return { rows: result, panel, summary, active, state, set };
}

function Panel<T>({
  fields,
  rows,
  sorts,
  state,
  set,
  reset,
  active,
  passes,
  shown,
}: {
  fields: Field<T>[];
  rows: T[];
  sorts: SortDef<T>[];
  state: FilterState;
  set: (p: Partial<FilterState>) => void;
  reset: () => void;
  active: number;
  passes: (row: T, skip?: string) => boolean;
  shown: number;
}) {
  const groups = new Map<string, Field<T>[]>();
  for (const f of fields) {
    if (f.type === 'text') continue;
    const g = f.group ?? 'More';
    groups.set(g, [...(groups.get(g) ?? []), f]);
  }
  const numFields = fields.filter((f) => f.type === 'number');
  return (
    <div className="filter-panel">
      <div className="fp-head">
        <b>Filters{active ? ` (${active})` : ''}</b>
        {active > 0 && (
          <button className="link small" onClick={reset}>
            Clear all
          </button>
        )}
      </div>
      <input type="search" placeholder="Search…" value={state.q} onChange={(e) => set({ q: e.target.value })} />
      {(sorts.length > 0 || numFields.length > 0) && (
        <label className="fp-sort small">
          Sort by
          <span>
            <select value={state.sort} onChange={(e) => set({ sort: e.target.value })}>
              {sorts.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
              {numFields.map((f) => (
                <option key={f.key} value={`field:${f.key}`}>
                  {f.label} (high to low)
                </option>
              ))}
            </select>
            <button className="small" title="Reverse the order" onClick={() => set({ reverse: !state.reverse })}>
              {state.reverse ? '↑' : '↓'}
            </button>
          </span>
        </label>
      )}
      <p className="small muted fp-count">
        {shown} of {rows.length} shown
      </p>
      {[...groups.entries()].map(([g, fs]) => (
        <details key={g} open className="fp-group">
          <summary>{g}</summary>
          {fs.map((f) =>
            f.type === 'bool' ? (
              <BoolFilter key={f.key} f={f} state={state} set={set} />
            ) : f.type === 'number' ? (
              <RangeFilter key={f.key} f={f} rows={rows} state={state} set={set} />
            ) : (
              <EnumFilter key={f.key} f={f} rows={rows} state={state} set={set} passes={passes} />
            ),
          )}
        </details>
      ))}
    </div>
  );
}

function BoolFilter<T>({ f, state, set }: { f: Field<T>; state: FilterState; set: (p: Partial<FilterState>) => void }) {
  const v = state.bools[f.key];
  const choose = (next: boolean | undefined) => {
    const { [f.key]: _, ...rest } = state.bools;
    set({ bools: next === undefined ? rest : { ...rest, [f.key]: next } });
  };
  return (
    <div className="fp-bool small">
      <span>{f.label}</span>
      <span className="seg">
        <button className={v === undefined ? 'on' : ''} onClick={() => choose(undefined)}>
          Any
        </button>
        <button className={v === true ? 'on' : ''} onClick={() => choose(true)}>
          Yes
        </button>
        <button className={v === false ? 'on' : ''} onClick={() => choose(false)}>
          No
        </button>
      </span>
    </div>
  );
}

function RangeFilter<T>({ f, rows, state, set }: { f: Field<T>; rows: T[]; state: FilterState; set: (p: Partial<FilterState>) => void }) {
  const vals = rows.map((r) => asNum(f.get(r))).filter((v): v is number => v !== null);
  const fmt = f.fmt ?? ((n: number) => (Math.round(n * 100) / 100).toLocaleString());
  const [lo, hi] = state.ranges[f.key] ?? [null, null];
  const put = (i: 0 | 1, raw: string) => {
    const next: [number | null, number | null] = [lo, hi];
    next[i] = raw === '' || !Number.isFinite(Number(raw)) ? null : Number(raw);
    const { [f.key]: _, ...rest } = state.ranges;
    set({ ranges: next[0] === null && next[1] === null ? rest : { ...rest, [f.key]: next } });
  };
  return (
    <div className="fp-range small">
      <span>
        {f.label}
        {vals.length > 0 && (
          <small className="muted">
            {' '}
            {fmt(Math.min(...vals))} to {fmt(Math.max(...vals))}
          </small>
        )}
      </span>
      <span className="pair">
        <input type="number" placeholder="min" value={lo ?? ''} onChange={(e) => put(0, e.target.value)} />
        <input type="number" placeholder="max" value={hi ?? ''} onChange={(e) => put(1, e.target.value)} />
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
  for (const r of rows) for (const v of asList(f.get(r))) counts.set(v, counts.get(v) ?? 0);
  for (const r of rows) if (passes(r, f.key)) for (const v of asList(f.get(r))) counts.set(v, (counts.get(v) ?? 0) + 1);
  const order = f.order ?? [];
  const values = [...counts.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
    return (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b);
  });
  const sel = state.enums[f.key] ?? [];
  const toggle = (v: string) => set({ enums: { ...state.enums, [f.key]: sel.includes(v) ? sel.filter((x) => x !== v) : [...sel, v] } });
  const visible = all ? values : values.slice(0, 8);
  if (!values.length) return null;
  return (
    <div className="fp-enum small">
      <span className="fp-label">
        {f.label}
        {sel.length > 0 && (
          <button className="link small" onClick={() => set({ enums: { ...state.enums, [f.key]: [] } })}>
            any
          </button>
        )}
      </span>
      {visible.map((v) => (
        <label key={v} className={counts.get(v) ? '' : 'muted'}>
          <input type="checkbox" checked={sel.includes(v)} onChange={() => toggle(v)} />
          <span className="fp-val">{v}</span>
          <small className="muted">{counts.get(v)}</small>
        </label>
      ))}
      {values.length > 8 && (
        <button className="link small" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${values.length}`}
        </button>
      )}
    </div>
  );
}

/** Page layout with the filter panel on the left (a toggle on small screens). */
export function FilterLayout({ panel, active, children }: { panel: ReactNode; active: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="with-filters">
      <button className="fp-toggle" onClick={() => setOpen(!open)}>
        {open ? 'Hide filters' : `Filters${active ? ` (${active})` : ''}`}
      </button>
      <aside className={open ? 'open' : ''}>{panel}</aside>
      <div className="fp-main">{children}</div>
    </div>
  );
}
