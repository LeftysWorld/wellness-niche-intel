// Minimal declarations so `tsc` can type-check edge functions without the Deno
// toolchain. CI also runs `deno check` with the real types.
declare namespace Deno {
  const env: { get(key: string): string | undefined };
  function serve(handler: (req: Request) => Response | Promise<Response>): unknown;
}
declare module 'jsr:@supabase/supabase-js@2' {
  // deno-lint-ignore no-explicit-any
  export type SupabaseClient = any;
  // deno-lint-ignore no-explicit-any
  export function createClient(url: string, key: string, opts?: unknown): any;
}
