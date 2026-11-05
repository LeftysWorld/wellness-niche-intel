import { useState } from 'react';
import { callAgent, supabase, usd } from '../supabase.ts';
import { FilterLayout, ratingField, useFilters } from '../filters.tsx';
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

const ACTIVE = ['Screened', 'Queued for full analysis', 'Analysed', 'Analysed and checked'];

const EVIDENCE = (e: any) => {
  if (!e) return 'Not modelled';
  const pct = Math.round((e.sourcedShare ?? 0) * 100);
  return pct >= 70 && !e.nicheGuessed ? 'Mostly sourced' : pct >= 40 ? 'Partly guessed' : 'Mostly guessed';
};

export function Ideas() {
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, reload } = useLoad(async () => {
    const [pairings, profile] = await Promise.all([
      supabase
        .from('pairings')
        .select('id,status,score_total,scores,hard_filter_reasons,niches(name,status,card,favorite),locations(id,name,favorite,fit,country_code,parent:parent_id(name)),analysis_results!pairings_latest_result_fk(result,verifier_status,confidence)')
        .limit(1000),
      supabase.from('parameter_profiles').select('params').eq('is_default', true).single(),
    ]);
    if (pairings.error) throw pairings.error;
    return { rows: pairings.data ?? [], params: profile.data?.params ?? {} };
  });

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
  type Row = { p: any; v: ReturnType<typeof view> };
  const all: Row[] = (data?.rows ?? []).map((p: any) => ({ p, v: view(p) }));
  const f = useFilters<Row>({
    tab: 'ideas',
    rows: all,
    sorts: [
      {
        key: 'money',
        label: 'Money (fundable first)',
        cmp: (a, b) => Number(b.v.fundable) - Number(a.v.fundable) || (b.v.y1 ?? -1e9) - (a.v.y1 ?? -1e9) || (b.v.y3 ?? -1e9) - (a.v.y3 ?? -1e9),
      },
      { key: 'score', label: 'Overall fit score', cmp: (a, b) => (b.p.score_total ?? -1) - (a.p.score_total ?? -1) },
      { key: 'cash', label: 'Least cash needed', cmp: (a, b) => (a.v.cash ?? 1e12) - (b.v.cash ?? 1e12) },
      { key: 'fast', label: 'Quickest to open', cmp: (a, b) => (a.v.months ?? 1e9) - (b.v.months ?? 1e9) },
      { key: 'name', label: 'Name A–Z', cmp: (a, b) => String(a.p.niches?.name).localeCompare(String(b.p.niches?.name)) },
    ],
    noun: 'ideas',
    views: [
      { label: 'Active ideas', criteria: { enums: { status: ACTIVE } } },
      { label: 'Best bets', criteria: { enums: { status: ACTIVE }, bools: { fundable: true, meets: true } } },
      { label: 'Starred places', criteria: { enums: { status: ACTIVE }, bools: { placeFav: true } } },
      { label: 'Run it alone', criteria: { enums: { status: ACTIVE }, bools: { solo: true, fundable: true } } },
      { label: 'Ruled out', criteria: { enums: { status: ['Ruled out', 'Rejected'] } } },
      { label: 'Everything' },
    ],
    fields: [
      { key: 'text', label: 'Text', type: 'text', get: (r) => [r.p.niches?.card?.summary, r.p.niches?.card?.unique_angle, (r.p.hard_filter_reasons ?? []).join(' ')].join(' ') },
      ratingField<Row>('fit', 'Fit score', (r) => r.p.score_total),
      ratingField<Row>('match', 'Place match', (r) => r.p.locations?.fit?.score),
      ratingField<Row>('demand', 'Niche demand', (r) => r.p.niches?.card?.demand_score),
      { key: 'status', label: 'Status', type: 'enum', group: 'Idea', get: (r) => STATUS[r.p.status] ?? r.p.status, order: Object.values(STATUS) },
      { key: 'meets', label: 'Meets my target', type: 'bool', quick: true, get: (r) => (r.v.y1 ?? -Infinity) >= target },
      { key: 'fundable', label: 'Fundable', type: 'bool', quick: true, get: (r) => r.v.fundable },
      { key: 'solo', label: 'Run it alone', type: 'bool', quick: true, get: (r) => (r.v.help ?? 0) <= 0.5 },
      { key: 'tenure', label: 'Property', type: 'enum', group: 'Idea', get: (r) => (r.v.tenure ? (r.v.tenure === 'own' ? 'Buy land' : 'Lease') : null) },
      { key: 'evidence', label: 'Data quality', type: 'enum', group: 'Idea', get: (r) => EVIDENCE(r.v.evidence), order: ['Mostly sourced', 'Partly guessed', 'Mostly guessed', 'Not modelled'] },
      { key: 'site', label: 'Site check', type: 'enum', group: 'Idea', get: (r) => (r.v.site?.verdict === 'unknown' ? 'Needs checking' : r.v.site?.verdict === 'fail' ? 'Fails' : r.v.site ? 'Passes' : 'Not checked') },
      { key: 'y1', label: 'Year 1 /mo', type: 'number', group: 'Money', get: (r) => r.v.y1, fmt: usd },
      { key: 'y3', label: 'Year 3 /mo', type: 'number', group: 'Money', get: (r) => r.v.y3, fmt: usd },
      { key: 'cash', label: 'My cash needed', type: 'number', group: 'Money', get: (r) => r.v.cash, fmt: usd },
      { key: 'months', label: 'Months to open', type: 'number', group: 'Money', get: (r) => r.v.months },
      { key: 'help', label: 'Paid help h/month', type: 'number', group: 'Money', get: (r) => r.v.help },
      { key: 'niche', label: 'Niche', type: 'enum', group: 'Niche', get: (r) => r.p.niches?.name },
      { key: 'nicheUse', label: 'Niche status', type: 'enum', group: 'Niche', get: (r) => (r.p.niches?.status === 'approved' ? 'In use' : r.p.niches?.status === 'proposed' ? 'New idea' : r.p.niches?.status) },
      { key: 'nicheFav', label: 'Starred niche', type: 'bool', quick: true, get: (r) => r.p.niches?.favorite },
      { key: 'place', label: 'Place', type: 'enum', group: 'Place', get: (r) => r.p.locations?.name },
      { key: 'country', label: 'Country', type: 'enum', group: 'Place', get: (r) => r.p.locations?.parent?.name ?? r.p.locations?.country_code },
      { key: 'placeFav', label: 'Starred place', type: 'bool', quick: true, get: (r) => r.p.locations?.favorite },
    ],
  });
  const rows = f.rows;

  return (
    <FilterLayout f={f}>
    <Section title="Business ideas" actions={<RunButton label="Re-rank ideas" action={() => callAgent('fit-screen')} onDone={() => setTimeout(reload, 60000)} />}>
      <p className="muted small">
        Every written-up niche in every place you keep. Money figures are monthly averages for the first and third year after opening,{' '}
        {afterTax ? 'after estimated income tax' : 'before income tax'}, after loan payments and a repair reserve. Your target: {usd(target)}/month.
      </p>
      <Err error={error} />
      {!data ? (
        <Loading />
      ) : rows.length === 0 ? (
        <p className="muted">{all.length ? 'No ideas match these filters.' : 'No ideas yet. Write up some niches, add places, then press Re-rank ideas.'}</p>
      ) : (
        <div className="cards">
          {rows.map(({ p, v }) => {
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
    </FilterLayout>
  );
}
