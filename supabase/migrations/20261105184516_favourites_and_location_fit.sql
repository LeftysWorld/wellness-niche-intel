-- Owner-driven discovery: favourite places and niches, places the owner adds,
-- places the AI suggests, and an AI judgement of how well each place matches
-- the owner's own description of what they want (stored in the profile as
-- params.location_wishes).

alter table locations
  add column if not exists favorite boolean not null default false,
  add column if not exists notes text,
  add column if not exists origin text not null default 'seed' check (origin in ('seed', 'user', 'ai_suggested')),
  add column if not exists fit jsonb not null default '{}'::jsonb;

alter table niches add column if not exists favorite boolean not null default false;

alter type run_kind add value if not exists 'location_fit';
alter type run_kind add value if not exists 'location_ideas';

-- The owner can add places and mark favourites from the web app.
create policy locations_insert on locations for insert to authenticated with check (is_app_user());
create policy locations_update on locations for update to authenticated using (is_app_user()) with check (is_app_user());
