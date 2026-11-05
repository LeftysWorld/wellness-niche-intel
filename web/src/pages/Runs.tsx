import { callAgent, supabase } from '../supabase.ts';
import { Err, Loading, RunButton, Section, useLoad } from '../ui.tsx';

export function Runs() {
  const { data, error, reload } = useLoad(async () => {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const [runs, spend] = await Promise.all([
      supabase.from('runs').select('id,kind,status,tokens_used,token_budget,search_calls,error,started_at,finished_at').order('started_at', { ascending: false }).limit(100),
      supabase.from('spend_log').select('provider,model,input_tokens,output_tokens,calls').gte('created_at', since),
    ]);
    if (runs.error) throw runs.error;
    const byModel: Record<string, { input: number; output: number; calls: number }> = {};
    for (const s of spend.data ?? []) {
      const k = `${s.provider} · ${s.model}`;
      byModel[k] ??= { input: 0, output: 0, calls: 0 };
      byModel[k].input += s.input_tokens;
      byModel[k].output += s.output_tokens;
      byModel[k].calls += s.calls;
    }
    return { runs: runs.data ?? [], byModel };
  });

  return (
    <>
      <Section
        title="AI usage, last 30 days"
        actions={
          <>
            <RunButton label="Find new businesses" action={() => callAgent('discovery-loop', { mode: 'daily' })} onDone={reload} />
            <RunButton label="Update location data" action={() => callAgent('orchestrator', { task: 'refresh', limit: 2 })} onDone={reload} />
            <RunButton label="Analyse next approved" action={() => callAgent('orchestrator', { task: 'tick' })} onDone={reload} />
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
                <th>Provider · model</th>
                <th>Calls</th>
                <th>Input tokens</th>
                <th>Output tokens</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.byModel).map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{v.calls.toLocaleString()}</td>
                  <td>{v.input.toLocaleString()}</td>
                  <td>{v.output.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      <Section title="Recent runs">
        {data && (
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Kind</th>
                <th>Status</th>
                <th>Tokens</th>
                <th>Searches</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r) => (
                <tr key={r.id}>
                  <td className="small">{new Date(r.started_at).toLocaleString()}</td>
                  <td>{r.kind}</td>
                  <td>
                    <span className={`pill ${r.status}`}>{r.status}</span>
                  </td>
                  <td>
                    {r.tokens_used?.toLocaleString()} / {r.token_budget?.toLocaleString()}
                  </td>
                  <td>{r.search_calls}</td>
                  <td className="small err">{r.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}
