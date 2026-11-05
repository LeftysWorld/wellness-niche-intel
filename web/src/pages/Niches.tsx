import { useState } from 'react';
import { callAgent, supabase, usd } from '../supabase.ts';
import { Err, Loading, RunButton, Section, useLoad } from '../ui.tsx';

const FILTERS = [
  ['all', 'All'],
  ['starred', 'Starred'],
  ['new', 'New ideas'],
  ['use', 'In use'],
] as const;

export function Niches() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>('all');
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, reload } = useLoad(async () => {
    const { data, error } = await supabase
      .from('niches')
      .select('id,slug,name,status,favorite,signal_score,risk_tags,card,example_businesses(name,locality,country,url,status)')
      .neq('status', 'merged')
      .order('favorite', { ascending: false })
      .order('signal_score', { ascending: false });
    if (error) throw error;
    // Best screened idea per niche, so a new niche can be judged before it is approved.
    const { data: ideas } = await supabase
      .from('pairings')
      .select('niche_id,scores,locations(name)')
      .neq('status', 'screened_out')
      .not('scores', 'is', null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const best: Record<string, any> = {};
    for (const i of ideas ?? []) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sc = (i as any).scores;
      if (sc?.target_year_figure === undefined) continue;
      const cur = best[i.niche_id];
      const better = !cur || Number(sc.fundable) > Number(cur.scores.fundable) || (sc.fundable === cur.scores.fundable && sc.target_year_figure > cur.scores.target_year_figure);
      if (better) best[i.niche_id] = i;
    }
    return (data ?? []).map((n) => ({ ...n, best: best[n.id] ?? null }));
  });

  const list = (data ?? []).filter((n) =>
    filter === 'starred' ? n.favorite : filter === 'new' ? n.status === 'proposed' : filter === 'use' ? n.status === 'approved' : n.status !== 'rejected',
  );

  async function set(id: string, patch: Record<string, unknown>) {
    await supabase.from('niches').update(patch).eq('id', id);
    if ('status' in patch) {
      await supabase.from('review_queue').update({ status: patch.status, decided_at: new Date().toISOString() }).eq('item_type', 'niche').eq('item_id', id).eq('status', 'pending');
    }
    reload();
  }

  return (
    <Section
      title="Niches"
      actions={
        <>
          <RunButton label="Discover new niches" action={() => callAgent('niche-discovery', { mode: 'brainstorm' })} onDone={reload} />
          <RunButton label="Write up new niches" action={() => callAgent('niche-discovery', { mode: 'draft', limit: 3 })} onDone={reload} />
        </>
      }
    >
      <p className="muted small">
        Wellness businesses that need land or a building. New ideas are written up by the AI with real examples; use one to pair it with your places.
      </p>
      <div className="filters tabs">
        {FILTERS.map(([k, label]) => (
          <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
      </div>
      <Err error={error} />
      {!data ? (
        <Loading />
      ) : (
        <div className="cards">
          {list.map((n) => {
            const c = n.card ?? {};
            const written = Boolean(c.model);
            const examples = n.example_businesses ?? [];
            return (
              <article key={n.id} className="idea">
                <header>
                  <h3>
                    <button className="star" title={n.favorite ? 'Unstar' : 'Star'} onClick={() => set(n.id, { favorite: !n.favorite })}>
                      {n.favorite ? '★' : '☆'}
                    </button>{' '}
                    {n.name}
                  </h3>
                  <span className={`pill ${n.status}`}>{n.status === 'approved' ? 'In use' : n.status === 'proposed' ? 'New idea' : n.status}</span>
                </header>
                <p>{c.summary ?? c.description ?? c.note ?? c.structures}</p>
                {c.unique_angle && (
                  <p className="small">
                    <b>What's different:</b> {c.unique_angle}
                  </p>
                )}
                {c.why_interesting && (
                  <p className="small">
                    <b>Why now:</b> {c.why_interesting}
                  </p>
                )}
                {(c.revenue_units || c.price_model) && (
                  <p className="small">
                    <b>Makes money from:</b> {[c.revenue_units, c.price_model].filter(Boolean).join(' — ')}
                  </p>
                )}
                {n.best && (
                  <p className="small">
                    <b>Best place so far:</b> {n.best.locations?.name} — year 1 {usd(n.best.scores.target_year_figure)}/mo, year 3 {usd(n.best.scores.year3_figure)}/mo
                    {n.best.scores.fundable ? '' : ' (not fundable with your cash)'}
                  </p>
                )}
                {c.model && (
                  <p className="small muted">
                    {c.model.openHoursPerMonth !== undefined ? `On site ${c.model.openHoursPerMonth} h/month` : 'Opening hours not set'} ·{' '}
                    {c.model.buildMonths?.lease?.mode ?? '?'} months to open if leased, {c.model.buildMonths?.own?.mode ?? '?'} if built · site: {c.model.siteType ?? 'house'}
                  </p>
                )}
                {(c.prerequisites ?? []).length > 0 && (
                  <p className="small">
                    <b>Site must have:</b> {c.prerequisites.join('; ')}
                  </p>
                )}
                {c.demand_evidence && (
                  <p className="small">
                    <b>Demand {c.demand_score ?? '?'}/10:</b> {c.demand_evidence}
                  </p>
                )}
                {c.review && (
                  <div className={`banner ${c.review.verdict === 'pass' ? '' : c.review.verdict === 'flag' ? 'warn' : 'err'} small`}>
                    <b>Independent check: {c.review.verdict}.</b> {(c.review.concerns ?? []).slice(0, 3).join(' ')}
                    {(c.review.key_assumptions ?? []).length > 0 && (
                      <table className="small">
                        <tbody>
                          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                          {c.review.key_assumptions.map((a: any) => (
                            <tr key={a.name}>
                              <td>{a.name}</td>
                              <td>{a.value}</td>
                              <td className={a.supported === 'yes' ? 'ok' : a.supported === 'no' ? 'err' : ''}>{a.supported === 'yes' ? 'supported' : a.supported === 'no' ? 'not supported' : 'partly'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
                {!c.review && written && <p className="small muted">Not independently checked yet — press Write it up again to check it.</p>}
                {(n.risk_tags ?? []).length > 0 && <p className="small err">Needs: {n.risk_tags.join(', ')}</p>}
                {c.smoke_test?.length > 0 && <p className="small err">Write-up needs another pass: {c.smoke_test.join('; ')}</p>}
                <p className="small">
                  <button className="link" onClick={() => setOpen(open === n.id ? null : n.id)}>
                    {examples.length} operating example{examples.length === 1 ? '' : 's'}
                  </button>
                </p>
                {open === n.id && (
                  <ul className="small">
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    {examples.map((e: any) => (
                      <li key={e.url ?? e.name}>
                        {e.url ? (
                          <a href={e.url} target="_blank" rel="noreferrer">
                            {e.name}
                          </a>
                        ) : (
                          e.name
                        )}{' '}
                        — {[e.locality, e.country].filter(Boolean).join(', ')}
                      </li>
                    ))}
                  </ul>
                )}
                <footer>
                  {n.status === 'proposed' && (
                    <RunButton label={written ? 'Rewrite and re-check' : 'Write it up'} action={() => callAgent('niche-discovery', { niche_id: n.id })} onDone={reload} />
                  )}
                  {n.status === 'proposed' && written && !c.smoke_test?.length && <button onClick={() => set(n.id, { status: 'approved' })}>Use this niche</button>}
                  {n.status !== 'rejected' && (
                    <button className="link muted" onClick={() => set(n.id, { status: 'rejected' })}>
                      Not for me
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
