// Every agent, by name (the name is stored on each session so a later call can resume it).
import type { AgentDef } from '../agent.ts';
import { backtestCollector } from './backtest-collector.ts';
import { locationScout } from './location-scout.ts';
import { nicheScout } from './niche-scout.ts';
import { pairingAnalyst } from './pairing-analyst.ts';
import { redTeam } from './red-team.ts';

// deno-lint-ignore no-explicit-any
export const AGENTS: Record<string, AgentDef<any>> = {
  [locationScout.name]: locationScout,
  [pairingAnalyst.name]: pairingAnalyst,
  [nicheScout.name]: nicheScout,
  [backtestCollector.name]: backtestCollector,
  [redTeam.name]: redTeam,
};

export { backtestCollector, locationScout, nicheScout, pairingAnalyst, redTeam };
