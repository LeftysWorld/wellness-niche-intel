import { createClient } from '@supabase/supabase-js';

// Both values are public by design: what a signed-in user can read or do is
// enforced in the database (row-level security) and in the edge function.
export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);

/** The single owner account (created in Supabase with Auto Confirm; never emailed). */
export const OWNER_EMAIL: string = import.meta.env.VITE_OWNER_EMAIL || 'owner@wellness-niche-intel.app';

/** Call an agent through the api edge function with the signed-in user's session. */
export async function callAgent(agent: string, body: Record<string, unknown> = {}) {
  const { data, error } = await supabase.functions.invoke(`api/${agent}`, { body });
  if (error) {
    const detail = await (error as { context?: Response }).context?.json?.().catch(() => null);
    throw new Error(detail?.error ?? error.message);
  }
  return data;
}

export const usd = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString()}`;
