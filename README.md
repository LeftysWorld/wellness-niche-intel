# Wellness Niche Intel

Finds wellness businesses that depend on land or a structure (dark retreats, bathhouses, glamping, retreat venues…), keeps looking for new ones that already operate somewhere, matches them to the places you'd consider living, and models each pairing: startup cost, monthly profit at years 1, 3 and 5 (P10/P50/P90), break-even, cash dip, and sale price.

**The rule the whole system follows:** AI does research and judgment; code does all the arithmetic; a separate model checks the result.

**The research is done by agents.** The location scout, the idea analyst, the niche scout and the backtest collector are tool-using agents: each has a playbook (`supabase/functions/agents/*.md`), a set of tools (search, read a page, record a figure with its exact quote, commit a value, run the model, record a competitor…), and a loop in which the model decides what to do next until it calls `finish`. The tools enforce the rules in code: a quote must be on the page, a value needs figures from separate sites, totals and medians are computed, budgets are hard limits. Every step is logged (`agent_steps`) and shown on the Activity page.

**What the money figures mean.** "Year 1 /mo" is the average month in the first year *after opening*, after loan payments, a 3% repair reserve and estimated income tax (switch to before-tax in Settings). The build or fit-out period before opening is modelled separately: rent, part of the running costs and loan interest are paid with no revenue. A solo owner works up to their monthly hours (Settings); any opening hours beyond that are paid for by the hour. A loan only counts if profit covers the payment 1.25× in years 1–2 and you put in at least 25%. Every idea shows how much of its data is sourced versus estimated.

## How it fits together

```
pg_cron ──▶ private.invoke() ──▶ edge function `api/<agent>` (x-cron-secret from Vault)
dashboard ─────────────────────▶ edge function `api/<agent>` (your login, checked against app_users)

discovery-loop   search → classify (Haiku) → de-dupe → example / new niche → review queue
niche-discovery  draft a model card + cost template (Sonnet) → engine smoke test → review queue
                 mode=brainstorm → niche-scout agent: plans angles, finds ≥2 real operators per
                 idea, code intake rules + independent critic (Opus) → review queue
location-scout   location-scout agent: picks sources per value, reads pages, records quoted
                 figures, commits medians with confidence from agreeing sites (Sonnet)
location-fit     judge each place against your own description (Sonnet)
site-check       can each place physically host each niche (hot spring, acreage, public use)? (Sonnet)
location-ideas   suggest new places that match your description (Sonnet)
fit-screen       every approved niche × your regions → hard filters → quick simulation → score → shortlist
analyze-pairing  pairing-analyst agent: run model → research the guessed inputs that move profit
                 most (prices, occupancy, place values) → map competition → re-run until the
                 P10–P90 band is narrow → memo (verdict, risks, kill criteria, cheapest tests)
                 → full 2,000-run simulation → store → verifier (background)
agent-resume     continue an agent session in a fresh call (sessions span several calls)
evals            quality checks against targets: answer key, coverage, brainstorm recall,
                 backtests, analysis; live scout tests in test mode
backtest-collector  backtest-collector agent: businesses for sale with stated revenue
verifier         code checks + independent review of inputs and sources (Opus)
orchestrator     tick: apply approvals, re-queue pairings hit by changed values, analyse next
                 refresh: re-scout stalest locations · digest: weekly summary
```

| Piece | Where |
|---|---|
| Calculation engine (pure TS, shared by server, browser and tests) | `supabase/functions/_shared/engine/` |
| Niche card + template + ledger → engine model | `supabase/functions/_shared/model-builder.ts` |
| Entry points | `supabase/functions/<name>/handler.ts`, routed by `supabase/functions/api/index.ts` |
| Agent loop (sessions, slices, tracing, caching) | `supabase/functions/_shared/agent.ts`, `history.ts`, `llm.ts` |
| Agent definitions and tools | `supabase/functions/_shared/agents/`, `agent-tools.ts` |
| Agent playbooks (edit these to change how an agent works) | `supabase/functions/agents/*.md` → compiled to `_shared/playbooks.ts` |
| Quality checks: answer key, held-out niches, graders | `supabase/functions/_shared/evals/`, `supabase/functions/evals/handler.ts` |
| Scoring (money-first ranking, editable weights) | `supabase/functions/_shared/scoring.ts` |
| Schema, ledger trigger, RLS, seed, schedules | `supabase/migrations/` (file names match the live migration history) |
| Dashboard (Vite + React) | `web/` |
| Tests | `tests/` (`npm test`) |

