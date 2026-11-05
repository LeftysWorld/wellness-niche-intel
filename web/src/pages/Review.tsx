import { supabase } from '../supabase.ts';
import { Err, Loading, Section, useLoad } from '../ui.tsx';

export function Review() {
  const { data, error, reload } = useLoad(async () => {
    const { data, error } = await supabase.from('review_queue').select('*').eq('status', 'pending').order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    return data ?? [];
  });

  async function decide(item: { id: string; item_type: string; item_id: string }, status: 'approved' | 'rejected' | 'more_research') {
    const { data: u } = await supabase.auth.getUser();
    await supabase.from('review_queue').update({ status, decided_at: new Date().toISOString(), decided_by: u.user?.email }).eq('id', item.id);
    // Apply the decision right away; the orchestrator also syncs any it missed.
    if (status !== 'more_research') {
      if (item.item_type === 'niche') await supabase.from('niches').update({ status }).eq('id', item.item_id).eq('status', 'proposed');
      if (item.item_type === 'shortlist') await supabase.from('pairings').update({ status }).eq('id', item.item_id).eq('status', 'awaiting_approval');
    }
    reload();
  }

  return (
    <Section title="Review queue">
      <Err error={error} />
      {!data ? (
        <Loading />
      ) : data.length === 0 ? (
        <p className="muted">Nothing waiting.</p>
      ) : (
        <ul className="queue">
          {data.map((q) => (
            <li key={q.id}>
              <span className="pill">{q.item_type.replace('_', ' ')}</span>
              <span className="summary">
                {q.item_type === 'shortlist' ? <a href={`#pairing/${q.item_id}`}>{q.summary}</a> : q.summary}
              </span>
              {q.payload?.url && (
                <a className="small" href={q.payload.url} target="_blank" rel="noreferrer">
                  example
                </a>
              )}
              <span className="actions">
                {q.item_type !== 'low_confidence' && <button onClick={() => decide(q, 'approved')}>Approve</button>}
                <button onClick={() => decide(q, 'rejected')}>{q.item_type === 'low_confidence' ? 'Dismiss' : 'Reject'}</button>
                {q.item_type !== 'low_confidence' && <button onClick={() => decide(q, 'more_research')}>More research</button>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
