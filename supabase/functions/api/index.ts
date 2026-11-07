// Single entry point for every agent: POST /functions/v1/api/<agent>.
// One deployment, one URL; the scheduler and dashboard both call through here.
import { authorize } from '../_shared/auth.ts';
import { handler, HttpError } from '../_shared/http.ts';
import { run as agentResume } from '../agent-resume/handler.ts';
import { run as analyzePairing } from '../analyze-pairing/handler.ts';
import { run as backtestCollector } from '../backtest-collector/handler.ts';
import { run as discoveryLoop } from '../discovery-loop/handler.ts';
import { run as evals } from '../evals/handler.ts';
import { run as fitScreen } from '../fit-screen/handler.ts';
import { run as locationFit } from '../location-fit/handler.ts';
import { run as locationIdeas } from '../location-ideas/handler.ts';
import { run as locationScout } from '../location-scout/handler.ts';
import { run as nicheBuilder } from '../niche-builder/handler.ts';
import { run as nicheDiscovery } from '../niche-discovery/handler.ts';
import { run as orchestrator } from '../orchestrator/handler.ts';
import { run as siteCheck } from '../site-check/handler.ts';
import { run as verifier } from '../verifier/handler.ts';

const routes: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
  'agent-resume': agentResume,
  'analyze-pairing': analyzePairing,
  'backtest-collector': backtestCollector,
  'discovery-loop': discoveryLoop,
  evals,
  'fit-screen': fitScreen,
  'location-fit': locationFit,
  'location-ideas': locationIdeas,
  'location-scout': locationScout,
  'niche-builder': nicheBuilder,
  'niche-discovery': nicheDiscovery,
  orchestrator,
  'site-check': siteCheck,
  verifier,
};

// The commit the backend runs: set by the Vercel deploy, or part of the URL when deployed pinned.
const VERSION = import.meta.url.match(/\/([0-9a-f]{40})\//)?.[1] ?? Deno.env.get('BACKEND_VERSION') ?? 'local';

Deno.serve(
  handler(async (body, req) => {
    const name = new URL(req.url).pathname.split('/').filter(Boolean).pop() ?? '';
    if (name === 'version') return { version: VERSION };
    const route = routes[name];
    if (!route) throw new HttpError(404, `Unknown agent "${name}". Use one of: ${Object.keys(routes).join(', ')}`);
    return route(body);
  }, authorize),
);
