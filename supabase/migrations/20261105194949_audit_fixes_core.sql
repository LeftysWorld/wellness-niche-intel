-- Audit fixes: site checks, spend totals, closed sign-ups, new settings and
-- estimated place values (seasons, income tax, traveller prices).

alter type run_kind add value if not exists 'site_check';

create table if not exists niche_place_checks (
  niche_id uuid not null references niches(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  verdict text not null check (verdict in ('yes', 'no', 'unknown')),
  reason text,
  checked_at timestamptz not null default now(),
  run_id uuid references runs(id),
  primary key (niche_id, location_id)
);
alter table niche_place_checks enable row level security;
create policy niche_place_checks_read on niche_place_checks for select to authenticated using (is_app_user());

-- Usage across every run, for the overall daily and monthly caps.
create or replace function spend_totals()
returns table (tokens_today bigint, tokens_month bigint, searches_today bigint, searches_month bigint)
language sql stable security definer set search_path = public as $$
  select
    coalesce(sum(input_tokens + output_tokens) filter (where provider = 'anthropic' and created_at >= date_trunc('day', now())), 0),
    coalesce(sum(input_tokens + output_tokens) filter (where provider = 'anthropic' and created_at >= date_trunc('month', now())), 0),
    coalesce(sum(calls) filter (where model = 'search' and created_at >= date_trunc('day', now())), 0),
    coalesce(sum(calls) filter (where model = 'search' and created_at >= date_trunc('month', now())), 0)
  from spend_log
$$;
revoke execute on function spend_totals() from public, anon;
grant execute on function spend_totals() to authenticated, service_role;

-- Only addresses on the allow-list can have an account; public sign-ups are refused.
create or replace function public.block_unlisted_signups() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.app_users where email = lower(new.email)) then
    raise exception 'Sign-ups are closed';
  end if;
  return new;
end $$;
revoke execute on function public.block_unlisted_signups() from public, anon, authenticated;
drop trigger if exists block_unlisted_signups on auth.users;
create trigger block_unlisted_signups before insert on auth.users
for each row execute function public.block_unlisted_signups();

-- Settings: overall caps (under Tavily's 1,000 free searches), a mid-tier model for numbers.
update settings set value = value || '{"daily_tokens": 1500000, "monthly_tokens": 15000000, "daily_searches": 60, "monthly_searches": 900}'::jsonb where key = 'budgets';
update settings set value = value || '{"numbers": "claude-sonnet-5-5"}'::jsonb where key = 'models';

-- Profile: compare the target with after-tax take-home; scoring weights are editable.
update parameter_profiles set params = params || jsonb_build_object(
  'target_basis', 'after_tax',
  'operator_model', coalesce(params->>'operator_model', 'solo'),
  'weights', '{"money":0.3,"growth":0.15,"capital":0.15,"workload":0.05,"demand":0.1,"place":0.1,"visa":0.05,"risk":0.05,"evidence":0.05}'::jsonb
) where is_default;

-- Approvals now happen on the idea itself; clear the per-match queue items.
delete from review_queue where item_type = 'shortlist' and status = 'pending';
update pairings set status = 'candidate' where status = 'awaiting_approval';

-- Estimated place values the audit found missing. Written as estimates (no source),
-- so the app shows them as guessed until the scout or the owner replaces them.
insert into assumptions (subject_type, subject_id, key, value_num, value_text, unit, source_note, confidence, written_by, stale_after)
select 'location', l.id, v.key, v.num, v.txt, v.unit, v.note, 'low', 'seed:estimate', interval '365 days'
from locations l
join (values
  ('us', 'tax.income_effective_pct', 0.25, null, 'fraction', 'Self-employment tax (15.3% on 92.35% of profit) plus federal and NC income tax after deductions, on ~$60k'),
  ('co', 'tax.income_effective_pct', 0.10, null, 'fraction', 'Owner social-security contributions; income tax is inside the simple-regime revenue tax'),
  ('cr', 'tax.income_effective_pct', 0.15, null, 'fraction', 'Small-business income tax plus CCSS contributions'),
  ('sv', 'tax.income_effective_pct', 0.10, null, 'fraction', 'Small-business income tax'),
  ('us', 'price.index_destination', 1.0, null, 'index', 'Travellers pay US prices'),
  ('co', 'price.index_destination', 0.85, null, 'index', 'Retreats sold to international guests price closer to US levels than local services'),
  ('cr', 'price.index_destination', 1.0, null, 'index', 'Costa Rica tourism prices near US levels'),
  ('sv', 'price.index_destination', 0.8, null, 'index', 'Surf and lake tourism prices'),
  ('us', 'demand.seasonality', null, '[0.6,0.65,0.85,1.0,1.1,1.2,1.25,1.2,1.1,1.35,1.0,0.7]', 'curve', 'Blue Ridge visitor pattern: summer and October leaf season peak, winter low'),
  ('co', 'demand.seasonality', null, '[1.15,0.9,0.95,1.0,0.9,1.05,1.15,1.05,0.9,0.95,0.95,1.1]', 'curve', 'Antioquia: December-January and mid-year holidays'),
  ('cr', 'demand.seasonality', null, '[1.3,1.3,1.35,1.2,0.85,0.8,1.05,0.95,0.7,0.7,0.85,1.15]', 'curve', 'Costa Rica dry season December-April, rainy September-October'),
  ('sv', 'demand.seasonality', null, '[1.1,1.1,1.15,1.15,0.9,0.85,0.95,1.0,0.8,0.85,1.0,1.1]', 'curve', 'Dry season November-April')
) as v(slug, key, num, txt, unit, note) on v.slug = l.slug;

-- Schedules: exchange rates weekly; site checks before the weekly fit screen.
select cron.schedule('fx-weekly', '47 8 * * 0', $$select private.invoke('orchestrator', '{"task":"fx"}')$$);
select cron.schedule('site-check-weekly', '57 10 * * 1', $$select private.invoke('site-check', '{}')$$);
