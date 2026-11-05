// Service-role database client. Edge functions run server-side only; the
// service role key is injected by Supabase and never leaves the function.
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (!client) {
    client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

/** Throw on a Supabase error so failures surface in the run record. The
 * database is untyped here, so rows come back as `any`. */
// deno-lint-ignore no-explicit-any
export function must(res: { data: any; error: { message: string } | null }, what: string): any {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

export async function getSetting<T = Record<string, unknown>>(key: string): Promise<T> {
  const row = must(await db().from('settings').select('value').eq('key', key).maybeSingle(), `setting ${key}`);
  return (row?.value ?? {}) as T;
}

export interface Models {
  extraction: string;
  judgment: string;
  verification: string;
}
export interface Budgets {
  [k: string]: number;
}
export interface Thresholds {
  simulations: number;
  fit_score_min: number;
  shortlist_size: number;
  trend_signal_score: number;
  material_change_pct: number;
  verifier_max_margin: number;
  min_examples_for_niche: number;
  verifier_source_sample: number;
  verifier_max_year1_occupancy: number;
  day_pass_min_population_40min: number;
}

export async function defaultProfile() {
  return must(
    await db().from('parameter_profiles').select('*').eq('is_default', true).limit(1).single(),
    'default profile',
  );
}
