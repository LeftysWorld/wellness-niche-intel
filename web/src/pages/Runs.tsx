import { callAgent, supabase } from '../supabase.ts';
import { FilterLayout, useFilters } from '../filters.tsx';
import { Err, Loading, RunButton, Section, useLoad } from '../ui.tsx';

interface Prices {
  usd_per_million_tokens?: Record<string, { input: number; output: number }>;
  usd_per_search?: number;
  checked?: string;
}
interface Cost {
  ai: number;
  search: number;
  /** Tokens from a model with no price on file. */
  unpriced: number;
}

/** Cost of logged usage at list prices (tokens actually used × price per token). */
function costOf(rows: { provider: string; model: string; input_tokens: number; output_tokens: number; calls: number }[], prices: Prices): Cost {
  const c: Cost = { ai: 0, search: 0, unpriced: 0 };
  for (const r of rows) {
    if (r.provider === 'tavily') {
      c.search += r.calls * (prices.usd_per_search ?? 0);
      continue;
    }
    const p = prices.usd_per_million_tokens?.[r.model];
    if (!p) c.unpriced += r.input_tokens + r.output_tokens;
    else c.ai += (r.input_tokens * p.input + r.output_tokens * p.output) / 1e6;
  }
  return c;
}

export const money = (n: number) => (n === 0 ? '$0' : n < 0.01 ? '<$0.01' : `$${n.toFixed(n < 10 ? 2 : 0)}`);

const KIND: Record<string, string> = {
  niche_discovery: 'Niche discovery',
  location_scout: 'Location scout',
  fit_screen: 'Re-rank ideas',
  site_check: 'Site check',
  location_fit: 'Place match',
  location_ideas: 'Place suggestions',
  analysis: 'Full analysis',
  verify: 'Independent check',
  discovery_loop: 'Find new businesses',
};

