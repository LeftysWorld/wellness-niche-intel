# Wellness Niche Intel

Finds wellness businesses that depend on land or a structure (dark retreats, bathhouses, glamping, retreat venues…), keeps looking for new ones that already operate somewhere, matches them to the places you'd consider living, and models each pairing: startup cost, monthly profit at years 1, 3 and 5 (P10/P50/P90), break-even, cash dip, and sale price.

**The rule the whole system follows:** AI does research and judgment; code does all the arithmetic; a separate model checks the result.

**What the money figures mean.** "Year 1 /mo" is the average month in the first year *after opening*, after loan payments, a 3% repair reserve and estimated income tax (switch to before-tax in Settings). The build or fit-out period before opening is modelled separately: rent, part of the running costs and loan interest are paid with no revenue. A solo owner works up to their monthly hours (Settings); any opening hours beyond that are paid for by the hour. A loan only counts if profit covers the payment 1.25× in years 1–2 and you put in at least 25%. Every idea shows how much of its data is sourced versus estimated.

## How it fits together

```
pg_cron ──▶ private.invoke() ──▶ edge function `api/<agent>` (x-cron-secret from Vault)
dashboard ─────────────────────▶ edge function `api/<agent>` (your login, checked against app_users)

discovery-loop   search → classify (Haiku) → de-dupe → example / new niche → review queue
niche-discovery  draft a model card + cost template (Sonnet) → engine smoke test → review queue
location-scout   fill missing/stale ledger values with sourced numbers (Haiku)
location-fit     judge each place against your own description (Sonnet)
site-check       can each place physically host each niche (hot spring, acreage, public use)? (Sonnet)
location-ideas   suggest new places that match your description (Sonnet)
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
| Scoring (money-first ranking, editable weights) | `supabase/functions/_shared/scoring.ts` |
| Schema, ledger trigger, RLS, seed, schedules | `supabase/migrations/` (file names match the live migration history) |
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
| exchange rates | Sundays 08:47 |
| place scores vs your description | Mondays 10:47 |
| site checks | Mondays 10:57 |
| fit screen | Mondays 11:17 |
| digest | Mondays 13:33 |

Each run has its own token and search budget, and all runs together share daily and monthly caps (`settings.budgets`: 1.5M tokens a day, 15M a month, 150 searches a day, 900 a month, inside Tavily's 1,000 free). A run that hits a cap stops as `budget_exceeded`; the Activity page shows usage against the caps and flags any failures in the last 24 hours. Jobs that must not overlap (analysis, refresh, fit screen, site checks) take a lock, and runs that die mid-way are marked failed after 30 minutes.

## Setup

Supabase holds the database, the AI agents and the schedules. Vercel only hosts the web app.

**Secrets live in Supabase, never in Vercel.** `ANTHROPIC_API_KEY` and `TAVILY_API_KEY` (or `SEARCH_PROVIDER=brave` + `BRAVE_API_KEY`) go under Supabase → Edge Functions → Secrets, because that's where the agents run. The web app runs in the browser, so anything given to it is public. It only gets the Supabase URL and the publishable key, both safe to expose.

**Signing in.** One owner account, one password, no email:
1. Supabase → Authentication → Users → *Add user* → *Create new user*.
2. Email `owner@wellness-niche-intel.app`, a password of your choice, and tick **Auto Confirm User**. No email is sent.
3. Sign in to the web app with that password.

Only addresses in `app_users` can read data or run agents. Anyone else who signs up sees nothing.

**Web app** (deployed on Vercel from `web/`, redeploys on every push to `main`). To run it locally:
```bash
cd web && cp .env.example .env.local && npm install && npm run dev
```

**Using it.** The app has three main pages:
- **Niches**: wellness concepts that need land or a building. *Discover new niches* finds unusual ones; *Write up* researches one (how it works, what's different, real examples, rough economics). Star the ones you like and press *Use this niche* to pair it with your places.
- **Locations**: describe what you want in a place, add and star your own places, and get *Suggested places* that match your description. Each place gets a 0–10 match score with pros and cons, plus sourced local costs.
- **Business ideas**: every niche you use × every place you keep, ranked by fit, money and your description. *Analyse this idea* runs the full analysis (local price research, 2,000-run simulation, independent check).

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
scripts/check.sh             # tests (engine, builder, scoring, schemas) + function type-check
```
After any migration, run `scripts/sql_tests.sql` against the project (it rolls back its own writes).

New migrations: apply them, then save the file under the version the live history shows (`list_migrations` / `supabase migration list`) so the repo and the database never drift.

## Deploying
CI (`.github/workflows/ci.yml`) runs the checks and, on `main`, pushes migrations, deploys the `api` function and smoke-tests it. It needs two repository secrets: `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD`. **GitHub Actions is currently refused for this account because of a billing lock; fix that in GitHub → Settings → Billing.** Until then, deploy by hand with `supabase functions deploy api --no-verify-jwt`; the Activity page warns when the live backend is behind GitHub `main`.

Regenerate the seed after editing niche cards or the starting ledger: `python3 scripts/build_seed.py`.

## Changing the defaults
- Your goals, capital, regions and exclusions: `parameter_profiles` ("Robby — default").
- Models, budgets, thresholds, discovery queries: `settings`.
- A number you know better than the agents: Ledger → *Override*. It's recorded as `written_by = user` and triggers re-analysis.
