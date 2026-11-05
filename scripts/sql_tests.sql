-- Database tests. Run against a project after migrations (Supabase SQL editor,
-- or the MCP execute_sql tool). Any failure raises an exception; success
-- returns 'all database tests passed'. Test writes are rolled back.
do $$
declare
  n int;
  pct numeric;
begin
  -- match_niches must respect its similarity threshold (it once returned the closest niche regardless).
  select count(*) into n from match_niches('zzqx unrelated words qqq', 0.45, 5);
  if n <> 0 then raise exception 'match_niches ignored its threshold (% rows)', n; end if;
  select count(*) into n from match_niches('Dark retreat centre', 0.45, 5) where slug = 'dark-retreat';
  if n <> 1 then raise exception 'match_niches missed an obvious match'; end if;

  -- spend_totals returns one row of non-negative numbers.
  select count(*) into n from spend_totals() where tokens_today >= 0 and searches_month >= 0;
  if n <> 1 then raise exception 'spend_totals did not return one row'; end if;

  -- Every public table has row-level security on.
  select count(*) into n from pg_tables t where t.schemaname = 'public' and not t.rowsecurity;
  if n <> 0 then raise exception '% public tables without row-level security', n; end if;

  -- Sign-ups are blocked for addresses not on the allow-list.
  select count(*) into n from pg_trigger where tgname = 'block_unlisted_signups' and not tgisinternal;
  if n <> 1 then raise exception 'sign-up block trigger missing'; end if;

  -- Internal functions are not callable by anonymous visitors.
  if has_function_privilege('anon', 'public.check_cron_secret(text)', 'execute') then raise exception 'anon can call check_cron_secret'; end if;
  if has_function_privilege('anon', 'public.is_app_user()', 'execute') then raise exception 'anon can call is_app_user'; end if;
  if has_function_privilege('anon', 'public.spend_totals()', 'execute') then raise exception 'anon can call spend_totals'; end if;

  -- A new ledger value supersedes the old one and records a material change (rolled back).
  begin
    insert into assumptions (subject_type, subject_id, key, value_num, confidence, written_by)
    select 'location', id, 'test.key', 100, 'low', 'test' from locations where slug = 'us';
    insert into assumptions (subject_type, subject_id, key, value_num, confidence, written_by)
    select 'location', id, 'test.key', 150, 'low', 'test' from locations where slug = 'us';
    select count(*) into n from current_assumptions where key = 'test.key';
    if n <> 1 then raise exception 'supersede failed: % current rows', n; end if;
    select pct_change into pct from change_events where key = 'test.key';
    if pct is null or abs(pct - 0.5) > 0.001 then raise exception 'change event wrong: %', pct; end if;
    raise exception 'rollback';
  exception when others then
    if sqlerrm <> 'rollback' then raise; end if;
  end;
end $$;
select 'all database tests passed' as result;
