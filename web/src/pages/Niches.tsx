import { Fragment, useState } from 'react';
import { callAgent, supabase } from '../supabase.ts';
import { Err, Loading, RunButton, Section, useLoad } from '../ui.tsx';

export function Niches() {
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, reload } = useLoad(async () => {
    const { data, error } = await supabase
      .from('niches')
      .select('id,slug,name,family,status,signal_score,risk_tags,card,example_businesses(name,locality,country,url,status)')
      .order('signal_score', { ascending: false });
    if (error) throw error;
    return data ?? [];
  });

  return (
    <Section
      title="Niche library"
      actions={
        <>
          <RunButton label="Daily discovery" action={() => callAgent('discovery-loop', { mode: 'daily' })} onDone={reload} />
          <RunButton label="Draft cards" action={() => callAgent('niche-discovery', { mode: 'draft' })} onDone={reload} />
          <RunButton label="Brainstorm" action={() => callAgent('niche-discovery', { mode: 'brainstorm' })} onDone={reload} />
        </>
      }
    >
      <Err error={error} />
      {!data ? (
        <Loading />
      ) : (
        <table>
          <thead>
            <tr>
              <th>Niche</th>
              <th>Status</th>
              <th>Signal</th>
              <th>Examples</th>
              <th>Model card</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((n) => (
              <Fragment key={n.id}>
                <tr>
                  <td>
                    <button className="link" onClick={() => setOpen(open === n.id ? null : n.id)}>
                      {n.name}
                    </button>{' '}
                    {(n.risk_tags ?? []).map((t: string) => (
                      <span key={t} className="pill rejected">
                        {t}
                      </span>
                    ))}
                  </td>
                  <td>
                    <span className={`pill ${n.status}`}>{n.status}</span>
                  </td>
                  <td>{n.signal_score}</td>
                  <td>{n.example_businesses?.length ?? 0}</td>
                  <td>{n.card?.model ? (n.card?.smoke_test?.length ? 'failed checks' : 'yes') : 'no'}</td>
                  <td>
                    {n.status === 'proposed' && !n.card?.model && (
                      <RunButton label="Draft" action={() => callAgent('niche-discovery', { niche_id: n.id })} onDone={reload} />
                    )}
                  </td>
                </tr>
                {open === n.id && (
                  <tr>
                    <td colSpan={6}>
                      <p>{n.card?.summary ?? n.card?.description}</p>
                      <ul>
                        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                        {(n.example_businesses ?? []).map((e: any) => (
                          <li key={e.url ?? e.name}>
                            {e.url ? (
                              <a href={e.url} target="_blank" rel="noreferrer">
                                {e.name}
                              </a>
                            ) : (
                              e.name
                            )}{' '}
                            — {e.locality}, {e.country} ({e.status})
                          </li>
                        ))}
                      </ul>
                      {n.card?.model && <pre>{JSON.stringify(n.card.model, null, 2)}</pre>}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}
