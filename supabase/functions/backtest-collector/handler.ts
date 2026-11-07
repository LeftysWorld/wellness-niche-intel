// Collect backtest cases: real businesses with stated revenue (see agents/backtest-collector.md).
import { startAgent } from '../_shared/agent.ts';
import { backtestCollector } from '../_shared/agents/index.ts';

export async function run(body: Record<string, unknown>) {
  return await startAgent(backtestCollector, { target: Number(body.target ?? 6) }, { input: body, background: String(body._caller ?? '').startsWith('user:') });
}
