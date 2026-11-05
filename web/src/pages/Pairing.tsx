import { useMemo, useState } from 'react';
import { analyze } from '../../../supabase/functions/_shared/engine/index.ts';
import type { AnalysisResult, BusinessModel, Tri } from '../../../supabase/functions/_shared/engine/types.ts';
import { callAgent, supabase, usd } from '../supabase.ts';
import { Err, Loading, RunButton, Section, useLoad } from '../ui.tsx';

const scale = (t: Tri, k: number): Tri => ({ low: t.low * k, mode: t.mode * k, high: t.high * k });
const capOcc = (t: Tri, k: number): Tri => ({ low: Math.min(0.95, t.low * k), mode: Math.min(0.95, t.mode * k), high: Math.min(0.95, t.high * k) });

interface WhatIf {
  price: number;
  occupancy: number;
  fixed: number;
  staffing: number;
  startup: number;
}

function applyWhatIf(m: BusinessModel, w: WhatIf): BusinessModel {
  const flat = (s: BusinessModel['streams'][number]) => s.units * s.sellablePerUnitPerMonth <= 1;
  return {
    ...m,
    startupCosts: m.startupCosts.map((c) => ({ ...c, amount: scale(c.amount, w.startup) })),
    streams: m.streams.map((s) => ({
      ...s,
      price: scale(s.price, w.price),
      matureOccupancy: flat(s) ? s.matureOccupancy : capOcc(s.matureOccupancy, w.occupancy),
      startOccupancy: flat(s) ? s.startOccupancy : capOcc(s.startOccupancy, w.occupancy),
    })),
    costs: {
      ...m.costs,
      fixed: m.costs.fixed.map((f) => ({ ...f, amount: scale(f.amount, w.fixed) })),
      staffing: m.costs.staffing.map((f) => ({ ...f, amount: scale(f.amount, w.staffing) })),
    },
  };
}

