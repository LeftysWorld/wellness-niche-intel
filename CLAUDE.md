# Working on this repo

- **Money math lives only in `supabase/functions/_shared/engine/`.** Agents never compute profit, cost or value in prompts; they write sourced inputs to the ledger and the engine does the rest. Keep the engine dependency-free and deterministic (seeded RNG) so server, browser and tests agree.
- The engine must run under Node type-stripping: explicit `.ts` import extensions, erasable TypeScript only (no enums, namespaces or parameter properties).
- Never update `assumptions` rows. Insert a new row; the trigger supersedes the old one and records change events.
- Research is done by tool-using agents (`_shared/agent.ts`). An agent is an `AgentDef` in `_shared/agents/` (tools, task, finish schema, `onFinish`) plus a playbook `supabase/functions/agents/<name>.md`; register it in `_shared/agents/index.ts`. After editing a playbook run `node scripts/build_playbooks.mjs` (a test fails if the compiled module is stale).
- Rules live in tools, not prompts: a figure is recorded only with an exact quote found on a page the session saw (`confirmQuote`), values are committed through `consensus`/`sumParts`, and money is computed by the engine. Tools throw `ToolError` to tell the model what to fix.
- Single structured judgments (critic, verifier) use `ask()`; agent turns use `messages()`. Both log tokens (with cache reads/writes) to `spend_log` and enforce budgets. Only write values whose `source_url` the run actually saw.
- Never put the held-out niche list (`_shared/evals/held-out-niches.ts`) or answer-key values into a playbook or prompt; a test checks the playbooks.
- New entry points: add `supabase/functions/<name>/handler.ts` exporting `run(body)`, register it in `api/index.ts`, and schedule it with `private.invoke('<name>', ...)` in a migration. Long work starts an agent session (`startAgent`, `background: true` from the app) rather than running inside one request.
- Edge function auth is custom (`_shared/auth.ts`); deploy with JWT verification off.
- Run `scripts/check.sh` before committing, and `scripts/sql_tests.sql` against the project after any migration. The Vercel build runs the same checks (`web` → `npm run checks`) and blocks the deploy on failure.
- Name a new migration file with the version the live history assigns, so repo and database match.
- Money results are monthly averages per operating year (`year1/3/5`), after loan payments; `takeHome` is after estimated income tax. Never report a single month as "year 1".
- Every number shown to the owner carries where it came from (sourced vs estimate); keep `evidence` flowing from the model builder to the UI.
