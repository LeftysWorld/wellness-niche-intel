// Standalone entry point (deploy with the Supabase CLI if you prefer one function per agent).
import { authorize } from '../_shared/auth.ts';
import { handler } from '../_shared/http.ts';
import { run } from './handler.ts';

Deno.serve(handler(run, authorize));
