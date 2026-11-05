-- Wellness Niche Intelligence: core schema.
-- Every number a calculation uses lives in public.assumptions (the ledger),
-- with its source, retrieval date, confidence and author.

create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------
create type niche_status as enum ('proposed', 'approved', 'rejected', 'merged');
create type business_status as enum ('operating', 'closed', 'for_sale', 'planned', 'unknown');
create type location_level as enum ('country', 'micro_area');
create type confidence_level as enum ('high', 'medium', 'low');
create type terms_status as enum ('unknown', 'allowed', 'api_only', 'blocked');
create type pairing_status as enum ('screened_out', 'candidate', 'awaiting_approval', 'approved', 'analyzed', 'verified', 'rejected');
create type run_kind as enum ('discovery_daily', 'discovery_weekly', 'monthly_refresh', 'niche_discovery', 'location_scout', 'fit_screen', 'analysis', 'verify', 'digest');
create type run_status as enum ('queued', 'running', 'succeeded', 'failed', 'budget_exceeded', 'skipped');
create type review_item as enum ('niche', 'shortlist', 'low_confidence', 'export', 'merge');
create type review_status as enum ('pending', 'approved', 'rejected', 'more_research');
create type seen_classification as enum ('new_niche', 'new_example', 'change', 'seen', 'irrelevant');

