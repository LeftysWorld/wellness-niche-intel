// Building blocks for a business idea's page: what the business is, what you'd
// own, what guests get, which ownership plan, and the money at a glance.
import { useState, type ReactNode } from 'react';
import { usd } from './supabase.ts';
import type { FeatureView } from '../../supabase/functions/_shared/concept.ts';
import { DEFAULT_WEIGHTS } from '../../supabase/functions/_shared/scoring.ts';
import { KIND_LABEL } from '../../supabase/functions/_shared/demand.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export const TENURE_NAME: Record<string, string> = { own: 'Own land & build', ground: 'Rent land, build your own', lease: 'Lease an existing property' };
const TENURE_DESC: Record<string, string> = {
  own: 'Buy the land and build every structure, and your home. The property is yours when you sell.',
  ground: 'Long-term land lease; you own the buildings but not the land.',
  lease: 'Rent a property and convert it. Least cash, but no land or building equity.',
};

export function Block({ id, title, aside, children }: { id: string; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="ip-block" aria-labelledby={`${id}-h`}>
      <div className="ip-block-head">
        <h2 id={`${id}-h`}>{title}</h2>
        {aside && <div className="muted small">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

export function PageNav({ items }: { items: [string, string][] }) {
  return (
    <nav className="ip-nav" aria-label="On this page">
      {items.map(([id, label]) => (
        <a key={id} href={`#${id}`} onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); }}>
          {label}
        </a>
      ))}
    </nav>
  );
}

/** What the business is: the pitch, who comes, and a guest's visit. */
export function ConceptBlock({ concept, fallback, place, describe }: { concept: Any; fallback: string; place: { summary?: string; name?: string }; describe: ReactNode }) {
  if (!concept) {
    return (
      <div className="ip-card ip-concept">
        <div>
          <p className="ip-eyebrow">The business</p>
          <p className="ip-lead">{fallback || 'No description yet.'}</p>
          <p className="banner warn small">
            This niche has no plain description yet: what a guest's visit looks like, what you would build, and what guests get beyond the priced offers. Draft one from its write-up
            (takes about a minute).
          </p>
          {describe}
        </div>
      </div>
    );
  }
  return (
    <div className="ip-card ip-concept">
      <div className="ip-concept-main">
        <p className="ip-eyebrow">The business in one minute</p>
        <p className="ip-lead">{concept.pitch}</p>
        <p>{concept.overview}</p>
        <div className="ip-facts">
          <div>
            <small>Who comes</small>
            <b>{concept.who}</b>
          </div>
          <div>
            <small>Why {place.name ?? 'here'}</small>
            <b>{place.summary ?? 'Not matched against your description yet.'}</b>
          </div>
        </div>
      </div>
      <div>
        <p className="ip-eyebrow">A guest's visit</p>
        <ol className="ip-journey">
          {(concept.journey ?? []).map((s: Any, i: number) => (
            <li key={i}>
              <span>{i + 1}</span>
              <div>
                <b>{s.title}</b> <span className="muted">{s.text}</span>
              </div>
            </li>
          ))}
        </ol>
        <p className="muted small">{describe}</p>
      </div>
    </div>
  );
}

/** What you'd own: priced startup lines, unpriced assets from the description, and your home. */
export function OwnBlock({ lines, contingency, buffer, assets, home }: { lines: { key: string; label: string; p50: number }[]; contingency: number; buffer: number; assets: { name: string; note: string }[]; home: ReactNode }) {
  const priced = lines.map((l) => l.label.toLowerCase());
  const unpriced = assets.filter((a) => !priced.some((p) => p.includes(a.name.toLowerCase().split(/[ ,]/)[0])));
  return (
    <>
      <div className="ip-grid4">
        {lines.map((l) => (
          <div key={l.key} className="ip-card ip-asset">
            <div className="ip-row">
              <b>{l.label}</b>
              <span className="pill ok">In model</span>
            </div>
            <span className="ip-num">{usd(l.p50)}</span>
          </div>
        ))}
        <div className="ip-card ip-asset">
          <div className="ip-row">
            <b>Contingency and opening buffer</b>
            <span className="pill ok">In model</span>
          </div>
          <span className="ip-num">{usd(contingency + buffer)}</span>
          <small className="muted">
            {usd(contingency)} contingency + {usd(buffer)} buffer
          </small>
        </div>
        {unpriced.map((a) => (
          <div key={a.name} className="ip-card ip-asset">
            <div className="ip-row">
              <b>{a.name}</b>
              <span className="pill warn">Not priced</span>
            </div>
            <small className="muted">{a.note}</small>
          </div>
        ))}
      </div>
      {home}
    </>
  );
}

