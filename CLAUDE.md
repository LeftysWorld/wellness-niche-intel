# Working on this repo

- **Money math lives only in `supabase/functions/_shared/engine/`.** Agents never compute profit, cost or value in prompts; they write sourced inputs to the ledger and the engine does the rest. Keep the engine dependency-free and deterministic (seeded RNG) so server, browser and tests agree.
- The engine must run under Node type-stripping: explicit `.ts` import extensions, erasable TypeScript only (no enums, namespaces or parameter properties).
- Never update `assumptions` rows. Insert a new row; the trigger supersedes the old one and records change events.
- Every agent works inside `withRun()` and calls the model only through `ask()` (structured outputs: a JSON schema the reply must match, tokens logged to `spend_log`, budget enforced). Only write values whose `source_url` came back in that run's search results.
- New agents: add `supabase/functions/<name>/handler.ts` exporting `run(body)`, register it in `api/index.ts`, and schedule it with `private.invoke('<name>', ...)` in a migration.
- Edge function auth is custom (`_shared/auth.ts`); deploy with JWT verification off.
- Run `scripts/check.sh` before committing, and `scripts/sql_tests.sql` against the project after any migration. The Vercel build runs the same checks (`web` → `npm run checks`) and blocks the deploy on failure.
- Name a new migration file with the version the live history assigns, so repo and database match.
- Money results are monthly averages per operating year (`year1/3/5`), after loan payments; `takeHome` is after estimated income tax. Never report a single month as "year 1".
- Every number shown to the owner carries where it came from (sourced vs estimate); keep `evidence` flowing from the model builder to the UI.