function Snapshots({ r }: { r: AnalysisResult }) {
  const rows = [
    ['Year 1 (month 12)', r.month12],
    ['Year 3 (month 36)', r.month36],
    ['Year 5 (month 60)', r.month60],
  ] as const;
  return (
    <table>
      <thead>
        <tr>
          <th>Monthly</th>
          <th>Revenue P50</th>
          <th>Costs P50</th>
          <th>Profit P10</th>
          <th>Profit P50</th>
          <th>Profit P90</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, s]) => (
          <tr key={label}>
            <td>{label}</td>
            <td>{usd(s.revenue.p50)}</td>
            <td>{usd(s.costs.p50)}</td>
            <td>{usd(s.profit.p10)}</td>
            <td>
              <strong>{usd(s.profit.p50)}</strong>
            </td>
            <td>{usd(s.profit.p90)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Slider({ label, value, onChange, min = 0.5, max = 1.5 }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  return (
    <label className="slider">
      <span>
        {label} <b>{Math.round(value * 100)}%</b>
      </span>
      <input type="range" min={min} max={max} step={0.05} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

export function PairingPage({ id }: { id: string }) {
  const { data, error, reload } = useLoad(async () => {
    const { data: p, error } = await supabase
      .from('pairings')
      .select('*,niches(name,slug),locations(name),parameter_profiles(params),analysis_results!pairings_latest_result_fk(*)')
      .eq('id', id)
      .single();
    if (error) throw error;
    const ids: string[] = p.analysis_results?.assumption_ids ?? [];
    const { data: assumptions } = ids.length
      ? await supabase.from('assumptions').select('id,key,subject_type,subject_id,value_num,value_text,low,high,unit,source_url,confidence,written_by,retrieved_at').in('id', ids)
      : { data: [] };
    return { p, assumptions: assumptions ?? [] };
  }, [id]);
  const [w, setW] = useState<WhatIf>({ price: 1, occupancy: 1, fixed: 1, staffing: 1, startup: 1 });
  const model: BusinessModel | null = data?.p.analysis_results?.model ?? null;
  const changed = Object.values(w).some((v) => v !== 1);
  const whatIf = useMemo(() => (model && changed ? analyze(applyWhatIf(model, w), { simulations: 500, seed: 42 }) : null), [model, changed, w]);

  if (error) return <Err error={error} />;
  if (!data) return <Loading />;
  const { p, assumptions } = data;
  const ar = p.analysis_results;
  const r: (AnalysisResult & { tenure?: string; missing?: string[] }) | null = ar?.result ?? null;
  const target = Number(p.parameter_profiles?.params?.target_monthly_profit_usd ?? 5000);

  return (
    <>
      <p>
        <a href="#ideas">← All business ideas</a>
      </p>
      <Section
        title={`${p.niches?.name} · ${p.locations?.name}`}
        actions={
          <>
            {p.status === 'awaiting_approval' && (
              <RunButton label="Approve for analysis" action={async () => supabase.from('pairings').update({ status: 'approved' }).eq('id', id)} onDone={reload} />
            )}
            {['approved', 'analyzed', 'verified'].includes(p.status) && <RunButton label="Analyse now" action={() => callAgent('analyze-pairing', { pairing_id: id })} onDone={reload} />}
            {ar && <RunButton label="Re-verify" action={() => callAgent('verifier', { result_id: ar.id })} onDone={reload} />}
          </>
        }
      >
        <p>
          Status <span className={`pill ${p.status}`}>{p.status}</span> · fit {p.score_total ?? '—'} · {r?.tenure ?? p.scores?.tenure ?? ''}{' '}
          {ar && (
            <>
              · verifier <b>{ar.verifier_status}</b> · confidence <b>{ar.confidence}</b>
            </>
          )}
        </p>
        {!r ? (
          <p className="muted">Not analysed yet. {p.status === 'awaiting_approval' ? 'Approve it to queue a full analysis.' : ''}</p>
        ) : (
          <>
            <div className="kpis">
              <div>
                <small>Startup (P50)</small>
                <b>{usd(r.startup.total.p50)}</b>
                <small>{r.startup.fundingNote}</small>
              </div>
              <div>
                <small>Year-1 profit/mo vs ${target.toLocaleString()} goal</small>
                <b className={r.month12.profit.p50 >= target ? 'ok' : 'err'}>{usd(r.month12.profit.p50)}</b>
              </div>
              <div>
                <small>Break-even month</small>
                <b>{r.breakEvenMonthP50 ?? 'not within 5 years'}</b>
              </div>
              <div>
                <small>Worst realistic cash dip (P10)</small>
                <b>{usd(r.cashLowPoint.p10)}</b>
              </div>
              {r.valuation.map((v) => (
                <div key={v.year}>
                  <small>
                    Sale year {v.year} ({v.method})
                  </small>
                  <b>{usd(v.price.p50)}</b>
                  <small>net {usd(v.netProceeds.p50)}</small>
                </div>
              ))}
            </div>
            <Snapshots r={r} />
            {r.warnings.length > 0 && (
              <ul className="warnings">
                {r.warnings.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </Section>

      {model && r && (
        <Section title="What if?" actions={changed && <button onClick={() => setW({ price: 1, occupancy: 1, fixed: 1, staffing: 1, startup: 1 })}>Reset</button>}>
          <p className="muted small">Runs the same engine in your browser on the stored model. Nothing is saved.</p>
          <div className="sliders">
            <Slider label="Prices" value={w.price} onChange={(v) => setW({ ...w, price: v })} />
            <Slider label="Occupancy" value={w.occupancy} onChange={(v) => setW({ ...w, occupancy: v })} />
            <Slider label="Fixed costs" value={w.fixed} onChange={(v) => setW({ ...w, fixed: v })} />
            <Slider label="Staffing" value={w.staffing} onChange={(v) => setW({ ...w, staffing: v })} min={0} />
            <Slider label="Startup costs" value={w.startup} onChange={(v) => setW({ ...w, startup: v })} />
          </div>
          {whatIf && (
            <>
              <p>
                Startup {usd(whatIf.startup.total.p50)} · break-even month {whatIf.breakEvenMonthP50 ?? '—'} · year-5 sale {usd(whatIf.valuation.at(-1)?.price.p50)}
              </p>
              <Snapshots r={whatIf} />
            </>
          )}
        </Section>
      )}

      {r && (
        <Section title="Biggest swings (year-3 monthly profit)">
          <table>
            <tbody>
              {r.sensitivity.map((s) => (
                <tr key={s.input}>
                  <td>{s.input}</td>
                  <td>{usd(s.lowProfit)}</td>
                  <td>{usd(s.highProfit)}</td>
                  <td className="muted">swing {usd(s.swing)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>Startup lines (P50)</h3>
          <table>
            <tbody>
              {r.startup.lines.map((l) => (
                <tr key={l.key}>
                  <td>{l.label}</td>
                  <td>{usd(l.p50)}</td>
                </tr>
              ))}
              <tr>
                <td>Contingency</td>
                <td>{usd(r.startup.contingencyP50)}</td>
              </tr>
              <tr>
                <td>Working capital</td>
                <td>{usd(r.startup.workingCapitalP50)}</td>
              </tr>
            </tbody>
          </table>
        </Section>
      )}

      {ar?.verifier_report && (
        <Section title="Verifier report">
          <ul>
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            {ar.verifier_report.checks?.map((c: any) => (
              <li key={c.name} className={c.ok ? 'ok' : 'err'}>
                {c.ok ? '✓' : '✗'} {c.name} — {c.detail}
              </li>
            ))}
          </ul>
          {ar.verifier_report.reviewer?.concerns?.length > 0 && (
            <>
              <h3>Reviewer concerns</h3>
              <ul>
                {ar.verifier_report.reviewer.concerns.map((c: string) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </>
          )}
        </Section>
      )}

      <Section title="Inputs used">
        {r?.missing && r.missing.length > 0 && <p className="err">Missing (fallback used): {r.missing.join(', ')}</p>}
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Value</th>
              <th>Range</th>
              <th>Confidence</th>
              <th>By</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            {assumptions.map((a: any) => (
              <tr key={a.id}>
                <td>
                  {a.key} <small className="muted">({a.subject_type})</small>
                </td>
                <td>
                  {a.value_num ?? a.value_text} {a.unit ?? ''}
                </td>
                <td className="muted">{a.low !== null ? `${a.low}–${a.high}` : ''}</td>
                <td>{a.confidence}</td>
                <td className="small">{a.written_by}</td>
                <td className="small">{a.source_url ? <a href={a.source_url} target="_blank" rel="noreferrer">source</a> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </>
  );
}
