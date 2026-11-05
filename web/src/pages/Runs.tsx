import { callAgent, supabase } from '../supabase.ts';
import { Err, Loading, RunButton, Section, useLoad } from '../ui.tsx';

export function Runs() {
  const { data, error, reload } = useLoad(async () => {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const [runs, spend, totals, budgets, version, latest] = await Promise.all([
      supabase.from('runs').select('id,kind,status,tokens_used,token_budget,search_calls,error,started_at,finished_at').order('started_at', { ascending: false }).limit(100),
      supabase.from('spend_log').select('provider,model,input_tokens,output_tokens,calls').gte('created_at', since),
      supabase.rpc('spend_totals'),
      supabase.from('settings').select('value').eq('key', 'budgets').single(),
      callAgent('version').catch(() => null),
      fetch('https://api.github.com/repos/LeftysWorld/wellness-niche-intel/commits/main').then((r) => (r.ok ? r.json() : null)).catch(() => null),
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
    const day = Date.now() - 86_400_000;
    const failures = (runs.data ?? []).filter((r) => ['failed', 'budget_exceeded'].includes(r.status) && Date.parse(r.started_at) > day);
    return {
      runs: runs.data ?? [],
      byModel,
      failures,
      totals: (Array.isArray(totals.data) ? totals.data[0] : totals.data) ?? {},
      caps: budgets.data?.value ?? {},
      backend: (version as { version?: string } | null)?.version ?? null,
      latest: (latest as { sha?: string } | null)?.sha ?? null,
    };
  });

  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
  return (
    <>
      {data && data.failures.length > 0 && (
        <div className="banner err">
          <b>{data.failures.length} run{data.failures.length === 1 ? '' : 's'} failed or hit a budget in the last 24 hours.</b> Latest:{' '}
          {data.failures[0].kind.replace('_', ' ')} — {data.failures[0].error}
        </div>
      )}
      {data && data.backend && data.latest && data.backend !== 'local' && data.backend !== data.latest && (
        <div className="banner warn">The backend is running an older version of the code than GitHub main. Redeploy it (see README → Deploying).</div>
      )}
      {data && (
        <Section title="Spending limits (all runs combined)">
          <table>
            <tbody>
              <tr>
                <td>AI tokens today</td>
                <td>
                  {Number(data.totals.tokens_today ?? 0).toLocaleString()} / {Number(data.caps.daily_tokens ?? 0).toLocaleString()} ({pct(data.totals.tokens_today, data.caps.daily_tokens)}%)
                </td>
              </tr>
              <tr>
                <td>AI tokens this month</td>
                <td>
                  {Number(data.totals.tokens_month ?? 0).toLocaleString()} / {Number(data.caps.monthly_tokens ?? 0).toLocaleString()} ({pct(data.totals.tokens_month, data.caps.monthly_tokens)}%)
                </td>
              </tr>
              <tr>
                <td>Searches today</td>
                <td>
                  {data.totals.searches_today ?? 0} / {data.caps.daily_searches ?? 0}
                </td>
              </tr>
              <tr>
                <td>Searches this month (Tavily free tier: 1,000)</td>
                <td>
                  {data.totals.searches_month ?? 0} / {data.caps.monthly_searches ?? 0}
                </td>
              </tr>
            </tbody>
          </table>
          <p className="muted small">When a limit is reached, runs pause and show "budget exceeded" until the next day or month.</p>
        </Section>
      )}
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