### Evidence is gathered automatically
Nothing waits for the owner to supply data. The location scout collects every figure it can find for a value across several searches, checks each quote against its page, drops outliers, and writes the median; confidence comes from how many separate sites agree (3+ agreeing sites = high). A value it can't find is retried with a different strategy each time (listing searches, then official statistics and listing portals, then the wider region), then again monthly. The daily refresh goes to the places with the most estimated or missing values first.

### How agents run
A session starts with the agent's playbook and a task. Each turn the model may call several tools; results go back to it, and it decides the next step. Prompts are cached (system prompt, tools and conversation so far), so each turn pays full price only for what is new; judgment-heavy agents use extended thinking. A function call runs one time slice (`settings.agents.slice_seconds`); if the work is not done the session is saved and continues in a fresh call. The hourly tick re-queues any session that stalled. Turn limits and token and search budgets per agent are in `settings.agents`; the shared daily and monthly caps still apply. `mode=classic` (scout) or `agent=false` (analysis, brainstorm) runs the earlier fixed pipelines.

### Quality checks
`evals` runs every Monday and stores scores in `eval_results` (latest on the Activity page):
| Check | Target |
|---|---|
| Ledger values inside the answer key (`_shared/evals/answer-key.ts`, sourced by hand) | ≥ 85% |
| Scout finds the right value from scratch (test mode, nothing written) | ≥ 85% |
| Place values sourced at medium confidence or better | ≥ 80% |
| Held-out known formats the library has found (never shown to the niche scout) | ≥ 80% |
| New niches that were junk (rejected, identifier names, no examples) | ≤ 5% |
| Real revenues inside the predicted P10–P90 range (backtests) | about 80% |
| Analyses passing the independent check | ≥ 70% |

Extend the answer key as you verify values; every entry needs sources and an accepted range.

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
| quality checks | Mondays 14:07 |
| backtest collection | Thursdays 13:19 |

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

Optional: `GOOGLE_MAPS_API_KEY` (Places API) gives the analyst a `find_places` tool for counting competitors with ratings and review counts.

## Development
```bash
scripts/check.sh             # tests (engine, builder, scoring, schemas, agents) + function type-check
node scripts/build_playbooks.mjs   # after editing supabase/functions/agents/*.md
```
After any migration, run `scripts/sql_tests.sql` against the project (it rolls back its own writes).

New migrations: apply them, then save the file under the version the live history shows (`list_migrations` / `supabase migration list`) so the repo and the database never drift.

## Deploying
Vercel is the CI. Every push to `main` triggers a Vercel build that:
1. runs all code tests and type-checks the edge functions (a failure stops the deploy),
2. builds and type-checks the web app,
3. on production builds only, deploys the backend from the same commit: `supabase db push`, then the `api` function, then a smoke test (`web/scripts/deploy-backend.mjs`).

Step 3 needs two Vercel environment variables, Production only, marked Sensitive: `SUPABASE_ACCESS_TOKEN` (a Supabase personal access token) and `SUPABASE_DB_PASSWORD`. Without them the backend step is skipped and the app still deploys. They have no `VITE_` prefix, so they are never bundled into the browser. The Activity page warns if the live backend is behind GitHub `main`.

## Changing the defaults
- Your goals, capital, regions and exclusions: `parameter_profiles` ("Robby — default").
- Models, budgets, thresholds, discovery queries: `settings`.
