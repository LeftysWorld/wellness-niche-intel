import { useState } from 'react';
import { callAgent, supabase, usd } from '../supabase.ts';
import { FilterLayout, ratingField, useFilters } from '../filters.tsx';
import { Err, Loading, RunButton, Section, useLoad } from '../ui.tsx';

export function Niches() {
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
      .select('niche_id,scores,score_total,locations(name)')
      .neq('status', 'screened_out')
      .not('scores', 'is', null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const best: Record<string, any> = {};
    const topScore: Record<string, number> = {};
    for (const i of ideas ?? []) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const st = (i as any).score_total;
      if (st !== null && st !== undefined) topScore[i.niche_id] = Math.max(topScore[i.niche_id] ?? -Infinity, Number(st));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sc = (i as any).scores;
      if (sc?.target_year_figure === undefined) continue;
      const cur = best[i.niche_id];
      const better = !cur || Number(sc.fundable) > Number(cur.scores.fundable) || (sc.fundable === cur.scores.fundable && sc.target_year_figure > cur.scores.target_year_figure);
      if (better) best[i.niche_id] = i;
    }
    return (data ?? []).map((n) => ({ ...n, best: best[n.id] ?? null, bestScore: topScore[n.id] ?? null }));
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type N = any;
  const STATUS_LABEL = (st: string) => (st === 'approved' ? 'In use' : st === 'proposed' ? 'New idea' : st === 'rejected' ? 'Not for me' : st);
  const f = useFilters<N>({
    tab: 'niches',
    rows: data ?? [],
    noun: 'niches',
    views: [
      { label: 'In use and new', criteria: { enums: { status: ['In use', 'New idea'] } } },
      { label: 'Making money', criteria: { enums: { status: ['In use', 'New idea'] }, bools: { fundable: true } } },
      { label: 'Starred', criteria: { bools: { fav: true } } },
      { label: 'New, to decide', criteria: { enums: { status: ['New idea'] } } },
      { label: 'Not for me', criteria: { enums: { status: ['Not for me'] } } },
      { label: 'All niches' },
    ],
    sorts: [
      { key: 'starred', label: 'Starred, then strongest signal', cmp: (a, b) => Number(b.favorite) - Number(a.favorite) || (b.signal_score ?? 0) - (a.signal_score ?? 0) },
      { key: 'money', label: 'Best year-1 take-home', cmp: (a, b) => (b.best?.scores?.target_year_figure ?? -1e9) - (a.best?.scores?.target_year_figure ?? -1e9) },
      { key: 'demand', label: 'Demand score', cmp: (a, b) => (b.card?.demand_score ?? -1) - (a.card?.demand_score ?? -1) },
      { key: 'name', label: 'Name A–Z', cmp: (a, b) => String(a.name).localeCompare(String(b.name)) },
    ],
    fields: [
      { key: 'text', label: 'Text', type: 'text', get: (n) => [n.card?.summary, n.card?.description, n.card?.unique_angle, n.card?.why_interesting, n.card?.revenue_units, n.card?.price_model, (n.example_businesses ?? []).map((e: N) => `${e.name} ${e.locality ?? ''} ${e.country ?? ''}`).join(' ')].join(' ') },
      ratingField<N>('demand', 'Demand score', (n) => n.card?.demand_score),
      ratingField<N>('bestFit', 'Best idea fit score', (n) => n.bestScore),
      { key: 'status', label: 'Status', type: 'enum', group: 'Niche', get: (n) => STATUS_LABEL(n.status), order: ['In use', 'New idea', 'Not for me'] },
      { key: 'fav', label: 'Starred', type: 'bool', quick: true, get: (n) => n.favorite },
      { key: 'written', label: 'Written up', type: 'bool', quick: true, get: (n) => Boolean(n.card?.model) },
      { key: 'review', label: 'Independent check', type: 'enum', group: 'Niche', get: (n) => (n.card?.review?.verdict ? ({ pass: 'Passed', flag: 'Flagged', fail: 'Failed' } as Record<string, string>)[String(n.card.review.verdict)] ?? n.card.review.verdict : 'Not checked'), order: ['Passed', 'Flagged', 'Failed', 'Not checked'] },
      { key: 'site', label: 'Site type', type: 'enum', group: 'Niche', get: (n) => (n.card?.model ? n.card.model.siteType ?? 'house' : null) },
      { key: 'needs', label: 'Needs', type: 'enum', group: 'Niche', get: (n) => n.risk_tags ?? [] },
      { key: 'fundable', label: 'Fundable somewhere', type: 'bool', quick: true, get: (n) => n.best?.scores?.fundable },
      { key: 'y1', label: 'Best year 1 /mo', type: 'number', group: 'Money', get: (n) => n.best?.scores?.target_year_figure, fmt: usd },
      { key: 'y3', label: 'Best year 3 /mo', type: 'number', group: 'Money', get: (n) => n.best?.scores?.year3_figure, fmt: usd },
      { key: 'bestPlace', label: 'Best place', type: 'enum', group: 'Money', get: (n) => n.best?.locations?.name },
      { key: 'signal', label: 'Signal score', type: 'number', group: 'Evidence', get: (n) => n.signal_score },
      { key: 'examples', label: 'Operating examples', type: 'number', group: 'Evidence', get: (n) => (n.example_businesses ?? []).length },
      { key: 'exCountry', label: 'Example countries', type: 'enum', group: 'Evidence', get: (n) => [...new Set((n.example_businesses ?? []).map((e: N) => e.country).filter(Boolean))] },
      { key: 'openLease', label: 'Months to open (lease)', type: 'number', group: 'Setup', get: (n) => n.card?.model?.buildMonths?.lease?.mode },
      { key: 'openOwn', label: 'Months to open (build)', type: 'number', group: 'Setup', get: (n) => n.card?.model?.buildMonths?.own?.mode },
      { key: 'hours', label: 'On-site hours/month', type: 'number', group: 'Setup', get: (n) => n.card?.model?.openHoursPerMonth },
    ],
  });
  const list = f.rows;

  async function set(id: string, patch: Record<string, unknown>) {
    await supabase.from('niches').update(patch).eq('id', id);
    if ('status' in patch) {
      await supabase.from('review_queue').update({ status: patch.status, decided_at: new Date().toISOString() }).eq('item_type', 'niche').eq('item_id', id).eq('status', 'pending');
    }
    reload();
  }

  return (
    <FilterLayout f={f}>
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
      <Err error={error} />
      {!data ? (
        <Loading />
      ) : (
        <div className="cards">
          {list.map((n: N) => {
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
    </FilterLayout>
  );
}
