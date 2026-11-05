-- One fit-screen job per niche x place, so each call stays well inside the
-- edge function's compute limit. Either argument narrows the set.
drop function if exists public.queue_fit_screen(uuid);
create or replace function public.queue_fit_screen(p_niche uuid default null, p_location uuid default null) returns int
language plpgsql security definer set search_path = public as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select l.id as location_id, ni.id as niche_id
    from locations l
    cross join niches ni
    where l.active and l.level = 'micro_area'
      and ni.status in ('approved', 'proposed')
      and ni.card ? 'model'
      and coalesce(jsonb_array_length(ni.card->'smoke_test'), 0) = 0
      and (p_niche is null or ni.id = p_niche)
      and (p_location is null or l.id = p_location)
  loop
    perform private.invoke('fit-screen', jsonb_build_object('location_id', r.location_id, 'niche_id', r.niche_id));
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.queue_fit_screen(uuid, uuid) from public, anon, authenticated;
grant execute on function public.queue_fit_screen(uuid, uuid) to service_role;
