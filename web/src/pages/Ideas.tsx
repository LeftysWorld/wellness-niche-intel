import { useState } from 'react';
import { callAgent, supabase, usd } from '../supabase.ts';
import { Err, Loading, RunButton, Section, useLoad } from '../ui.tsx';

// A business idea = one niche run in one place, with the engine's numbers.
const STATUS: Record<string, string> = {
  candidate: 'New',
  awaiting_approval: 'Waiting for you',
  approved: 'Queued for full analysis',
  analyzed: 'Analysed',
  verified: 'Analysed and checked',
  screened_out: 'Weaker match',
  rejected: 'Rejected',
};

export function Ideas() {
  const [showWeak, setShowWeak] = useState(false);
  const [favOnly, setFavOnly] = useState(false);
  const { data, error, reload } = useLoad(async () => {
    const statuses = ['verified', 'analyzed', 'approved', 'awaiting_approval', 'candidate', ...(showWeak ? ['screened_out'] : [])];
    const { data, error } = await supabase
      .from('pairings')
      .select(
        'id,status,score_total,scores,rough_profit_year3,hard_filter_reasons,niches(name,card,favorite),locations(id,name,country_code,favorite,fit),analysis_results!pairings_latest_result_fk(result,verifier_status,confidence)',
      )
      .in('status', statuses)
      .order('score_total', { ascending: false, nullsFirst: false })
      .limit(150);
    if (error) throw error;
    return data ?? [];
  }, [showWeak]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ideas = (data ?? []).filter((p: any) => !favOnly || p.locations?.favorite || p.niches?.favorite);

  async function approve(id: string) {
    await supabase.from('pairings').update({ status: 'approved' }).eq('id', id);
    await supabase.from('review_queue').update({ status: 'approved', decided_at: new Date().toISOString() }).eq('item_type', 'shortlist').eq('item_id', id).eq('status', 'pending');
    reload();
  }

  return (
    <Section
      title="Business ideas"
      actions={<RunButton label="Re-rank ideas" action={() => callAgent('fit-screen')} onDone={reload} />}
    >
      <p className="muted small">
        Each idea is one niche in one of your places, ranked by how well it fits your goals, money and description of a place. Approve an idea to get a full analysis with
        sourced local prices.
      </p>
      <div className="filters">
        <label>
          <input type="checkbox" checked={favOnly} onChange={(e) => setFavOnly(e.target.checked)} /> Only starred places or niches
        </label>
        <label>
          <input type="checkbox" checked={showWeak} onChange={(e) => setShowWeak(e.target.checked)} /> Show weaker matches
        </label>
      </div>
      <Err error={error} />
      {!data ? (
        <Loading />
      ) : ideas.length === 0 ? (
        <p className="muted">No ideas yet. Approve some niches and add places, then press Re-rank ideas.</p>
      ) : (
        <div className="cards">
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          {ideas.map((p: any) => {
            const r = p.analysis_results?.result;
            const tenure = r?.tenure ?? p.scores?.tenure;
            const startup = r?.startup?.total?.p50 ?? p.scores?.startup_p50;
            const y1 = r?.month12?.profit?.p50 ?? p.scores?.target_year_profit_p50;
            const y3 = r?.month36?.profit?.p50 ?? p.rough_profit_year3;
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
                  <span className="score" title="Overall fit, 0–10">
                    {p.score_total ?? '—'}
                  </span>
                </header>
                <p className="small">{card.unique_angle ?? card.summary ?? card.structures}</p>
                <div className="nums">
                  <div>
                    <small>Start-up</small>
                    <b>{usd(startup)}</b>
                  </div>
                  <div>
                    <small>Year 1 /mo</small>
                    <b className={(y1 ?? 0) >= 0 ? '' : 'err'}>{usd(y1)}</b>
                  </div>
                  <div>
                    <small>Year 3 /mo</small>
                    <b className={(y3 ?? 0) >= 0 ? '' : 'err'}>{usd(y3)}</b>
                  </div>
                </div>
                <p className="small">
                  {tenure === 'own' ? 'Buy land' : tenure === 'lease' ? 'Lease a property' : ''}
                  {p.locations?.fit?.summary && <> · {p.locations.fit.summary}</>}
                </p>
                <footer>
                  <span className={`pill ${p.status}`}>{STATUS[p.status] ?? p.status}</span>
                  {['candidate', 'awaiting_approval', 'screened_out'].includes(p.status) && <button onClick={() => approve(p.id)}>Analyse this idea</button>}
                  {p.status === 'screened_out' && <small className="muted">{(p.hard_filter_reasons ?? []).join('; ')}</small>}
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </Section>
  );
}
