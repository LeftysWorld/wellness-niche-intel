import { callAgent, supabase, usd } from '../supabase.ts';
import { Err, Loading, RunButton, Section, useLoad } from '../ui.tsx';

export function Digest() {
  const { data, error, reload } = useLoad(async () => {
    const { data, error } = await supabase.from('digests').select('*').order('created_at', { ascending: false }).limit(8);
    if (error) throw error;
    return data ?? [];
  });
  return (
    <Section title="Weekly digest" actions={<RunButton label="Write digest now" action={() => callAgent('orchestrator', { task: 'digest' })} onDone={reload} />}>
      <Err error={error} />
      {!data ? (
        <Loading />
      ) : data.length === 0 ? (
        <p className="muted">No digests yet. One is written every Monday.</p>
      ) : (
        data.map((d) => (
          <article key={d.id} className="digest">
            <h3>
              {new Date(d.period_start).toLocaleDateString()} – {new Date(d.period_end).toLocaleDateString()}
            </h3>
            <p>
              {d.content.new_niches?.length ?? 0} new niches · {d.content.new_examples?.length ?? 0} new examples · {d.content.pending_reviews} waiting for review ·{' '}
              {(d.content.tokens ?? 0).toLocaleString()} tokens · {d.content.searches ?? 0} searches
            </p>
            {d.content.new_niches?.length > 0 && (
              <p>
                New niches: {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {d.content.new_niches.map((n: any) => n.name).join(', ')}
              </p>
            )}
            {d.content.top_pairings?.length > 0 && (
              <ol>
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {d.content.top_pairings.map((p: any, i: number) => (
                  <li key={i}>
                    {p.niches?.name} · {p.locations?.name} — fit {p.score_total}, year-3 {usd(p.rough_profit_year3)}/mo ({p.status})
                  </li>
                ))}
              </ol>
            )}
          </article>
        ))
      )}
    </Section>
  );
}
