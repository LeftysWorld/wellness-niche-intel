import { useMemo, useState } from 'react';
import { analyze } from '../../../supabase/functions/_shared/engine/index.ts';
import type { AnalysisResult, BusinessModel, Tri } from '../../../supabase/functions/_shared/engine/types.ts';
import { callAgent, supabase, usd } from '../supabase.ts';
import { Err, EvidenceBadge, Loading, RunButton, useLoad } from '../ui.tsx';
import { computeLive, loadLive } from '../live.ts';
import { AnalystPanel } from '../agents.tsx';
import type { Candidate } from '../../../supabase/functions/_shared/evaluate.ts';
import { cashWithHome, featuresFor, ideaChecks, inputUse, type Tenure } from '../../../supabase/functions/_shared/concept.ts';
import { Block, ConceptBlock, DemandBlock, FeaturesBlock, Fold, Kpi, OwnBlock, PageNav, PlanPicker, RangeBars, ScoreParts, TENURE_NAME, Warnings } from '../idea.tsx';

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
  'finance.sba_min_equity_pct': 'SBA minimum down payment',
  'demand.competitors_60min': 'Same-kind businesses within 60 min',
};
/** A readable name for an input, including the per-offer price and booking-rate keys. */
function labelFor(key: string, streams: { key: string; label: string }[] = []): string {
  if (LABEL[key]) return LABEL[key];
  const name = (k: string) => streams.find((s) => s.key === k)?.label ?? k.replace(/_/g, ' ');
  let m = key.match(/^price\.(.+)_usd$/);
  if (m) return `${name(m[1])}: price`;
  m = key.match(/^occupancy\.(.+)\.(mature|start)$/);
  if (m) return `${name(m[1])}: booked share ${m[2] === 'mature' ? 'once established' : 'at opening'}`;
  return key;
}
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
  const [picked, setPicked] = useState<string | null>(null);
  const [showAllInputs, setShowAllInputs] = useState(false);

  // Same calculator as the screening, run here on the current ledger.
  const candidates: Candidate[] | null = useMemo(() => (data && 'ledger' in data.live ? computeLive(data.live) : null), [data]);
  const ar = data?.p.analysis_results;
  const storedR: Any = ar?.result?.year1 ? ar.result : null;
  const best = candidates?.[0] ?? null;
  // The plan on screen: the one picked, else the analysed one, else the best live one.
  const tenure: string | undefined = picked ?? storedR?.tenure ?? best?.tenure;
  const fromStore = Boolean(storedR) && storedR.tenure === tenure;
  const cand = candidates?.find((c) => c.tenure === tenure) ?? null;
  const r: Any = fromStore ? storedR : cand ? { ...cand.result, tenure: cand.tenure, evidence: cand.build.evidence, missing: cand.build.missing } : storedR;
  const model: BusinessModel | null = (fromStore ? ar?.model : null) ?? cand?.build.model ?? (storedR ? ar?.model : null) ?? null;
  const changed = Object.values(w).some((v) => v !== 1);
  const whatIf = useMemo(() => (model && changed ? analyze(applyWhatIf(model, w), { simulations: 500, seed: 42, sensitivity: false }) : null), [model, changed, w]);

  if (error) return <Err error={error} />;
  if (!data) return <Loading />;
  const { p, stored, live } = data;
  const params = p.parameter_profiles?.params ?? {};
  const target = Number(params.target_monthly_profit_usd ?? 5000);
  const card = p.niches?.card ?? {};
  const concept = card.concept ?? null;
  const fit = p.locations?.fit ?? {};
  const memo = storedR?.memo;
  const isLive = !fromStore && Boolean(r);
  // Inputs: the stored analysis's own list, else every ledger value the live model used.
  const used = new Set(cand?.build.usedAssumptionIds ?? best?.build.usedAssumptionIds ?? []);
  const liveInputs = 'rows' in live ? live.rows.filter((v) => used.has(v.id)) : [];
  const inputs: Any[] = (fromStore ? stored : liveInputs).map((a: Any) => ({ ...a, ...inputUse(a.key, tenure as Tenure, a.value_num) }));
  const shownInputs = showAllInputs ? inputs : inputs.filter((a) => a.relevant);
  const guessed = (v: Any) => !v.source_url || String(v.written_by).includes('estimate');
  const sourced = inputs.length ? inputs.filter((a) => !guessed(a)).length / inputs.length : 0;
  const checks = r && model ? ideaChecks({ tenure: tenure as Tenure, model, result: r, card, profile: params }) : [];
  const warnings = [...new Set<string>([...checks, ...(r?.warnings ?? [])])];
  const withHome = r ? cashWithHome(r.startup.cashNeeded.p50, tenure as Tenure, params) : null;
  const plans = (candidates ?? []).map((c) => ({ tenure: c.tenure, cash: c.result.startup.cashNeeded.p50, y1: c.result.year1.takeHome.p50, open: c.result.startup.preOpeningMonthsP50, fundable: c.result.startup.fundable }));
  const preferred = params.own_or_lease && params.own_or_lease !== 'either' ? params.own_or_lease : undefined;
  const features = model ? featuresFor(concept, model.streams) : [];
  const describe = (
    <RunButton
      label={concept ? 'Redraft the description' : 'Describe this business'}
      action={() => callAgent('niche-discovery', { mode: 'concept', niche_id: p.niches?.id })}
      onDone={reload}
    />
  );
  const usesHome = tenure === 'own' && params.live_on_site;

  return (
    <div className="ip">
      <a href="#ideas">← All business ideas</a>
      <header className="ip-head">
        <div className="ip-title">
          <div className="chips">
            {memo && <span className={`pill ${memo.verdict === 'pursue' ? 'ok' : memo.verdict === 'avoid' ? 'bad' : 'warn'}`}>Verdict: {memo.verdict}</span>}
            {r && <EvidenceBadge evidence={r.evidence} />}
            <span className="pill">Fit {p.score_total ?? '—'}{sourced < 0.5 ? ' · provisional' : ''}</span>
            <span className={`pill ${p.status}`}>{p.status === 'candidate' ? 'Screened' : p.status}</span>
            {ar && (
              <span className="pill">
                Verifier {ar.verifier_status} · confidence {ar.confidence}
              </span>
            )}
          </div>
          <h1>{p.niches?.name}</h1>
          <p className="ip-sub">{p.locations?.name}</p>
          {memo?.headline && <p className="ip-headline">{memo.headline}</p>}
        </div>
        <div className="actions">
          {p.status === 'candidate' && (
            <RunButton label="Queue full analysis" action={async () => supabase.from('pairings').update({ status: 'approved' }).eq('id', id)} onDone={reload} />
          )}
          <RunButton label={storedR ? 'Redo full analysis' : 'Run full analysis now'} action={() => callAgent('analyze-pairing', { pairing_id: id })} onDone={reload} />
          <RunButton label="Quick re-run (no research)" action={() => callAgent('analyze-pairing', { pairing_id: id, agent: false, research: false })} onDone={reload} />
          {ar && <RunButton label="Re-verify" action={() => callAgent('verifier', { result_id: ar.id })} onDone={reload} />}
        </div>
      </header>
      <PageNav
        items={[
          ['concept', 'The business'],
          ['own', "What you'd own"],
          ['features', 'Guest features'],
          ['demand', 'Demand pull'],
          ['plan', 'Ownership plan'],
          ['money', 'Money'],
          ['risks', 'Risks & tests'],
          ['details', 'Details'],
          ['sources', 'Sources'],
        ]}
      />

      <Block id="concept" title="The business">
        <ConceptBlock concept={concept} fallback={card.summary ?? card.description ?? ''} place={{ summary: fit.summary, name: p.locations?.name?.split('(')[0]?.trim() }} describe={describe} />
      </Block>

      {r && (
        <Block id="own" title="What you'd own" aside={`${TENURE_NAME[tenure ?? ''] ?? ''} · project cost ${usd(r.startup.total.p50)}`}>
          <OwnBlock
            lines={r.startup.lines}
            contingency={r.startup.contingencyP50}
            buffer={r.startup.workingCapitalP50}
            assets={concept?.assets ?? []}
            home={
              usesHome ? (
                <div className="ip-card ip-home">
                  <div>
                    <b>Your home on the land</b> <span className="muted small">(personal, kept apart from the business)</span>
                    <p className="small muted">
                      {Number(params.home_build_usd) > 0
                        ? `Budget ${usd(Number(params.home_build_usd))}. Your cash including the home: ${usd(withHome)}.`
                        : 'Owning and living on site means building your house too. The rent you stop paying is counted; the build cost is not until you set a budget.'}
                    </p>
                  </div>
                  <a href="#settings">{Number(params.home_build_usd) > 0 ? 'Change home budget' : 'Set home budget'}</a>
                </div>
              ) : null
            }
          />
        </Block>
      )}

      {model && (
        <Block id="features" title="What guests get, and what each brings in" aside={<><span className="pill ip-priced">Priced</span> in the money model · <span className="pill ip-proposed">Proposed</span> not priced yet</>}>
          <FeaturesBlock features={features} />
        </Block>
      )}

      <Block id="demand" title="Demand pull" aside={fromStore && storedR?.demand ? 'Researched by the analyst, scored by code from the evidence' : undefined}>
        <DemandBlock demand={fromStore ? storedR?.demand : null} nicheScore={card.demand_score} nicheEvidence={card.demand_evidence} />
      </Block>

      {plans.length > 0 && (
        <Block id="plan" title="Ownership plan" aside={fromStore ? 'Full analysis of this plan' : 'Live estimate for this plan'}>
          <PlanPicker options={plans} value={tenure ?? ''} onChange={setPicked} preferred={preferred} />
        </Block>
      )}

      <Block id="money" title={`Money at a glance${tenure ? ` · ${TENURE_NAME[tenure]}` : ''}`} aside="Monthly averages after opening, after loan payments and income tax">
        {isLive && (
          <p className="banner warn small">
            <b>Live estimate.</b> Calculated just now with the same calculator and data as the screening. A full analysis has the analyst research the inputs that move profit most,
            write a verdict and have it checked independently. Press <i>{storedR ? 'Redo full analysis' : 'Run full analysis now'}</i>; it runs in the background for a few minutes.
          </p>
        )}
        {!r ? (
          <p className="muted">{'missing' in live ? live.missing : 'No numbers yet.'}</p>
        ) : (
          <>
            <div className="ip-grid4">
              <Kpi
                label="Your cash needed"
                value={usd(r.startup.cashNeeded.p50)}
                tone={r.startup.fundable ? undefined : 'err'}
                sub={withHome ? `${usd(withHome)} with your home` : r.startup.fundingNote}
              />
              <Kpi label="Project cost" value={usd(r.startup.total.p50)} sub={r.startup.loanAmountP50 > 0 ? `loan ${usd(r.startup.loanAmountP50)}, ${usd(r.startup.monthlyDebtPaymentP50)}/month` : 'no loan'} />
              <Kpi label={`Year-1 take-home vs ${usd(target)} goal`} value={`${usd(r.year1.takeHome.p50)}/mo`} tone={r.year1.takeHome.p50 >= target ? 'ok' : 'err'} sub={`${usd(r.year1.takeHome.p10)} – ${usd(r.year1.takeHome.p90)}`} />
              <Kpi label="Year-3 take-home" value={`${usd(r.year3.takeHome.p50)}/mo`} sub={`${usd(r.year3.takeHome.p10)} – ${usd(r.year3.takeHome.p90)}`} />
              <Kpi label="Time to open" value={`${r.startup.preOpeningMonthsP50} months`} sub={`${usd(r.startup.preOpeningCostP50)} spent before opening`} />
              <Kpi
                label="Your hours"
                value={r.capacity.needsHelp ? `${r.capacity.limit} + help` : `${r.capacity.peakOwnerHoursP50}/month`}
                sub={r.capacity.needsHelp ? `${r.capacity.paidHelpHoursP50} h/month paid help, ${usd(r.capacity.paidHelpCostP50)}/month` : 'you run it alone'}
              />
              {r.lender.applies && <Kpi label="Lender test" value={r.lender.bankable ? 'Passes' : 'Fails'} tone={r.lender.bankable ? 'ok' : 'err'} sub={r.lender.note} />}
              {r.valuation.at(-1) && (
                <Kpi
                  label={`Sale at year ${r.valuation.at(-1).year}${r.valuation.at(-1).propertyValueP50 > 0 ? ' (business + property)' : ''}`}
                  value={usd(r.valuation.at(-1).price.p50)}
                  sub={`you keep ${usd(r.valuation.at(-1).netProceeds.p50)}`}
                />
              )}
            </div>
            <div className="ip-split">
              <div className="ip-card">
                <h3>Take-home range (bad · middle · good case)</h3>
                <RangeBars r={r} target={target} />
              </div>
              <div className="ip-card">
                <h3>Model warnings</h3>
                <Warnings items={warnings} />
              </div>
            </div>
            <div className="ip-split even">
              {model && (
                <div className="ip-card">
                  <h3>What it sells, once established</h3>
                  <table>
                    <thead>
                      <tr>
                        <th>Offer</th>
                        <th>Price</th>
                        <th>Capacity /mo</th>
                        <th>Booked</th>
                        <th>Revenue /mo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {model.streams.map((s) => {
                        const cap = s.units * s.sellablePerUnitPerMonth;
                        return (
                          <tr key={s.key}>
                            <td>{s.label}</td>
                            <td>{usd(s.price.mode)}</td>
                            <td>{cap <= 1 ? 'flat' : cap.toLocaleString()}</td>
                            <td>{cap <= 1 ? '—' : pct(s.matureOccupancy.mode)}</td>
                            <td>
                              <b>{usd(cap <= 1 ? s.price.mode : cap * s.matureOccupancy.mode * s.price.mode)}</b>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <p className="muted small">Before seasons and the ramp-up. Proposed features are not counted.</p>
                </div>
              )}
              <div className="ip-card">
                <ScoreParts parts={p.scores?.parts} total={p.score_total} sourced={sourced} />
              </div>
            </div>
          </>
        )}
      </Block>

      <Block id="risks" title="Risks, stop signs and cheapest tests">
        <AnalystPanel pairingId={id} result={storedR} />
        {!storedR && <p className="muted small">Run a full analysis to get the analyst's risks, stop signs and cheapest tests.</p>}
      </Block>

      <Block id="details" title="Details">
        {r && (
          <Fold title="Year-by-year numbers">
            <Snapshots r={r} />
          </Fold>
        )}
        <Fold title="The place">
          <h3>{p.locations?.name}</h3>
          {fit.summary ? <p className="small">{fit.summary}</p> : <p className="small muted">Not matched against your description yet.</p>}
          {(fit.pros ?? []).length > 0 && <p className="small ok">+ {fit.pros.join(' · ')}</p>}
          {(fit.cons ?? []).length > 0 && <p className="small err">− {fit.cons.join(' · ')}</p>}
          {p.scores?.site_check && (
            <p className="small">
              <b>Site check: {p.scores.site_check.verdict}.</b> {p.scores.site_check.reason}
            </p>
          )}
          {(card.prerequisites ?? []).length > 0 && (
            <p className="small">
              <b>Site must have:</b> {card.prerequisites.join('; ')}
            </p>
          )}
          {card.demand_evidence && (
            <p className="small">
              <b>Demand {card.demand_score ?? '?'}/10:</b> {card.demand_evidence}
            </p>
          )}
        </Fold>
        {candidates && candidates.length > 1 && (
          <Fold title="All ownership plans compared">
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
                {candidates.map((c) => (
                  <tr key={c.tenure}>
                    <td>
                      {TENURE_NAME[c.tenure]}
                      {c.build.model.financing.kind === 'cash' ? ' (cash)' : c.build.model.financing.lender ? ` (${c.build.model.financing.lender})` : ''}
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
          </Fold>
        )}
        {model && (
          <Fold title="Running costs and start-up costs">
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
            <h3>Offers in detail</h3>
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
          </Fold>
        )}
        {model && r && (
          <Fold title="What if?">
            <div className="actions">{changed && <button onClick={() => setW({ price: 1, occupancy: 1, fixed: 1, staffing: 1, startup: 1 })}>Reset</button>}</div>
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
          </Fold>
        )}
        {r?.sensitivity?.length > 0 && (
          <Fold title="What moves the result most">
            <table>
              <thead>
                <tr>
                  <th>If this input is… (year-3 monthly profit before tax)</th>
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
          </Fold>
        )}
        {ar?.verifier_report && (
          <Fold title="Verifier report">
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
          </Fold>
        )}
      </Block>

      <Block
        id="sources"
        title="Where the numbers come from"
        aside={
          <button type="button" onClick={() => setShowAllInputs(!showAllInputs)}>
            {showAllInputs ? 'Hide inputs this plan does not use' : `Show all inputs (${inputs.length - inputs.filter((a) => a.relevant).length} hidden)`}
          </button>
        }
      >
        <div className="ip-card">
          <div className="ip-meter" role="img" aria-label={`${Math.round(sourced * 100)} percent of inputs sourced`}>
            <span style={{ width: `${Math.round(sourced * 100)}%` }} />
          </div>
          <p className="small">
            <b>{Math.round(sourced * 100)}%</b> sourced · <b>{100 - Math.round(sourced * 100)}%</b> estimate (a starting value the research is still replacing). Only inputs the{' '}
            {TENURE_NAME[tenure ?? ''] ?? 'chosen'} plan uses are shown.
          </p>
          {r?.missing && r.missing.length > 0 && <p className="err small">Not found yet (a cautious default was used): {r.missing.map((k: string) => labelFor(k, model?.streams)).join(', ')}</p>}
          <table>
            <thead>
              <tr>
                <th>Input</th>
                <th>Value</th>
                <th>Range</th>
                <th>Status</th>
                <th>Used for</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {shownInputs.map((a: Any) => (
                <tr key={a.id} className={a.relevant ? '' : 'stale'}>
                  <td>
                    {labelFor(a.key, model?.streams)}{' '}
                    <small className="muted">({a.subject_type === 'global' ? 'everywhere' : a.subject_id === p.locations?.id ? 'this place' : a.subject_type === 'pairing' ? 'this idea' : 'country'})</small>
                  </td>
                  <td>
                    {a.value_num ?? a.value_text} {a.unit ?? ''}
                  </td>
                  <td className="muted">{a.low !== null && a.low !== undefined ? `${a.low}–${a.high}` : ''}</td>
                  <td>{guessed(a) ? <span className="pill warn">estimate</span> : <span className="pill ok">sourced ({a.confidence})</span>}</td>
                  <td className="muted small">{a.use}</td>
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
        </div>
      </Block>
    </div>
  );
}
