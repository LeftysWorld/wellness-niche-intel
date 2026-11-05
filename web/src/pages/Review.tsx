import { supabase } from '../supabase.ts';
import { FilterLayout, useFilters } from '../filters.tsx';
import { Err, Loading, Section, useLoad } from '../ui.tsx';

const TYPE: Record<string, string> = { niche: 'New niche', shortlist: 'Shortlisted idea', low_confidence: 'Low-confidence result', example: 'Example business' };
const STATUS: Record<string, string> = { pending: 'Waiting', approved: 'Approved', rejected: 'Rejected', more_research: 'More research' };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Q = any;

export function Review() {
  const { data, error, reload } = useLoad(async () => {
    const { data, error } = await supabase.from('review_queue').select('*').order('created_at', { ascending: false }).limit(1000);
    if (error) throw error;
    return (data ?? []) as Q[];
  });

  const days = (iso?: string) => (iso ? Math.floor((Date.now() - Date.parse(iso)) / 86_400_000) : null);
  const f = useFilters<Q>({
    tab: 'review',
    rows: data ?? [],
    noun: 'items',
    views: [
      { label: 'Waiting for me', criteria: { enums: { status: ['Waiting'] } } },
      { label: 'Decided', criteria: { enums: { status: ['Approved', 'Rejected', 'More research'] } } },
      { label: 'Everything' },
    ],
    sorts: [
      { key: 'new', label: 'Newest first', cmp: (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) },
      { key: 'old', label: 'Oldest first', cmp: (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) },
      { key: 'type', label: 'Type', cmp: (a, b) => String(a.item_type).localeCompare(String(b.item_type)) },
    ],
    fields: [
      { key: 'text', label: 'Text', type: 'text', get: (q) => [q.summary, q.payload?.url].join(' ') },
      { key: 'status', label: 'Status', type: 'enum', group: 'Item', get: (q) => STATUS[q.status] ?? q.status, order: Object.values(STATUS) },
      { key: 'type', label: 'Type', type: 'enum', group: 'Item', get: (q) => TYPE[q.item_type] ?? String(q.item_type).replace('_', ' ') },
      { key: 'link', label: 'Has a link', type: 'bool', quick: true, get: (q) => Boolean(q.payload?.url) },
      { key: 'age', label: 'Days since added', type: 'number', group: 'When', get: (q) => days(q.created_at) },
      { key: 'decided', label: 'Days since decided', type: 'number', group: 'When', get: (q) => days(q.decided_at) },
    ],
  });

  async function decide(item: Q, status: 'approved' | 'rejected' | 'more_research') {
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
    <FilterLayout f={f}>
      <Section title="Review queue">
        <Err error={error} />
        {!data ? (
          <Loading />
        ) : f.rows.length === 0 ? (
          <p className="muted">{data.length ? 'Nothing matches these filters.' : 'Nothing waiting.'}</p>
        ) : (
          <ul className="queue">
            {f.rows.map((q: Q) => (
              <li key={q.id}>
                <span className="pill">{TYPE[q.item_type] ?? q.item_type.replace('_', ' ')}</span>
                <span className="summary">
                  {q.item_type === 'shortlist' ? <a href={`#pairing/${q.item_id}`}>{q.summary}</a> : q.summary}
                </span>
                {q.payload?.url && (
                  <a className="small" href={q.payload.url} target="_blank" rel="noreferrer">
                    example
                  </a>
                )}
                {q.status === 'pending' ? (
                  <span className="actions">
                    {q.item_type !== 'low_confidence' && <button onClick={() => decide(q, 'approved')}>Approve</button>}
                    <button onClick={() => decide(q, 'rejected')}>{q.item_type === 'low_confidence' ? 'Dismiss' : 'Reject'}</button>
                    {q.item_type !== 'low_confidence' && <button onClick={() => decide(q, 'more_research')}>More research</button>}
                  </span>
                ) : (
                  <span className={`pill ${q.status}`}>{STATUS[q.status] ?? q.status}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </FilterLayout>
  );
}
