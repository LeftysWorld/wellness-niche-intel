# Wellness Niche Intel

Finds wellness businesses that depend on land or a structure (dark retreats, bathhouses, glamping, retreat venues…), keeps looking for new ones that already operate somewhere, matches them to the places you'd consider living, and models each pairing: startup cost, monthly profit at years 1, 3 and 5 (P10/P50/P90), break-even, cash dip, and sale price.

**The rule the whole system follows:** AI does research and judgment; code does all the arithmetic; a separate model checks the result.

## How it fits together

```
pg_cron ──▶ private.invoke() ──▶ edge function `api/<agent>` (x-cron-secret from Vault)
dashboard ─────────────────────▶ edge function `api/<agent>` (your login, checked against app_users)

discovery-loop   search → classify (Haiku) → de-dupe → example / new niche → review queue
niche-discovery  draft a model card + cost template (Sonnet) → engine smoke test → review queue
location-scout   fill missing/stale ledger values with sourced numbers (Haiku)
fit-screen       every approved niche × your regions → hard filters → quick simulation → score → shortlist
analyze-pairing  local price research → full 2,000-run simulation → store → verifier
verifier         code checks + independent review of inputs and sources (Opus)
orchestrator     tick: apply approvals, re-queue pairings hit by changed values, analyse next
                 refresh: re-scout stalest locations · digest: weekly summary
```

| Piece | Where |
|---|---|
| Calculation engine (pure TS, shared by server, browser and tests) | `supabase/functions/_shared/engine/` |
| Niche card + template + ledger → engine model | `supabase/functions/_shared/model-builder.ts` |
| Agents | `supabase/functions/<agent>/handler.ts`, routed by `supabase/functions/api/index.ts` |
| Schema, ledger trigger, RLS, seed, schedules | `supabase/migrations/` |
| Dashboard (Vite + React) | `web/` |
| Tests | `tests/` (`npm test`) |

### The assumption ledger
Every number the model uses (land price, lease, wages, taxes, prices, occupancy…) is a row in `assumptions` with a source, confidence and staleness window. Rows are never edited: a new row supersedes the old one, and if the value moves by more than 5% a `change_events` row is written. The orchestrator re-queues every analysis that depended on it. Scope wins from most to least specific: pairing → micro-area → country → global.

### Schedules (UTC)
| Job | When |
|---|---|
| orchestrator tick | hourly at :23 |
| location refresh (2 stalest locations) | daily 07:52 |
| discovery, daily slice | daily 10:41 |
| discovery, full sweep (4 pages) | Sundays 09:13–09:58 |
| niche card drafts | Sundays 12:37 |
| niche brainstorm | 1st of month 12:47 |
| fit screen | Mondays 11:17 |
| digest | Mondays 13:33 |

Each agent has a token budget and a search budget (`settings.budgets`); a run that hits it stops and is recorded as `budget_exceeded`.

## Setup

The Supabase project, schema, seed data, Vault secrets, schedules and the `api` function are already in place for project `tocukdtdeyarswmngjic`. What's left is yours:

1. **Add the API keys** (Supabase dashboard → Edge Functions → Secrets). Nobody else needs to see them.
   - `ANTHROPIC_API_KEY`
   - `TAVILY_API_KEY` — or set `SEARCH_PROVIDER=brave` and `BRAVE_API_KEY`
2. **Allow your sign-in redirect** (Authentication → URL Configuration): add `http://localhost:5173` and wherever you host the dashboard.
3. **Run the dashboard**
   ```bash
   cd web
   cp .env.example .env.local   # values are public (URL + publishable key)
   npm install && npm run dev
   ```
   Sign in with `robbyseck@gmail.com` (the only address in `app_users`).
4. **First run**, from the dashboard: Niches → *Daily discovery*; Ledger → *Scout this location* for any location with gaps; Rankings → *Run fit screen*; then approve pairings in the Review queue. The hourly tick analyses approved pairings one at a time (or press *Analyse now*).

### Recreating it on a new project
```bash
supabase link --project-ref <ref>
supabase db push                       # migrations, including seed
# then in the SQL editor: scripts/setup_vault.sql (edit <project-ref> first)
supabase functions deploy api --no-verify-jwt
supabase secrets set ANTHROPIC_API_KEY=... TAVILY_API_KEY=...
```
`--no-verify-jwt` is intentional: the function does its own auth (scheduler secret or an `app_users` login).

## Development
```bash
npm test                     # engine + model builder (Node ≥ 22.18, no install needed)
npm run typecheck:functions  # edge functions, with a small Deno shim
```
CI also runs `deno check` on the functions and builds the dashboard.

Regenerate the seed after editing niche cards or the starting ledger: `python3 scripts/build_seed.py`.

## Changing the defaults
- Your goals, capital, regions and exclusions: `parameter_profiles` ("Robby — default").
- Models, budgets, thresholds, discovery queries: `settings`.
- A number you know better than the agents: Ledger → *Override*. It's recorded as `written_by = user` and triggers re-analysis.
