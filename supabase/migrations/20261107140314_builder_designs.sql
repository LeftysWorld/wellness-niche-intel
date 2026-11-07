-- Niche designs composed in the Builder tab. Research turns a design into a
-- niche (family 'builder') that is screened in every place like any other.
create table if not exists designs (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Untitled design',
  base_niche_id uuid references niches(id) on delete set null,
  blocks jsonb not null default '[]'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'researching', 'ready', 'failed')),
  niche_id uuid references niches(id) on delete set null,
  research jsonb not null default '{}'::jsonb,
  last_run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table designs enable row level security;
create policy designs_read on designs for select to authenticated using (is_app_user());
create policy designs_insert on designs for insert to authenticated with check (is_app_user());
create policy designs_update on designs for update to authenticated using (is_app_user()) with check (is_app_user());
create policy designs_delete on designs for delete to authenticated using (is_app_user());
create or replace function touch_design() returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end $$;
create trigger designs_touch before update on designs for each row execute function touch_design();
