-- Tool-using agents: sessions that span several function calls, a trace of
-- every tool call, evaluation results, and backtest cases.

-- Long agent sessions keep their run alive with a heartbeat; the reaper that
-- marks dead runs failed looks at the heartbeat, not the start time.
alter table runs add column if not exists heartbeat_at timestamptz;
update runs set heartbeat_at = coalesce(finished_at, started_at) where heartbeat_at is null;
alter table runs alter column heartbeat_at set default now();
create index if not exists runs_running_heartbeat on runs (status, heartbeat_at);

-- Prompt caching: cache writes and reads are logged separately.
alter table spend_log add column if not exists cache_read_tokens int not null default 0;
alter table spend_log add column if not exists cache_write_tokens int not null default 0;

create table if not exists agent_sessions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references runs(id) on delete set null,
  agent text not null,
  subject_id uuid,
  params jsonb not null default '{}'::jsonb,
  messages jsonb not null default '[]'::jsonb,
  scratch jsonb not null default '{}'::jsonb,
  status text not null default 'running' check (status in ('running', 'paused', 'finished', 'failed', 'budget_exceeded')),
  turns int not null default 0,
  slices int not null default 0,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists agent_sessions_status on agent_sessions (status, updated_at);
create index if not exists agent_sessions_subject on agent_sessions (subject_id, created_at desc);
create index if not exists agent_sessions_agent on agent_sessions (agent, created_at desc);

create table if not exists agent_steps (
  id bigint generated always as identity primary key,
  session_id uuid not null references agent_sessions(id) on delete cascade,
  turn int not null,
  tool text,
  input jsonb,
  output text,
  ok boolean not null default true,
  tokens int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists agent_steps_session on agent_steps (session_id, id);

create table if not exists eval_results (
  id uuid primary key default gen_random_uuid(),
  suite text not null,
  metric text not null,
  value numeric,
  target numeric,
  passed boolean,
  sample_size int,
  details jsonb not null default '{}'::jsonb,
  run_id uuid references runs(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists eval_results_suite on eval_results (suite, metric, created_at desc);

create or replace view latest_evals with (security_invoker = true) as
  select distinct on (suite, metric) * from eval_results order by suite, metric, created_at desc;

create table if not exists backtest_cases (
  id uuid primary key default gen_random_uuid(),
  niche_id uuid references niches(id) on delete cascade,
  business_name text not null,
  url text not null unique,
  locality text,
  country_code text not null,
  annual_revenue_usd numeric,
  sde_usd numeric,
  asking_price_usd numeric,
  units numeric,
  unit_label text,
  quotes jsonb not null default '{}'::jsonb,
  status text not null default 'ready' check (status in ('ready', 'excluded')),
  run_id uuid references runs(id) on delete set null,
  created_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['agent_sessions', 'agent_steps', 'eval_results', 'backtest_cases'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_app_user())', t || '_read', t);
  end loop;
end $$;
create policy backtest_cases_decide on backtest_cases for update to authenticated using (is_app_user()) with check (is_app_user());

-- Agent settings: turn limits, per-run budgets, how long one function call may
-- run before the session pauses and continues in a fresh call, and when the
-- analyst may stop researching (P10-P90 band of year-3 take-home vs its P50).
insert into settings (key, value, description) values ('agents', '{
  "enabled": true,
  "slice_seconds": 75,
  "max_slices": 12,
  "target_band": 0.8,
  "max_proposals": 6,
  "thinking_tokens": 3000,
  "agents": {
    "location-scout": {"max_turns": 36, "tokens": 300000, "searches": 24},
    "pairing-analyst": {"max_turns": 32, "tokens": 450000, "searches": 20},
    "niche-scout": {"max_turns": 40, "tokens": 500000, "searches": 30},
    "backtest-collector": {"max_turns": 28, "tokens": 300000, "searches": 20}
  }
}'::jsonb, 'Tool-using agents: turn limits, budgets per run, time slice per function call, stopping rule for analysis.')
on conflict (key) do nothing;

-- Weekly quality checks and backtest collection.
select cron.schedule('evals-weekly', '7 14 * * 1', $c$select private.invoke('evals', '{}')$c$);
select cron.schedule('backtest-collect-weekly', '19 13 * * 4', $c$select private.invoke('backtest-collector', '{}')$c$);

-- Library clean-up: a type name stored as a slug, an urban hotel spa (not
-- land-based) and a luxury resort far over the owner's capital.
update niches set name = 'Camp and retreat center' where slug = 'camp-and-retreat-center' and name = 'camp-and-retreat-center';
update niches set status = 'rejected', card = card || '{"rejected_reason": "Hotel spa inside a city hotel: not a land- or structure-based business you could start"}'::jsonb
  where slug = 'hotel-spa-wellness-centre' and status = 'proposed';
update niches set name = 'Luxury wellness resort', status = 'rejected', card = card || '{"rejected_reason": "Full-service resort: far beyond $150k of capital"}'::jsonb
  where slug = 'luxury-wellness-resort' and status = 'proposed';
