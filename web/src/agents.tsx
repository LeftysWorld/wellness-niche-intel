// Agent sessions, their step-by-step traces, quality scores, and the analyst's memo.
import { Fragment, useState } from 'react';
import { callAgent, supabase, usd } from './supabase.ts';
import { Err, Loading, RunButton, Section, useLoad } from './ui.tsx';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const AGENT_LABEL: Record<string, string> = {
  'location-scout': 'Location scout',
  'pairing-analyst': 'Idea analyst',
  'niche-scout': 'Niche scout',
  'backtest-collector': 'Backtest collector',
};

const METRIC: Record<string, { label: string; fmt: 'pct' | 'num'; lowerIsBetter?: boolean }> = {
  'ledger:accuracy': { label: 'Ledger values inside the answer key', fmt: 'pct' },
  'coverage:sourced_medium_plus': { label: 'Place values sourced (medium confidence or better)', fmt: 'pct' },
  'coverage:sourced_any': { label: 'Place values sourced (any confidence)', fmt: 'pct' },
  'brainstorm:held_out_recall': { label: 'Known formats the library has found', fmt: 'pct' },
  'brainstorm:junk_rate': { label: 'New niches that were junk', fmt: 'pct', lowerIsBetter: true },
  'brainstorm:critic_acceptance': { label: 'Proposals the critic accepted', fmt: 'pct' },
  'backtest:revenue_p10_p90_coverage': { label: 'Real revenues inside the predicted range', fmt: 'pct' },
  'backtest:revenue_median_log_error': { label: 'Typical revenue error (log)', fmt: 'num', lowerIsBetter: true },
  'backtest:sale_multiple_coverage': { label: 'Real sale multiples inside the range', fmt: 'pct' },
  'analysis:verifier_pass_share': { label: 'Analyses passing the independent check', fmt: 'pct' },
  'analysis:median_final_band': { label: 'Uncertainty left after research (band)', fmt: 'num', lowerIsBetter: true },
};

const fmt = (v: number | null, f: 'pct' | 'num') => (v === null || v === undefined ? '—' : f === 'pct' ? `${Math.round(Number(v) * 100)}%` : String(Math.round(Number(v) * 100) / 100));

