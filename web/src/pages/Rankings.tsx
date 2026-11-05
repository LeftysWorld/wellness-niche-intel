import { useState } from 'react';
import { callAgent, supabase, usd } from '../supabase.ts';
import { Err, Loading, RunButton, Section, useLoad } from '../ui.tsx';

const STATUSES = ['verified', 'analyzed', 'approved', 'awaiting_approval', 'candidate', 'screened_out', 'rejected'];

export function Rankings() {
  const [show, setShow] = useState<string[]>(['verified', 'analyzed', 'approved', 'awaiting_approval', 'candidate']);
  const { data, error, reload } = useLoad(async () => {
    const { data, error } = await supabase
      .from('pairings')
      .select('id,status,score_total,scores,rough_profit_year3,hard_filter_reasons,niches(name),locations(name,country_code),analysis_results!pairings_latest_result_fk(result,verifier_status,confidence)')
      .in('status', show)
      .order('score_total', { ascending: false, nullsFirst: false })
      .limit(200);
    if (error) throw error;
    return data ?? [];
  }, [show.join()]);

  return (
    <Section
      title="Niche × location rankings"
      actions={<RunButton label="Run fit screen" action={() => callAgent('fit-screen')} onDone={reload} />}
    >
      <div className="filters">
        {STATUSES.map((s) => (
          <label key={s}>
            <input type="checkbox" checked={show.includes(s)} onChange={(e) => setShow(e.target.checked ? [...show, s] : show.filter((x) => x !== s))} />
            {s.replace('_', ' ')}
          </label>
        ))}
      </div>
      <Err error={error} />
      {!data ? (
        <Loading />
      ) : (
        <table>
          <thead>
            <tr>
              <th>Niche</th>
              <th>Location</th>
              <th>Status</th>
              <th>Fit</th>
              <th>Tenure</th>
              <th>Startup (P50)</th>
              <th>Target-year profit/mo</th>
              <th>Year-3 profit/mo</th>
              <th>Verifier</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            {data.map((p: any) => {
              const r = p.analysis_results?.result;
              return (
                <tr key={p.id}>
                  <td>
                    <a href={`#pairing/${p.id}`}>{p.niches?.name}</a>
                  </td>
                  <td>{p.locations?.name}</td>
                  <td>
                    <span className={`pill ${p.status}`}>{p.status.replace('_', ' ')}</span>
                  </td>
                  <td>{p.score_total ?? '—'}</td>
                  <td>{r?.tenure ?? p.scores?.tenure ?? '—'}</td>
                  <td>{usd(r?.startup?.total?.p50 ?? p.scores?.startup_p50)}</td>
                  <td>{usd(r?.month12?.profit?.p50 ?? p.scores?.target_year_profit_p50)}</td>
                  <td>{usd(r?.month36?.profit?.p50 ?? p.rough_profit_year3)}</td>
                  <td>{p.analysis_results ? `${p.analysis_results.verifier_status} · ${p.analysis_results.confidence}` : '—'}</td>
                  <td className="muted small">{(p.hard_filter_reasons ?? []).join('; ')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Section>
  );
}
