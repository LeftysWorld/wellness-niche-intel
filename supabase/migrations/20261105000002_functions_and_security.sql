-- Ledger behaviour, discovery helpers, and row-level security.

-- Current ledger: the latest, non-superseded value per subject and key.
create view current_assumptions with (security_invoker = true) as
select a.*,
       (a.stale_after is not null and a.retrieved_at + a.stale_after < now()) as is_stale
from assumptions a
where a.superseded_by is null;

-- When a new value is written, supersede the previous one and record a change
-- event if the numeric value moved by more than the configured threshold.
create or replace function supersede_previous_assumption() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  prev assumptions%rowtype;
  pct numeric;
  threshold numeric;
begin
  select * into prev from assumptions
  where subject_type = new.subject_type
    and subject_id is not distinct from new.subject_id
    and key = new.key
    and superseded_by is null
    and id <> new.id
  order by created_at desc
  limit 1;

  if found then
    update assumptions set superseded_by = new.id, superseded_at = now() where id = prev.id;
    if prev.value_num is not null and new.value_num is not null and prev.value_num <> 0 then
      pct := abs(new.value_num - prev.value_num) / abs(prev.value_num);
      select coalesce((value->>'material_change_pct')::numeric, 0.05) into threshold
        from settings where key = 'thresholds';
      if pct >= coalesce(threshold, 0.05) then
        insert into change_events (assumption_id, previous_id, subject_type, subject_id, key, pct_change)
        values (new.id, prev.id, new.subject_type, new.subject_id, new.key, pct);
      end if;
    elsif prev.value_text is distinct from new.value_text then
      insert into change_events (assumption_id, previous_id, subject_type, subject_id, key, pct_change)
      values (new.id, prev.id, new.subject_type, new.subject_id, new.key, null);
    end if;
  end if;
  return new;
end $$;

create trigger assumptions_supersede after insert on assumptions
for each row execute function supersede_previous_assumption();

-- Normalised text used for de-duplication.
create or replace function business_fingerprint(name text, locality text, country text) returns text
language sql immutable set search_path = public as $$
  select regexp_replace(lower(coalesce(name, '') || ' ' || coalesce(locality, '') || ' ' || coalesce(country, '')), '[^a-z0-9áéíóúñü ]', '', 'g')
$$;

-- Candidate duplicates for a new business record, by trigram similarity.
create or replace function match_examples(q text, min_similarity real default 0.45, max_rows int default 5)
returns table (id uuid, name text, niche_id uuid, similarity real)
language sql stable set search_path = public, extensions as $$
  select e.id, e.name, e.niche_id, similarity(e.fingerprint, q) as similarity
  from example_businesses e
  where similarity(e.fingerprint, q) >= min_similarity
  order by similarity desc
  limit max_rows
$$;

-- Candidate niches for a concept description, by name and alias similarity.
create or replace function match_niches(q text, min_similarity real default 0.3, max_rows int default 8)
returns table (id uuid, slug text, name text, status niche_status, similarity real)
language sql stable set search_path = public, extensions as $$
  select n.id, n.slug, n.name, n.status,
         greatest(similarity(n.name, q), coalesce((select max(similarity(a, q)) from unnest(n.aliases) a), 0)) as similarity
  from niches n
  where n.status <> 'rejected'
  order by similarity desc
  limit max_rows
$$;

-- Signal strength: independent examples, regional spread, recent openings, closures.
create or replace function refresh_niche_signals() returns void
language sql security definer set search_path = public as $$
  update niches n set signal_score = coalesce(s.score, 0)
  from (
    select niche_id,
           count(*) filter (where status in ('operating', 'for_sale', 'planned')) * 1.0
         + count(distinct coalesce(region, country)) * 2.0
         + count(*) filter (where opened_on >= current_date - interval '18 months') * 1.5
         - count(*) filter (where status = 'closed') * 2.0 as score
    from example_businesses
    where niche_id is not null
    group by niche_id
  ) s
  where s.niche_id = n.id
$$;

-- ---------------------------------------------------------------------------
-- Row-level security: the dashboard is for listed users only. Edge functions
-- use the service role, which bypasses RLS.
-- ---------------------------------------------------------------------------
create or replace function is_app_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_users where email = lower(auth.jwt() ->> 'email'))
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'app_users', 'settings', 'parameter_profiles', 'sources', 'niches', 'example_businesses',
    'locations', 'assumptions', 'change_events', 'cost_templates', 'runs', 'pairings',
    'analysis_results', 'seen_items', 'review_queue', 'outcomes', 'digests', 'spend_log'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for select to authenticated using (is_app_user())', t || '_read', t);
  end loop;
end $$;

-- Writes the dashboard performs on behalf of the owner.
create policy review_queue_decide on review_queue for update to authenticated using (is_app_user()) with check (is_app_user());
create policy profiles_write on parameter_profiles for all to authenticated using (is_app_user()) with check (is_app_user());
create policy niches_decide on niches for update to authenticated using (is_app_user()) with check (is_app_user());
create policy pairings_decide on pairings for update to authenticated using (is_app_user()) with check (is_app_user());
create policy settings_write on settings for update to authenticated using (is_app_user()) with check (is_app_user());
create policy sources_write on sources for update to authenticated using (is_app_user()) with check (is_app_user());
-- Owner overrides enter the ledger as new rows written by 'user'.
create policy assumptions_override on assumptions for insert to authenticated
  with check (is_app_user() and written_by = 'user');

revoke execute on function refresh_niche_signals() from public, anon, authenticated;
revoke execute on function supersede_previous_assumption() from public, anon, authenticated;