export function FeaturesBlock({ features }: { features: FeatureView[] }) {
  return (
    <div className="ip-grid3">
      {features.map((f) => (
        <div key={f.name} className="ip-card ip-feature">
          <div className="ip-row">
            <b>{f.name}</b>
            {f.priced ? <span className="pill ip-priced">Priced</span> : <span className="pill ip-proposed">Proposed</span>}
          </div>
          {f.what && <p className="small">{f.what}</p>}
          <div className="ip-pair small">
            <div>
              <small>Earns</small>
              <b>{f.earns || '—'}</b>
            </div>
            <div>
              <small>Needs</small>
              <b>{f.needs || '—'}</b>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function PlanPicker({ options, value, onChange, preferred }: { options: { tenure: string; cash: number; y1: number; open: number; fundable: boolean }[]; value: string; onChange: (t: string) => void; preferred?: string }) {
  return (
    <div role="radiogroup" aria-label="Ownership plan" className="ip-grid3">
      {options.map((o) => (
        <button key={o.tenure} type="button" role="radio" aria-checked={o.tenure === value} className={`ip-plan${o.tenure === value ? ' on' : ''}`} onClick={() => onChange(o.tenure)}>
          <span className="ip-row">
            <b>{TENURE_NAME[o.tenure] ?? o.tenure}</b>
            {o.tenure === preferred && <small className="ok">Your preference</small>}
            {!o.fundable && <small className="err">Not fundable</small>}
          </span>
          <span className="small muted">{TENURE_DESC[o.tenure]}</span>
          <span className="ip-pair3 small">
            <span>
              <small>Your cash</small>
              <b>{usd(o.cash)}</b>
            </span>
            <span>
              <small>Year 1 /mo</small>
              <b>{usd(o.y1)}</b>
            </span>
            <span>
              <small>Opens in</small>
              <b>{o.open} mo</b>
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function Kpi({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'ok' | 'err' }) {
  return (
    <div className="ip-card ip-kpi">
      <small>{label}</small>
      <b className={tone ?? ''}>{value}</b>
      {sub && <small>{sub}</small>}
    </div>
  );
}

/** Bad, middle and good take-home for years 1, 3 and 5 on one scale. */
export function RangeBars({ r, target }: { r: Any; target: number }) {
  const rows = [
    ['Year 1', r.year1.takeHome],
    ['Year 3', r.year3.takeHome],
    ['Year 5', r.year5.takeHome],
  ] as const;
  const lo = Math.min(0, ...rows.map(([, t]) => t.p10));
  const hi = Math.max(target, ...rows.map(([, t]) => t.p90)) * 1.08;
  const x = (v: number) => `${((v - lo) / (hi - lo)) * 100}%`;
  return (
    <div className="ip-ranges">
      {rows.map(([label, t]) => (
        <div key={label} className="ip-range">
          <b>{label}</b>
          <div className="ip-track" role="img" aria-label={`${label}: ${usd(t.p10)} to ${usd(t.p90)}, middle ${usd(t.p50)}`}>
            <span className="ip-target" style={{ left: x(target) }} />
            <span className="ip-band" style={{ left: x(t.p10), width: `calc(${x(t.p90)} - ${x(t.p10)})` }} />
            <span className="ip-dot" style={{ left: x(t.p50) }} />
          </div>
          <span className="small">
            <b>{usd(t.p50)}</b> <span className="muted">({usd(t.p10)} – {usd(t.p90)})</span>
          </span>
        </div>
      ))}
      <p className="muted small">Monthly take-home after loan payments and income tax. The thin line is your {usd(target)} goal.</p>
    </div>
  );
}

const PART_LABEL: Record<string, string> = { money: 'Money', growth: 'Growth', capital: 'Capital', workload: 'Workload', demand: 'Demand', place: 'Place match', visa: 'Visa', risk: 'Country risk', evidence: 'Evidence' };

/** The fit score, part by part, with each part's weight. */
export function ScoreParts({ parts, total, sourced }: { parts: Record<string, number> | undefined; total: number | null; sourced: number }) {
  if (!parts) return <p className="muted small">The score's parts are saved when the idea is screened; screen it again to see them.</p>;
  const keys = Object.keys(DEFAULT_WEIGHTS).filter((k) => typeof parts[k] === 'number');
  return (
    <div className="ip-score">
      <div className="ip-row">
        <b>Why it scores {total ?? '—'}</b>
        {sourced < 0.5 && <span className="pill warn">Provisional until half the inputs are sourced</span>}
      </div>
      {keys.map((k) => (
        <div key={k} className="ip-score-row small">
          <span>
            {PART_LABEL[k] ?? k} <span className="muted">{Math.round(DEFAULT_WEIGHTS[k as keyof typeof DEFAULT_WEIGHTS] * 100)}%</span>
          </span>
          <span className="ip-track thin">
            <span className="ip-fill" style={{ width: `${Math.max(0, Math.min(10, parts[k])) * 10}%` }} />
          </span>
          <b>{parts[k].toFixed(1)}</b>
        </div>
      ))}
      <p className="muted small">Money carries the most weight and rests on the booking rates, so a pilot can move the score more than any other input.</p>
    </div>
  );
}

export function Warnings({ items }: { items: string[] }) {
  if (!items.length) return <p className="small ok">No warnings from the checks.</p>;
  return (
    <ul className="ip-warn">
      {items.map((w) => (
        <li key={w}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
          </svg>
          <span>{w}</span>
        </li>
      ))}
    </ul>
  );
}

/** A collapsible group for the detailed tables. */
export function Fold({ title, children, open = false }: { title: string; children: ReactNode; open?: boolean }) {
  const [on, setOn] = useState(open);
  return (
    <section className="ip-fold">
      <button type="button" aria-expanded={on} onClick={() => setOn(!on)}>
        <span>{title}</span>
        <span aria-hidden="true">{on ? '−' : '+'}</span>
      </button>
      {on && <div className="ip-fold-body">{children}</div>}
    </section>
  );
}

const LEVEL_TONE: Record<string, string> = { strong: 'ok', moderate: 'warn', weak: 'bad', unclear: '' };

function DemandScope({ title, question, score, summary, signals }: { title: string; question: string; score: Any; summary?: string; signals: Any[] }) {
  return (
    <div className="ip-card ip-demand">
      <div className="ip-row">
        <div>
          <h3>{title}</h3>
          <p className="muted small">{question}</p>
        </div>
        <span className={`pill ${LEVEL_TONE[score.level] ?? ''}`}>{score.level}</span>
      </div>
      <div className="ip-gauge">
        <span className="ip-track">
          <span className="ip-fill" style={{ width: `${score.score * 10}%` }} />
        </span>
        <b>{score.score.toFixed(1)}/10</b>
      </div>
      <p className="muted small">
        {score.signals} signal{score.signals === 1 ? '' : 's'} from {score.sources} independent site{score.sources === 1 ? '' : 's'} · confidence {score.confidence}
      </p>
      {summary && <p className="small">{summary}</p>}
      <ul className="ip-signals">
        {signals.map((s, i) => (
          <li key={i} className={s.direction}>
            <span className="ip-dir" aria-label={s.direction === 'for' ? 'for' : 'against'}>
              {s.direction === 'for' ? '+' : '−'}
            </span>
            <span>
              <b>{KIND_LABEL[s.kind as keyof typeof KIND_LABEL] ?? s.kind}.</b> {s.finding}{' '}
              <a href={s.url} target="_blank" rel="noreferrer">
                source
              </a>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Demand pull: is this wanted at all, and by people within reach of this place? */
export function DemandBlock({ demand, nicheScore, nicheEvidence }: { demand: Any; nicheScore?: number; nicheEvidence?: string }) {
  if (!demand) {
    return (
      <div className="ip-card">
        <p className="banner warn small">
          Demand pull has not been researched for this place yet. A full analysis has the analyst look for evidence that people already want this, in the market and within reach
          of this place, and scores it from what it finds.
        </p>
        {typeof nicheScore === 'number' && (
          <p className="small">
            <b>General demand for this kind of business: {nicheScore}/10</b> <span className="muted">(from the niche write-up, not this place)</span>
            {nicheEvidence ? ` ${nicheEvidence}` : ''}
          </p>
        )}
      </div>
    );
  }
  const signals: Any[] = demand.signals ?? [];
  return (
    <>
      <div className="ip-card ip-row ip-demand-sum">
        <span>
          <b>Overall demand pull {demand.overall.toFixed(1)}/10</b> <span className="muted small">(area counts 60%, market 40%)</span>
        </span>
        <span className={`pill ${LEVEL_TONE[demand.level] ?? ''}`}>{demand.level}</span>
      </div>
      <div className="ip-split even">
        <DemandScope title="In the market" question="Is this kind of business wanted, and is that growing?" score={demand.market} summary={demand.market_summary} signals={signals.filter((s) => s.scope === 'market')} />
        <DemandScope title="In this area" question="Do people within reach of this place want it?" score={demand.area} summary={demand.area_summary} signals={signals.filter((s) => s.scope === 'area')} />
      </div>
      {(demand.unknowns ?? []).length > 0 && (
        <div className="ip-card">
          <h3>Still unknown about demand</h3>
          <ul className="small">
            {demand.unknowns.map((u: string) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/** The independent re-check: what it found for each input, and where it disagrees. */
export function RedTeamPanel({ redTeam }: { redTeam: Any }) {
  const findings: Any[] = redTeam.findings ?? [];
  const flagged = findings.filter((f) => f.flagged).length;
  const fmt = (key: string, v: number | null) => (v === null ? '—' : key.startsWith('occupancy.') ? `${Math.round(v * 100)}%` : usd(v));
  return (
    <div className="ip-card">
      <div className="ip-row">
        <h3>Independent check</h3>
        <span className={`pill ${flagged ? 'warn' : 'ok'}`}>{flagged ? `${flagged} gap${flagged === 1 ? '' : 's'} over 25%` : 'No big gaps'}</span>
      </div>
      <p className="small muted">A second agent re-researched these inputs without seeing the analyst's sources. Gaps lower the confidence and go to the next analysis to reconcile.</p>
      {redTeam.summary && <p className="small">{redTeam.summary}</p>}
      <table>
        <thead>
          <tr>
            <th>Input</th>
            <th>Analysis used</th>
            <th>Check found</th>
            <th>Gap</th>
            <th>Sources</th>
          </tr>
        </thead>
        <tbody>
          {findings.map((f) => (
            <tr key={f.key} className={f.flagged ? 'ip-flag' : ''}>
              <td>{f.label}</td>
              <td>{fmt(f.key, f.current)}</td>
              <td>{fmt(f.key, f.found)}</td>
              <td className={f.flagged ? 'err' : 'muted'}>{f.gap === null ? 'not found' : `${Math.round(f.gap * 100)}%`}</td>
              <td className="small">
                {(f.urls ?? []).map((u: string, i: number) => (
                  <a key={u} href={u} target="_blank" rel="noreferrer">
                    {i ? ' · ' : ''}
                    {i + 1}
                  </a>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {(redTeam.not_checked ?? []).length > 0 && <p className="small muted">Not checked: {redTeam.not_checked.join('; ')}</p>}
    </div>
  );
}

/** Rules and permits: sourced from official pages, with the write-up's unsourced list as leads. */
export function RulesPanel({ rules, permits }: { rules: Any[] | null; permits: string[] }) {
  const sourced = rules ?? [];
  if (!sourced.length && !permits.length) return null;
  return (
    <div className="ip-card">
      <h3>Rules and permits</h3>
      {sourced.length > 0 ? (
        <ul className="ip-signals">
          {sourced.map((r, i) => (
            <li key={i} className="for">
              <span className="ip-dir" aria-hidden="true">
                ✓
              </span>
              <span>
                <b>{r.agency}.</b> {r.requirement}{' '}
                <a href={r.url} target="_blank" rel="noreferrer">
                  official source
                </a>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="banner warn small">Not yet confirmed on official pages. A full analysis records who permits this business here and what they require.</p>
      )}
      {permits.length > 0 && (
        <p className="small muted">
          From the niche write-up (unsourced, may be out of date): {permits.join('; ')}
        </p>
      )}
    </div>
  );
}