/** Latest score per quality metric, against its target. */
export function QualityPanel() {
  const { data, error, reload } = useLoad(async () => {
    const { data, error } = await supabase.from('latest_evals').select('*').order('suite');
    if (error) throw error;
    return data ?? [];
  });
  const scoutLive = (data ?? []).filter((r: Any) => r.suite === 'scout_live');
  const live = scoutLive.length ? scoutLive.filter((r: Any) => r.passed).length / scoutLive.length : null;
  const rows = (data ?? []).filter((r: Any) => r.suite !== 'scout_live');
  return (
    <Section title="Quality checks" actions={<RunButton label="Run quality checks" action={() => callAgent('evals', {})} onDone={reload} />}>
      <Err error={error} />
      {!data ? (
        <Loading />
      ) : !data.length ? (
        <p className="muted">No checks yet. They run every Monday, or press <i>Run quality checks</i>.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Check</th>
              <th>Score</th>
              <th>Target</th>
              <th>Sample</th>
              <th>Checked</th>
            </tr>
          </thead>
          <tbody>
            {live !== null && (
              <tr>
                <td title="The scout researches answer-key values from scratch in test mode">Scout finds the right value (live test)</td>
                <td>
                  <span className={`pill ${live >= 0.85 ? 'ok' : 'bad'}`}>{Math.round(live * 100)}%</span>
                </td>
                <td>85%</td>
                <td>{scoutLive.length}</td>
                <td className="small">{new Date(scoutLive[0].created_at).toLocaleDateString()}</td>
              </tr>
            )}
            {rows.map((r: Any) => {
              const m = METRIC[`${r.suite}:${r.metric}`] ?? { label: `${r.suite} · ${r.metric}`, fmt: 'num' as const };
              return (
                <tr key={`${r.suite}:${r.metric}`}>
                  <td title={r.details ? JSON.stringify(r.details).slice(0, 600) : ''}>{m.label}</td>
                  <td>
                    <span className={`pill ${r.passed === true ? 'ok' : r.passed === false ? 'bad' : ''}`}>{fmt(r.value, m.fmt)}</span>
                  </td>
                  <td>{r.target === null ? '—' : `${m.lowerIsBetter ? '≤ ' : ''}${fmt(r.target, m.fmt)}`}</td>
                  <td>{r.sample_size ?? '—'}</td>
                  <td className="small">{new Date(r.created_at).toLocaleDateString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="small muted">
        Grey scores have too small a sample to judge yet. The answer key lives in <code>supabase/functions/_shared/evals/answer-key.ts</code>; backtest cases are collected weekly.
      </p>
    </Section>
  );
}

/** One session's trace: each model turn and tool call, in order. */
function Steps({ sessionId }: { sessionId: string }) {
  const { data, error } = useLoad(async () => {
    const { data, error } = await supabase.from('agent_steps').select('id,turn,tool,input,output,ok,tokens,created_at').eq('session_id', sessionId).order('id').limit(400);
    if (error) throw error;
    return data ?? [];
  }, [sessionId]);
  if (error) return <Err error={error} />;
  if (!data) return <Loading />;
  return (
    <ol className="steps small">
      {data.map((s: Any) => (
        <li key={s.id} className={s.ok ? '' : 'err'}>
          <b>{s.tool ?? 'thinks'}</b>
          {s.tool && s.input && <code> {JSON.stringify(s.input).slice(0, 220)}</code>}
          {s.output && <div className="muted">{String(s.output).slice(0, 400)}</div>}
        </li>
      ))}
    </ol>
  );
}

/** Recent agent sessions with what each did. */
export function AgentSessions() {
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, reload } = useLoad(async () => {
    const { data, error } = await supabase
      .from('agent_sessions')
      .select('id,agent,status,turns,slices,error,result,created_at,updated_at,run_id')
      .order('created_at', { ascending: false })
      .limit(40);
    if (error) throw error;
    return data ?? [];
  });
  return (
    <Section
      title="Agents"
      actions={
        <>
          <RunButton label="Brainstorm new niches" action={() => callAgent('niche-discovery', { mode: 'brainstorm' })} onDone={reload} />
          <RunButton label="Collect backtest cases" action={() => callAgent('backtest-collector', {})} onDone={reload} />
          <button onClick={reload}>Refresh</button>
        </>
      }
    >
      <Err error={error} />
      {!data ? (
        <Loading />
      ) : !data.length ? (
        <p className="muted">No agent sessions yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Started</th>
              <th>Agent</th>
              <th>Status</th>
              <th>Turns</th>
              <th>Outcome</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((s: Any) => (
              <Fragment key={s.id}>
                <tr>
                  <td className="small">{new Date(s.created_at).toLocaleString()}</td>
                  <td>{AGENT_LABEL[s.agent] ?? s.agent}</td>
                  <td>
                    <span className={`pill ${s.status}`}>{s.status}</span>
                  </td>
                  <td>{s.turns}</td>
                  <td className="small">{s.error ?? s.result?.summary ?? s.result?.headline ?? ''}</td>
                  <td>
                    <button className="link" onClick={() => setOpen(open === s.id ? null : s.id)}>
                      {open === s.id ? 'Hide steps' : 'Steps'}
                    </button>
                  </td>
                </tr>
                {open === s.id && (
                  <tr>
                    <td colSpan={6}>
                      <Steps sessionId={s.id} />
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

/** The analyst's memo, research rounds and competition for one idea, plus a running session if any. */
export function AnalystPanel({ pairingId, result }: { pairingId: string; result: Any }) {
  const [showSteps, setShowSteps] = useState(false);
  const { data } = useLoad(async () => {
    const { data } = await supabase
      .from('agent_sessions')
      .select('id,status,turns,error,created_at')
      .eq('agent', 'pairing-analyst')
      .eq('subject_id', pairingId)
      .order('created_at', { ascending: false })
      .limit(1);
    return data?.[0] ?? null;
  }, [pairingId]);
  const memo = result?.memo;
  const research = result?.research;
  const running = data && ['running', 'paused'].includes(data.status);
  if (!memo && !research && !data) return null;
  return (
    <div className="card inner">
      {running && (
        <p className="banner small">
          The analyst is researching this idea ({data.turns} steps so far). Results appear here when it finishes; reload in a few minutes.
        </p>
      )}
      {data?.status === 'failed' && !memo && <p className="banner err small">The last analyst session stopped: {data.error}</p>}
      {memo && (
        <>
          <h3>
            Analyst verdict: <span className={`pill ${memo.verdict === 'pursue' ? 'ok' : memo.verdict === 'avoid' ? 'bad' : 'warn'}`}>{memo.verdict}</span>
          </h3>
          <p>
            <b>{memo.headline}</b>
          </p>
          <div className="cols">
            <div>
              <h4>Biggest risks</h4>
              <ul>{(memo.risks ?? []).map((x: string) => <li key={x}>{x}</li>)}</ul>
            </div>
            <div>
              <h4>Stop if</h4>
              <ul>{(memo.kill_criteria ?? []).map((x: string) => <li key={x}>{x}</li>)}</ul>
            </div>
            <div>
              <h4>Cheapest ways to test it</h4>
              <ul>{(memo.cheapest_validation ?? []).map((x: string) => <li key={x}>{x}</li>)}</ul>
            </div>
          </div>
          <p className="small">
            <b>What would change the verdict:</b> {memo.what_would_change_my_mind}
          </p>
          <p className="small muted">{memo.research_summary}</p>
        </>
      )}
      {research?.rounds?.length > 0 && (
        <table className="small">
          <thead>
            <tr>
              <th>Research round</th>
              <th>Year-1 take-home (middle)</th>
              <th>Year-3 take-home (middle)</th>
              <th>Uncertainty band</th>
              <th>Place values sourced</th>
            </tr>
          </thead>
          <tbody>
            {research.rounds.map((r: Any, i: number) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>{usd(r.year1)}</td>
                <td>{usd(r.year3)}</td>
                <td>{r.band}</td>
                <td>{Math.round((r.sourcedShare ?? 0) * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {research?.competitors?.length > 0 && (
        <p className="small">
          <b>Competition found:</b>{' '}
          {research.competitors.map((c: Any, i: number) => (
            <span key={c.url}>
              {i ? ', ' : ''}
              <a href={c.url} target="_blank" rel="noreferrer">
                {c.name}
              </a>{' '}
              (~{c.drive_minutes} min{c.same_kind ? '' : ', different offer'})
            </span>
          ))}
        </p>
      )}
      {data && (
        <p className="small">
          <button className="link" onClick={() => setShowSteps(!showSteps)}>
            {showSteps ? 'Hide what the analyst did' : 'Show what the analyst did'}
          </button>
        </p>
      )}
      {showSteps && data && <Steps sessionId={data.id} />}
    </div>
  );
}