const dur = (r: { started_at: string; finished_at: string | null }) => (r.finished_at ? Math.round(((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 60000) * 10) / 10 : null);

export function Runs() {
  const { data, error, reload } = useLoad(async () => {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const [runs, spend, totals, budgets, version, latest, priceRow] = await Promise.all([
      supabase.from('runs').select('id,kind,status,tokens_used,token_budget,search_calls,error,started_at,finished_at').order('started_at', { ascending: false }).limit(1000),
      supabase.from('spend_log').select('run_id,provider,model,input_tokens,output_tokens,calls,created_at').gte('created_at', since).limit(20000),
      supabase.rpc('spend_totals'),
      supabase.from('settings').select('value').eq('key', 'budgets').single(),
      callAgent('version').catch(() => null),
      fetch('https://api.github.com/repos/LeftysWorld/wellness-niche-intel/commits/main').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      supabase.from('settings').select('value').eq('key', 'prices').maybeSingle(),
    ]);
    if (runs.error) throw runs.error;
    const prices = (priceRow.data?.value ?? {}) as Prices;
    const log = spend.data ?? [];
    const byModel: Record<string, { input: number; output: number; calls: number; cost: number }> = {};
    for (const s of log) {
      const k = `${s.provider} · ${s.model}`;
      byModel[k] ??= { input: 0, output: 0, calls: 0, cost: 0 };
      byModel[k].input += s.input_tokens;
      byModel[k].output += s.output_tokens;
      byModel[k].calls += s.calls;
      const c = costOf([s], prices);
      byModel[k].cost += c.ai + c.search;
    }
    // For runs with no per-call log: the main model's price at a typical 65/35 input/output split.
    const main = prices.usd_per_million_tokens?.['claude-sonnet-5-5'] ?? { input: 2, output: 10 };
    const blended = 0.65 * main.input + 0.35 * main.output;
    const perRun = new Map<string, typeof log>();
    for (const s of log) if (s.run_id) perRun.set(s.run_id, [...(perRun.get(s.run_id) ?? []), s]);
    const dayAgo = Date.now() - 86_400_000;
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
    const sumCost = (rows: typeof log) => {
      const c = costOf(rows, prices);
      return c.ai + c.search;
    };
    const spentDay = sumCost(log.filter((s) => Date.parse(s.created_at) > dayAgo));
    const spentMonth = sumCost(log.filter((s) => Date.parse(s.created_at) >= monthStart));
    const runRows = (runs.data ?? []).map((r) => {
      const rows = perRun.get(r.id);
      // Runs older than 30 days (or logged before per-run logging) fall back to an estimate from their totals.
      const c: Cost & { estimated: boolean } = rows
        ? { ...costOf(rows, prices), estimated: false }
        : { ai: ((r.tokens_used ?? 0) * blended) / 1e6, search: (r.search_calls ?? 0) * (prices.usd_per_search ?? 0), unpriced: 0, estimated: true };
      return { ...r, cost: c, total: c.ai + c.search };
    });
    const day = Date.now() - 86_400_000;
    // Only failures that are still open: no run of the same kind has succeeded since.
    const lastOk = new Map<string, number>();
    for (const r of runs.data ?? []) if (r.status === 'succeeded') lastOk.set(r.kind, Math.max(lastOk.get(r.kind) ?? 0, Date.parse(r.started_at)));
    const failures = (runs.data ?? []).filter(
      (r) => ['failed', 'budget_exceeded'].includes(r.status) && Date.parse(r.started_at) > day && Date.parse(r.started_at) > (lastOk.get(r.kind) ?? 0),
    );
    return {
      runs: runRows,
      prices,
      spentDay,
      spentMonth,
      byModel,
      failures,
      totals: (Array.isArray(totals.data) ? totals.data[0] : totals.data) ?? {},
      caps: budgets.data?.value ?? {},
      backend: (version as { version?: string } | null)?.version ?? null,
      latest: (latest as { sha?: string } | null)?.sha ?? null,
    };
  });

  type R = NonNullable<typeof data>['runs'][number];
  const days = (iso?: string | null) => (iso ? (Date.now() - Date.parse(iso)) / 86_400_000 : null);
  const f = useFilters<R>({
    tab: 'activity',
    rows: data?.runs ?? [],
    sorts: [
      { key: 'new', label: 'Newest first', cmp: (a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) },
      { key: 'cost', label: 'Most expensive', cmp: (a, b) => b.total - a.total },
      { key: 'slow', label: 'Longest running', cmp: (a, b) => (dur(b) ?? -1) - (dur(a) ?? -1) },
    ],
    fields: [
      { key: 'text', label: 'Text', type: 'text', get: (r) => [r.error, r.kind].join(' ') },
      { key: 'kind', label: 'Kind', type: 'enum', group: 'Run', get: (r) => KIND[r.kind] ?? r.kind },
      { key: 'status', label: 'Status', type: 'enum', group: 'Run', get: (r) => r.status, order: ['running', 'succeeded', 'failed', 'budget_exceeded', 'skipped'] },
      { key: 'err', label: 'Has an error', type: 'bool', group: 'Run', get: (r) => Boolean(r.error) },
      { key: 'est', label: 'Cost is estimated', type: 'bool', group: 'Run', get: (r) => r.cost.estimated },
      { key: 'cost', label: 'Cost (USD)', type: 'number', group: 'Size', get: (r) => Math.round(r.total * 10000) / 10000, fmt: money },
      { key: 'tokens', label: 'Tokens', type: 'number', group: 'Size', get: (r) => r.tokens_used },
      { key: 'searches', label: 'Searches', type: 'number', group: 'Size', get: (r) => r.search_calls },
      { key: 'mins', label: 'Minutes running', type: 'number', group: 'Size', get: (r) => dur(r) },
      { key: 'age', label: 'Days ago', type: 'number', group: 'When', get: (r) => days(r.started_at) },
      { key: 'when', label: 'Started', type: 'enum', group: 'When', get: (r) => { const d = days(r.started_at) ?? 999; return d < 1 ? 'Last 24 hours' : d < 7 ? 'Last 7 days' : d < 30 ? 'Last 30 days' : 'Older'; }, order: ['Last 24 hours', 'Last 7 days', 'Last 30 days', 'Older'] },
    ],
  });
  const shownCost = f.rows.reduce((a, r) => a + r.total, 0);
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
  return (
    <FilterLayout panel={f.panel} active={f.active}>
      {data && data.failures.length > 0 && (
        <div className="banner err">
          <b>{data.failures.length} run{data.failures.length === 1 ? '' : 's'} failed or hit a budget in the last 24 hours with no successful run of that kind since.</b> Latest:{' '}
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
              <tr>
                <td>Cost today (list prices)</td>
                <td>{money(data.spentDay)}</td>
              </tr>
              <tr>
                <td>Cost this month (list prices)</td>
                <td>{money(data.spentMonth)}</td>
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
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.byModel).map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{v.calls.toLocaleString()}</td>
                  <td>{v.input.toLocaleString()}</td>
                  <td>{v.output.toLocaleString()}</td>
                  <td>{money(v.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      <Section title="Recent runs">
        {f.summary}
        {data && (
          <p className="small muted">
            Cost of the runs shown: <b>{money(shownCost)}</b>. Cost = tokens each run actually used × list price
            {data.prices.checked ? ` (checked ${data.prices.checked})` : ''}, plus searches at ${data.prices.usd_per_search ?? 0} each (Tavily's first 1,000 a month are free). "est." = no per-call log, estimated from the run's token total.
          </p>
        )}
        {data && (
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Kind</th>
                <th>Status</th>
                <th>Cost</th>
                <th>Tokens</th>
                <th>Searches</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {f.rows.map((r) => (
                <tr key={r.id}>
                  <td className="small">{new Date(r.started_at).toLocaleString()}</td>
                  <td>{KIND[r.kind] ?? r.kind}</td>
                  <td>
                    <span className={`pill ${r.status}`}>{r.status}</span>
                  </td>
                  <td title={`AI ${money(r.cost.ai)} + searches ${money(r.cost.search)}${r.cost.unpriced ? ` (+${r.cost.unpriced.toLocaleString()} tokens with no price on file)` : ''}`}>
                    {money(r.total)}
                    {r.cost.estimated && <small className="muted"> est.</small>}
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
    </FilterLayout>
  );
}
