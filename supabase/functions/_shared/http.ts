// Small HTTP helpers shared by every function.
export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Wrap a handler with CORS, auth and error handling. */
export function handler(
  fn: (body: Record<string, unknown>, req: Request) => Promise<unknown>,
  auth: (req: Request) => Promise<{ caller: string }>,
) {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
    try {
      const { caller } = await auth(req);
      const body = req.headers.get('content-type')?.includes('json') ? await req.json().catch(() => ({})) : {};
      const result = await fn({ ...body, _caller: caller }, req);
      return json(result ?? { ok: true });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      console.error(e);
      return json({ error: e instanceof Error ? e.message : String(e) }, status);
    }
  };
}
