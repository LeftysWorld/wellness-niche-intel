// Single entry point for every agent: POST /functions/v1/api/<agent>.
// One deployment, one URL; the scheduler and dashboard both call through here.
import { authorize } from '../_shared/auth.ts';
import { handler, HttpError } from '../_shared/http.ts';
import { run as analyzePairing } from '../analyze-pairing/handler.ts';
import { run as discoveryLoop } from '../discovery-loop/handler.ts';
import { run as fitScreen } from '../fit-screen/handler.ts';
import { run as locationScout } from '../location-scout/handler.ts';
import { run as nicheDiscovery } from '../niche-discovery/handler.ts';
import { run as orchestrator } from '../orchestrator/handler.ts';
import { run as verifier } from '../verifier/handler.ts';

const routes: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
  'analyze-pairing': analyzePairing,
  'discovery-loop': discoveryLoop,
  'fit-screen': fitScreen,
  'location-scout': locationScout,
  'niche-discovery': nicheDiscovery,
  orchestrator,
  verifier,
};

Deno.serve(
  handler(async (body, req) => {
    const name = new URL(req.url).pathname.split('/').filter(Boolean).pop() ?? '';
    const route = routes[name];
    if (!route) throw new HttpError(404, `Unknown agent "${name}". Use one of: ${Object.keys(routes).join(', ')}`);
    return route(body);
  }, authorize),
);
