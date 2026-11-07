import { useMemo, useState } from 'react';
import { analyze } from '../../../supabase/functions/_shared/engine/index.ts';
import type { AnalysisResult, BusinessModel, Tri } from '../../../supabase/functions/_shared/engine/types.ts';
import { callAgent, supabase, usd } from '../supabase.ts';
import { Err, EvidenceBadge, Loading, RunButton, Section, useLoad } from '../ui.tsx';
import { computeLive, loadLive } from '../live.ts';
import { AnalystPanel } from '../agents.tsx';
import type { Candidate } from '../../../supabase/functions/_shared/evaluate.ts';

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
    ['Year 1', r.year1],
    ['Year 3', r.year3],
    ['Year 5', r.year5],
  ] as const;
  return (
    <table>
      <thead>
        <tr>
          <th>Monthly average after opening</th>
          <th>Revenue</th>
          <th>Costs incl. loan</th>
          <th>Profit before tax</th>
          <th>Take-home: bad case (P10)</th>
          <th>Take-home: middle</th>
          <th>Take-home: good case (P90)</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, s]) => (
          <tr key={label}>
            <td>{label}</td>
            <td>{usd(s.revenue.p50)}</td>
            <td>{usd(s.costs.p50)}</td>
            <td>{usd(s.profit.p50)}</td>
            <td>{usd(s.takeHome.p10)}</td>
            <td>
              <strong>{usd(s.takeHome.p50)}</strong>
            </td>
            <td>{usd(s.takeHome.p90)}</td>
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


const LABEL: Record<string, string> = {
  'land.price_per_acre_usd': 'Land price per acre',
  'lease.finca_monthly_usd': 'House lease per month',
  'lease.commercial_monthly_usd': 'Commercial lease per month',
  'lease.estate_monthly_usd': 'Estate lease per month',
  'labor.monthly_wage_usd': 'Worker cost per month',
  'tax.revenue_pct': 'Taxes on revenue',
  'tax.income_effective_pct': 'Income tax rate',
  'build.cost_index': 'Building cost vs NC',
  'price.index': 'Local prices vs NC',
  'price.index_destination': 'Visitor prices vs NC',
  'demand.multiplier': 'Demand vs typical',
  'demand.population_40min': 'People within 40 min',
  'demand.seasonality': 'Seasons',
  'exit.country_discount': 'Buyer discount for country risk',
  'finance.rate_pct': 'Loan interest rate',
  'finance.min_equity_pct': 'Minimum down payment',
  'land.appreciation_pct': 'Land value growth per year',
  'lease.land_monthly_usd_per_acre': 'Land rent per acre per month',
  'finance.seller_down_pct': 'Seller financing: down payment',
  'finance.seller_rate_pct': 'Seller financing: interest',
  'finance.seller_term_years': 'Seller financing: years',
};
const pct = (x: number) => `${Math.round(x * 100)}%`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export function PairingPage({ id }: { id: string }) {
  const { data, error, reload } = useLoad(async () => {
    const { data: p, error } = await supabase
      .from('pairings')
      .select('*,niches(id,slug,name,status,card),locations(id,slug,name,country_code,level,parent_id,fit,favorite),parameter_profiles(params),analysis_results!pairings_latest_result_fk(*)')
      .eq('id', id)
      .single();
    if (error) throw error;
    const ids: string[] = p.analysis_results?.assumption_ids ?? [];
    const { data: stored } = ids.length
      ? await supabase.from('assumptions').select('id,key,subject_type,subject_id,value_num,value_text,low,high,unit,source_url,confidence,written_by,retrieved_at').in('id', ids)
      : { data: [] };
    const live = await loadLive(p.niches, p.locations, p.parameter_profiles?.params ?? {}, id);
    return { p, stored: stored ?? [], live };
  }, [id]);
  const [w, setW] = useState<WhatIf>({ price: 1, occupancy: 1, fixed: 1, staffing: 1, startup: 1 });

  // Same calculator as the screening, run here on the current ledger.
  const candidates: Candidate[] | null = useMemo(() => (data && 'ledger' in data.live ? computeLive(data.live) : null), [data]);
  const ar = data?.p.analysis_results;
  const storedR: Any = ar?.result?.year1 ? ar.result : null;
  const best = candidates?.[0] ?? null;
  const r: Any = storedR ?? (best ? { ...best.result, tenure: best.tenure, evidence: best.build.evidence, missing: best.build.missing } : null);
  const model: BusinessModel | null = (storedR ? ar?.model : null) ?? best?.build.model ?? null;
  const changed = Object.values(w).some((v) => v !== 1);
  const whatIf = useMemo(() => (model && changed ? analyze(applyWhatIf(model, w), { simulations: 500, seed: 42, sensitivity: false }) : null), [model, changed, w]);

  if (error) return <Err error={error} />;
  if (!data) return <Loading />;
  const { p, stored, live } = data;
  const target = Number(p.parameter_profiles?.params?.target_monthly_profit_usd ?? 5000);
  const card = p.niches?.card ?? {};
  const fit = p.locations?.fit ?? {};
  const isLive = !storedR && Boolean(best);
  // Inputs: the stored analysis's own list, else every ledger value the live model used.
  const used = new Set(best?.build.usedAssumptionIds ?? []);
  const liveInputs = 'rows' in live ? live.rows.filter((v) => used.has(v.id)) : [];
  const inputs: Any[] = storedR ? stored : liveInputs;
  const guessed = (v: Any) => !v.source_url || String(v.written_by).includes('estimate');

  return (
    <>
      <p>
        <a href="#ideas">← All business ideas</a>
      </p>
      <Section
        title={`${p.niches?.name} · ${p.locations?.name}`}
        actions={
          <>
            {p.status === 'candidate' && (
              <RunButton label="Queue full analysis" action={async () => supabase.from('pairings').update({ status: 'approved' }).eq('id', id)} onDone={reload} />
            )}
            <RunButton label={storedR ? 'Redo full analysis' : 'Run full analysis now'} action={() => callAgent('analyze-pairing', { pairing_id: id })} onDone={reload} />
            <RunButton label="Quick re-run (no research)" action={() => callAgent('analyze-pairing', { pairing_id: id, agent: false, research: false })} onDone={reload} />
            {ar && <RunButton label="Re-verify" action={() => callAgent('verifier', { result_id: ar.id })} onDone={reload} />}
          </>
        }
      >
        <p className="small">
          <span className={`pill ${p.status}`}>{p.status === 'candidate' ? 'Screened' : p.status}</span> · fit score {p.score_total ?? '—'} ·{' '}
          {r?.tenure === 'own' ? 'buy land' : r?.tenure === 'ground' ? 'rent land, build my own' : r?.tenure === 'lease' ? 'lease a property' : ''}
          {ar && (
            <>
              {' '}
              · verifier <b>{ar.verifier_status}</b> · confidence <b>{ar.confidence}</b>
            </>
          )}
        </p>
        <AnalystPanel pairingId={id} result={storedR} />
        {isLive && (
          <p className="banner warn small">
            <b>Live estimate.</b> Calculated just now with the same calculator and data as the screening. The full analysis hasn't been run: an analyst agent researches the
            inputs that move profit most (local prices, occupancy, competition) until the range is narrow, writes a verdict, and an independent check reviews it. Press <i>Run full
            analysis now</i>; it runs in the background for a few minutes and uses AI credit (see Activity for the cost).
          </p>
        )}
        {!r ? (
          <p className="muted">{'missing' in live ? live.missing : 'No numbers yet.'}</p>
        ) : (
          <>
            <div className="chips">
              <EvidenceBadge evidence={r.evidence} />
            </div>
            <div className="kpis">
              <div>
                <small>Your cash needed (middle case)</small>
                <b className={r.startup.fundable ? '' : 'err'}>{usd(r.startup.cashNeeded.p50)}</b>
                <small>{r.startup.fundingNote}</small>
              </div>
              <div>
                <small>Project cost</small>
                <b>{usd(r.startup.total.p50)}</b>
                <small>{r.startup.loanAmountP50 > 0 ? `loan ${usd(r.startup.loanAmountP50)}, ${usd(r.startup.monthlyDebtPaymentP50)}/month` : 'no loan'}</small>
              </div>
              <div>
                <small>Time to open</small>
                <b>{r.startup.preOpeningMonthsP50} months</b>
                <small>costs {usd(r.startup.preOpeningCostP50)} before opening</small>
              </div>
              <div>
                <small>Year-1 take-home/mo vs ${target.toLocaleString()} goal</small>
                <b className={r.year1.takeHome.p50 >= target ? 'ok' : 'err'}>{usd(r.year1.takeHome.p50)}</b>
                <small>
                  {usd(r.year1.takeHome.p10)} to {usd(r.year1.takeHome.p90)}
                  {r.year1.takeHomeWithHousing && r.year1.takeHomeWithHousing.p50 !== r.year1.takeHome.p50 && (
                    <>
                      <br />
                      {usd(r.year1.takeHomeWithHousing.p50)} counting the housing you save living on site
                    </>
                  )}
                </small>
              </div>
              <div>
                <small>Year-3 take-home/mo</small>
                <b className={r.year3.takeHome.p50 >= target ? 'ok' : ''}>{usd(r.year3.takeHome.p50)}</b>
                <small>
                  {usd(r.year3.takeHome.p10)} to {usd(r.year3.takeHome.p90)}
                </small>
              </div>
              <div>
                <small>Your hours</small>
                <b>{r.capacity.needsHelp ? `${r.capacity.limit} + help` : `${r.capacity.peakOwnerHoursP50}/month`}</b>
                <small>{r.capacity.needsHelp ? `${r.capacity.paidHelpHoursP50} h/month paid help, ${usd(r.capacity.paidHelpCostP50)}/month` : 'you run it alone'}</small>
              </div>
              {r.lender.applies && (
                <div>
                  <small>Lender test</small>
                  <b className={r.lender.bankable ? 'ok' : 'err'}>{r.lender.bankable ? 'Passes' : 'Fails'}</b>
                  <small>{r.lender.note}</small>
                </div>
              )}
              <div>
                <small>Take-home turns positive</small>
                <b>{r.breakEvenMonthP50 ? `month ${r.breakEvenMonthP50}` : 'not within 5 years'}</b>
                <small>after opening</small>
              </div>
              {r.valuation.map((v: Any) => (
                <div key={v.year}>
                  <small>
                    Sale at year {v.year}
                    {v.propertyValueP50 > 0 ? ' (business + property)' : ''}
                  </small>
                  <b>{usd(v.price.p50)}</b>
                  <small>you keep {usd(v.netProceeds.p50)}</small>
                </div>
              ))}
            </div>
            <Snapshots r={r} />
            {r.warnings.length > 0 && (
              <ul className="warnings">
                {[...new Set<string>(r.warnings)].map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </Section>

      <Section title="The idea">
        <div className="two-col">
          <div>
            <h3>{p.niches?.name}</h3>
            <p className="small">{card.summary ?? card.description}</p>
            {card.unique_angle && (
              <p className="small">
                <b>What's different:</b> {card.unique_angle}
              </p>
            )}
            {(card.revenue_units || card.price_model) && (
              <p className="small">
                <b>Makes money from:</b> {[card.revenue_units, card.price_model].filter(Boolean).join(' — ')}
              </p>
            )}
            {card.demand_evidence && (
              <p className="small">
                <b>Demand {card.demand_score ?? '?'}/10:</b> {card.demand_evidence}
              </p>
            )}
            {(card.prerequisites ?? []).length > 0 && (
              <p className="small">
                <b>Site must have:</b> {card.prerequisites.join('; ')}
              </p>
            )}
          </div>
          <div>
            <h3>{p.locations?.name}</h3>
            {fit.summary ? <p className="small">{fit.summary}</p> : <p className="small muted">Not matched against your description yet.</p>}
            {(fit.pros ?? []).length > 0 && <p className="small ok">+ {fit.pros.join(' · ')}</p>}
            {(fit.cons ?? []).length > 0 && <p className="small err">− {fit.cons.join(' · ')}</p>}
            {p.scores?.site_check && (
              <p className="small">
                <b>Site check: {p.scores.site_check.verdict}.</b> {p.scores.site_check.reason}
              </p>
            )}
          </div>
        </div>
      </Section>

      {candidates && candidates.length > 1 && (
        <Section title="Lease, rent land or buy?">
          <table>
            <thead>
              <tr>
                <th>Option</th>
                <th>Your cash</th>
                <th>Project cost</th>
                <th>Months to open</th>
                <th>Year 1 /mo</th>
                <th>Year 3 /mo</th>
                <th>Year-5 sale</th>
                <th>Fundable</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c, i) => (
                <tr key={c.tenure}>
                  <td>
                    {c.tenure === 'own' ? 'Buy land and build' : c.tenure === 'ground' ? 'Rent land, build my own' : 'Lease a property'}
                    {c.build.model.financing.kind === 'cash' ? ' (cash)' : c.build.model.financing.lender ? ` (${c.build.model.financing.lender})` : ''} {i === 0 && <span className="pill">better</span>}
                  </td>
                  <td>{usd(c.result.startup.cashNeeded.p50)}</td>
                  <td>{usd(c.result.startup.total.p50)}</td>
                  <td>{c.result.startup.preOpeningMonthsP50}</td>
                  <td>{usd(c.result.year1.takeHome.p50)}</td>
                  <td>{usd(c.result.year3.takeHome.p50)}</td>
                  <td>{usd(c.result.valuation.at(-1)?.price.p50)}</td>
                  <td className={c.result.startup.fundable ? 'ok' : 'err'}>{c.result.startup.fundable ? 'yes' : 'no'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">Take-home after loan payments and estimated income tax, monthly averages over each year after opening.</p>
        </Section>
      )}

      {model && (
        <Section title="How the money works">
          <h3>What it sells</h3>
          <table>
            <thead>
              <tr>
                <th>Offer</th>
                <th>Capacity</th>
                <th>Price (low · typical · high)</th>
                <th>Booked once established</th>
                <th>Months to get there</th>
              </tr>
            </thead>
            <tbody>
              {model.streams.map((s) => (
                <tr key={s.key}>
                  <td>{s.label}</td>
                  <td>
                    {s.units} × {s.sellablePerUnitPerMonth}/month
                  </td>
                  <td>
                    {usd(s.price.low)} · <b>{usd(s.price.mode)}</b> · {usd(s.price.high)}
                  </td>
                  <td>
                    {pct(s.matureOccupancy.low)}–{pct(s.matureOccupancy.high)} (typical {pct(s.matureOccupancy.mode)})
                  </td>
                  <td>{Math.round(s.monthsToMature.mode)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>Monthly running costs (typical)</h3>
          <table>
            <tbody>
              {[...model.costs.fixed, ...model.costs.staffing].map((c) => (
                <tr key={`${c.key}-${c.fromMonth ?? 1}`}>
                  <td>
                    {c.label}
                    {c.fromMonth && c.fromMonth > 1 ? <small className="muted"> from month {c.fromMonth}</small> : null}
                  </td>
                  <td>{usd(c.amount.mode)}</td>
                  <td className="muted">
                    {usd(c.amount.low)}–{usd(c.amount.high)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {r && (
            <>
              <h3>Start-up costs (middle case)</h3>
              <table>
                <tbody>
                  {r.startup.lines.map((l: Any) => (
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
                    <td>Opening buffer</td>
                    <td>{usd(r.startup.workingCapitalP50)}</td>
                  </tr>
                </tbody>
              </table>
            </>
          )}
        </Section>
      )}

      {model && r && (
        <Section title="What if?" actions={changed && <button onClick={() => setW({ price: 1, occupancy: 1, fixed: 1, staffing: 1, startup: 1 })}>Reset</button>}>
          <p className="muted small">Move a slider to see the effect. Runs in your browser; nothing is saved.</p>
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
                Your cash {usd(whatIf.startup.cashNeeded.p50)} · take-home positive from month {whatIf.breakEvenMonthP50 ?? '—'} · year-5 sale {usd(whatIf.valuation.at(-1)?.price.p50)}
              </p>
              <Snapshots r={whatIf} />
            </>
          )}
        </Section>
      )}

      {r?.sensitivity?.length > 0 && (
        <Section title="What moves the result most (year-3 monthly profit before tax)">
          <table>
            <thead>
              <tr>
                <th>If this input is…</th>
                <th>Low</th>
                <th>High</th>
                <th>Swing</th>
              </tr>
            </thead>
            <tbody>
              {r.sensitivity.map((s: Any) => (
                <tr key={s.input}>
                  <td>{s.input}</td>
                  <td>{usd(s.lowProfit)}</td>
                  <td>{usd(s.highProfit)}</td>
                  <td className="muted">{usd(s.swing)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {ar?.verifier_report && (
        <Section title="Verifier report">
          <ul>
            {ar.verifier_report.checks?.map((c: Any) => (
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

      <Section title="Where the numbers come from">
        {r?.missing && r.missing.length > 0 && <p className="err small">Not found yet (a cautious default was used): {r.missing.map((k: string) => LABEL[k] ?? k).join(', ')}</p>}
        <p className="muted small">Place values come from the scout's web research; "estimate" means a starting value the scout is still replacing. The niche's prices, occupancy and costs come from its write-up.</p>
        <table>
          <thead>
            <tr>
              <th>Input</th>
              <th>Value</th>
              <th>Range</th>
              <th>From</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {inputs.map((a: Any) => (
              <tr key={a.id}>
                <td>
                  {LABEL[a.key] ?? a.key} <small className="muted">({a.subject_type === 'global' ? 'everywhere' : a.subject_id === p.locations?.id ? 'this place' : a.subject_type === 'pairing' ? 'this idea' : 'country'})</small>
                </td>
                <td>
                  {a.value_num ?? a.value_text} {a.unit ?? ''}
                </td>
                <td className="muted">{a.low !== null && a.low !== undefined ? `${a.low}–${a.high}` : ''}</td>
                <td className={guessed(a) ? 'muted' : 'ok'}>{guessed(a) ? 'estimate' : `sourced (${a.confidence})`}</td>
                <td className="small">
                  {a.source_url ? (
                    <a href={a.source_url} target="_blank" rel="noreferrer">
                      source
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </>
  );
}
