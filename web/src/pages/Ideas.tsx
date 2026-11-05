import { useState } from 'react';
import { callAgent, supabase, usd } from '../supabase.ts';
import { Err, EvidenceBadge, Loading, RunButton, Section, useLoad } from '../ui.tsx';

// A business idea = one niche run in one place, with the engine's numbers.
const STATUS: Record<string, string> = {
  candidate: 'Screened',
  approved: 'Queued for full analysis',
  analyzed: 'Analysed',
  verified: 'Analysed and checked',
  screened_out: 'Ruled out',
  rejected: 'Rejected',
};

const PART_LABELS: Record<string, string> = {
  money: 'Year-1 take-home vs target',
  growth: 'Year-3 take-home vs target',
  capital: 'Fundable',
  workload: 'Workload',
  demand: 'Demand evidence',
  place: 'Place match',
  visa: 'Residency',
  risk: 'Country risk',
  evidence: 'Sourced data',
};

type Sort = 'money' | 'score';

export function Ideas() {
  const [sort, setSort] = useState<Sort>('money');
  const [showOut, setShowOut] = useState(false);
  const [onlyUsed, setOnlyUsed] = useState(false);
  const [favOnly, setFavOnly] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, reload } = useLoad(async () => {
    const statuses = ['verified', 'analyzed', 'approved', 'candidate', ...(showOut ? ['screened_out'] : [])];
    const [pairings, profile] = await Promise.all([
      supabase
        .from('pairings')
        .select('id,status,score_total,scores,hard_filter_reasons,niches(name,status,card,favorite),locations(id,name,favorite,fit),analysis_results!pairings_latest_result_fk(result,verifier_status,confidence)')
        .in('status', statuses)
        .limit(400),
      supabase.from('parameter_profiles').select('params').eq('is_default', true).single(),
    ]);
    if (pairings.error) throw pairings.error;
    return { rows: pairings.data ?? [], params: profile.data?.params ?? {} };
  }, [showOut]);

  async function approve(id: string) {
    await supabase.from('pairings').update({ status: 'approved' }).eq('id', id);
    reload();
  }

  const target = Number(data?.params?.target_monthly_profit_usd ?? 5000);
  const afterTax = (data?.params?.target_basis ?? 'after_tax') !== 'pre_tax';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const view = (p: any) => {
    const r = p.analysis_results?.result;
    const sc = p.scores ?? {};
    const fig = (s: any) => (s ? (afterTax ? s.takeHome : s.profit) : null);
    return {
      y1: fig(r?.year1)?.p50 ?? sc.target_year_figure ?? null,
      y1Range: fig(r?.year1) ?? sc.target_year_range ?? null,
      y3: fig(r?.year3)?.p50 ?? sc.year3_figure ?? null,
      fundable: r?.startup?.fundable ?? sc.fundable ?? false,
      fundingNote: r?.startup?.fundingNote ?? sc.funding_note,
      cash: r?.startup?.cashNeeded?.p50 ?? sc.cash_needed_p50,
      months: r?.startup?.preOpeningMonthsP50 ?? sc.pre_opening_months,
      tenure: r?.tenure ?? sc.tenure,
      help: r?.capacity?.paidHelpHoursP50 ?? sc.paid_help_hours ?? 0,
      evidence: r?.evidence ?? sc.evidence,
      site: sc.site_check,
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (data?.rows ?? [])
    .filter((p: any) => !onlyUsed || p.niches?.status === 'approved')
    .filter((p: any) => !favOnly || p.locations?.favorite || p.niches?.favorite)
    .map((p: any) => ({ p, v: view(p) }))
    .sort((a: any, b: any) =>
      sort === 'score'
        ? (b.p.score_total ?? -1) - (a.p.score_total ?? -1)
        : Number(b.v.fundable) - Number(a.v.fundable) || (b.v.y1 ?? -1e9) - (a.v.y1 ?? -1e9) || (b.v.y3 ?? -1e9) - (a.v.y3 ?? -1e9),
    );

  return (
    <Section title="Business ideas" actions={<RunButton label="Re-rank ideas" action={() => callAgent('fit-screen')} onDone={() => setTimeout(reload, 60000)} />}>
      <p className="muted small">
        Every written-up niche in every place you keep. Money figures are monthly averages for the first and third year after opening,{' '}
        {afterTax ? 'after estimated income tax' : 'before income tax'}, after loan payments and a repair reserve. Your target: {usd(target)}/month.
      </p>
      <div className="filters">
        <label>
          Sort by{' '}
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="money">Money (fundable first)</option>
            <option value="score">Overall fit score</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={onlyUsed} onChange={(e) => setOnlyUsed(e.target.checked)} /> Only niches I'm using
        </label>
        <label>
          <input type="checkbox" checked={favOnly} onChange={(e) => setFavOnly(e.target.checked)} /> Only starred
        </label>
        <label>
          <input type="checkbox" checked={showOut} onChange={(e) => setShowOut(e.target.checked)} /> Show ruled-out
        </label>
      </div>
      <Err error={error} />
      {!data ? (
        <Loading />
      ) : rows.length === 0 ? (
        <p className="muted">No ideas yet. Write up some niches, add places, then press Re-rank ideas.</p>
      ) : (
        <div className="cards">
          {rows.map(({ p, v }: any) => {
            const card = p.niches?.card ?? {};
            return (
              <article key={p.id} className="idea">
                <header>
                  <h3>
                    <a href={`#pairing/${p.id}`}>
                      {p.niches?.name} in {p.locations?.name}
                    </a>
                    {p.locations?.favorite && <span title="Starred place"> ★</span>}
                  </h3>
                  <span className="score" title="Overall fit score, 0-10">
                    {p.score_total ?? '—'}
                  </span>
                </header>
                <div className="chips">
                  {p.niches?.status === 'proposed' && <span className="pill">new niche</span>}
                  <EvidenceBadge evidence={v.evidence} />
                  {v.site?.verdict === 'unknown' && <span className="pill warn" title={v.site.reason}>site: check</span>}
                </div>
                <p className="small">{card.unique_angle ?? card.summary ?? card.structures}</p>
                <div className="nums">
                  <div>
                    <small>Year 1 /mo</small>
                    <b className={(v.y1 ?? 0) >= target ? 'ok' : (v.y1 ?? 0) < 0 ? 'err' : ''}>{usd(v.y1)}</b>
                    {v.y1Range && (
                      <small className="muted">
                        {usd(v.y1Range.p10)} to {usd(v.y1Range.p90)}
                      </small>
                    )}
                  </div>
                  <div>
                    <small>Year 3 /mo</small>
                    <b className={(v.y3 ?? 0) < 0 ? 'err' : ''}>{usd(v.y3)}</b>
                  </div>
                  <div>
                    <small>Your cash</small>
                    <b className={v.fundable ? '' : 'err'}>{usd(v.cash)}</b>
                  </div>
                </div>
                <p className="small">
                  {v.tenure === 'own' ? 'Buy land' : 'Lease a property'} · {v.months ?? '?'} months to open ·{' '}
                  {v.help > 0.5 ? `you + ${Math.round(v.help)} h/month paid help` : 'you run it alone'}
                </p>
                {!v.fundable && v.fundingNote && <p className="small err">{v.fundingNote}</p>}
                {p.status === 'screened_out' && <p className="small err">{(p.hard_filter_reasons ?? []).join('; ')}</p>}
                {open === p.id && p.scores?.parts && (
                  <table className="small">
                    <tbody>
                      {Object.entries(p.scores.parts).map(([k, val]) => (
                        <tr key={k}>
                          <td>{PART_LABELS[k] ?? k}</td>
                          <td>{Math.round(Number(val) * 10) / 10} / 10</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <footer>
                  <span className={`pill ${p.status}`}>{STATUS[p.status] ?? p.status}</span>
                  {p.status === 'candidate' && <button onClick={() => approve(p.id)}>Analyse this idea</button>}
                  {p.scores?.parts && (
                    <button className="link muted" onClick={() => setOpen(open === p.id ? null : p.id)}>
                      {open === p.id ? 'Hide score' : 'Why this score'}
                    </button>
                  )}
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </Section>
  );
}