-- ---------------------------------------------------------------------------
-- Access: who may use the dashboard
-- ---------------------------------------------------------------------------
create table app_users (
  email text primary key,
  role text not null default 'owner',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Configuration
-- ---------------------------------------------------------------------------
create table settings (
  key text primary key,
  value jsonb not null,
  description text,
  updated_at timestamptz not null default now()
);

create table parameter_profiles (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  params jsonb not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Sources the discovery loop reads, with terms-of-use status and health
-- ---------------------------------------------------------------------------
create table sources (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  url text,
  purpose text not null,
  access_method text not null default 'search',
  terms terms_status not null default 'unknown',
  active boolean not null default true,
  last_success_at timestamptz,
  last_error text,
  consecutive_empty_runs int not null default 0,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Niche library
-- ---------------------------------------------------------------------------
create table niches (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  family text,
  aliases text[] not null default '{}',
  card jsonb not null default '{}'::jsonb,
  status niche_status not null default 'proposed',
  merged_into uuid references niches(id),
  risk_tags text[] not null default '{}',
  signal_score numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index niches_name_trgm on niches using gin (name extensions.gin_trgm_ops);

create table example_businesses (
  id uuid primary key default gen_random_uuid(),
  niche_id uuid references niches(id) on delete set null,
  name text not null,
  country text,
  region text,
  locality text,
  url text,
  description text,
  prices jsonb not null default '{}'::jsonb,
  attributes jsonb not null default '{}'::jsonb,
  opened_on date,
  status business_status not null default 'operating',
  fingerprint text not null,
  source_id uuid references sources(id),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index example_fingerprint_trgm on example_businesses using gin (fingerprint extensions.gin_trgm_ops);
create index example_niche on example_businesses (niche_id);

-- ---------------------------------------------------------------------------
-- Locations (country and micro-area)
-- ---------------------------------------------------------------------------
create table locations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  country_code text not null,
  level location_level not null,
  parent_id uuid references locations(id),
  profile jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- The assumption ledger. Rows are never updated in place: a new value
-- supersedes the old one, so any past run can be reproduced.
-- ---------------------------------------------------------------------------
create table assumptions (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('global', 'niche', 'location', 'pairing')),
  subject_id uuid,
  key text not null,
  value_num numeric,
  value_text text,
  low numeric,
  high numeric,
  unit text,
  currency text,
  source_url text,
  source_note text,
  retrieved_at timestamptz not null default now(),
  confidence confidence_level not null default 'medium',
  written_by text not null,
  run_id uuid,
  stale_after interval,
  superseded_by uuid references assumptions(id),
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  check (value_num is not null or value_text is not null)
);
create index assumptions_current on assumptions (subject_type, subject_id, key) where superseded_by is null;

create table change_events (
  id uuid primary key default gen_random_uuid(),
  assumption_id uuid not null references assumptions(id),
  previous_id uuid references assumptions(id),
  subject_type text not null,
  subject_id uuid,
  key text not null,
  pct_change numeric,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Cost templates: a bill of quantities per niche
-- ---------------------------------------------------------------------------
create table cost_templates (
  id uuid primary key default gen_random_uuid(),
  niche_id uuid not null references niches(id) on delete cascade,
  version int not null default 1,
  template jsonb not null,
  notes text,
  created_at timestamptz not null default now(),
  unique (niche_id, version)
);

-- ---------------------------------------------------------------------------
-- Pairings, runs, results
-- ---------------------------------------------------------------------------
create table runs (
  id uuid primary key default gen_random_uuid(),
  kind run_kind not null,
  status run_status not null default 'queued',
  profile_id uuid references parameter_profiles(id),
  subject_id uuid,
  token_budget int,
  tokens_used int not null default 0,
  search_calls int not null default 0,
  input jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  assumption_ids uuid[] not null default '{}',
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index runs_kind_started on runs (kind, started_at desc);

create table pairings (
  id uuid primary key default gen_random_uuid(),
  niche_id uuid not null references niches(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  profile_id uuid not null references parameter_profiles(id) on delete cascade,
  status pairing_status not null default 'candidate',
  hard_filter_reasons text[] not null default '{}',
  scores jsonb not null default '{}'::jsonb,
  score_total numeric,
  rough_profit_year3 numeric,
  latest_result_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (niche_id, location_id, profile_id)
);

create table analysis_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references runs(id),
  pairing_id uuid not null references pairings(id) on delete cascade,
  model jsonb not null,
  result jsonb not null,
  assumption_ids uuid[] not null default '{}',
  confidence confidence_level,
  verifier_status text not null default 'pending' check (verifier_status in ('pending', 'passed', 'flagged', 'failed')),
  verifier_report jsonb,
  created_at timestamptz not null default now()
);
alter table pairings add constraint pairings_latest_result_fk foreign key (latest_result_id) references analysis_results(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Discovery memory, review queue, outcomes, digests, spend
-- ---------------------------------------------------------------------------
create table seen_items (
  id uuid primary key default gen_random_uuid(),
  url text not null unique,
  fingerprint text,
  classification seen_classification,
  example_id uuid references example_businesses(id) on delete set null,
  niche_id uuid references niches(id) on delete set null,
  raw jsonb,
  run_id uuid references runs(id),
  seen_at timestamptz not null default now()
);

create table review_queue (
  id uuid primary key default gen_random_uuid(),
  item_type review_item not null,
  item_id uuid,
  status review_status not null default 'pending',
  summary text not null,
  payload jsonb not null default '{}'::jsonb,
  decided_at timestamptz,
  decided_by text,
  note text,
  created_at timestamptz not null default now()
);
create index review_pending on review_queue (status, created_at desc);

create table outcomes (
  id uuid primary key default gen_random_uuid(),
  example_id uuid references example_businesses(id) on delete cascade,
  observed_on date not null,
  metric text not null,
  value numeric not null,
  source_url text,
  created_at timestamptz not null default now()
);

create table digests (
  id uuid primary key default gen_random_uuid(),
  period_start timestamptz not null,
  period_end timestamptz not null,
  content jsonb not null,
  created_at timestamptz not null default now()
);

create table spend_log (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references runs(id) on delete cascade,
  provider text not null,
  model text,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  calls int not null default 1,
  created_at timestamptz not null default now()
);

create or replace function touch_updated_at() returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger niches_touch before update on niches for each row execute function touch_updated_at();
create trigger locations_touch before update on locations for each row execute function touch_updated_at();
create trigger pairings_touch before update on pairings for each row execute function touch_updated_at();
create trigger profiles_touch before update on parameter_profiles for each row execute function touch_updated_at();
