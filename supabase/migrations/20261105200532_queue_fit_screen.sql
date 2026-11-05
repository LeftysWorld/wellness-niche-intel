-- A full re-rank is split into one fit-screen job per place so each call stays
-- inside the edge function's compute limit; the jobs run in parallel.
create or replace function public.queue_fit_screen(p_niche uuid default null) returns int
language plpgsql security definer set search_path = public as $$
declare
  l record;
  n int := 0;
begin
  for l in select id from locations where active and level = 'micro_area' loop
    perform private.invoke('fit-screen', jsonb_strip_nulls(jsonb_build_object('location_id', l.id, 'niche_id', p_niche)));
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.queue_fit_screen(uuid) from public, anon, authenticated;
grant execute on function public.queue_fit_screen(uuid) to service_role;
