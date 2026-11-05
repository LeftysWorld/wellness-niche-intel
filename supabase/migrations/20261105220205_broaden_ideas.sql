-- Screen undismissed AI-suggested places too, so ideas cover more places.
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
    where l.level = 'micro_area'
      and (l.active or (l.origin = 'ai_suggested' and coalesce((l.fit->>'dismissed')::boolean, false) = false))
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

-- Keep both pools growing and balanced:
-- write up 3 new niches twice a week (was once), brainstorm weekly (was monthly),
-- and suggest 3 places a week in whichever country has the fewest.
select cron.unschedule('niche-drafts-weekly');
select cron.schedule('niche-drafts-twice-weekly', '37 12 * * 0,3', $c$select private.invoke('niche-discovery', '{"mode":"draft","limit":3}')$c$);
select cron.unschedule('niche-brainstorm-monthly');
select cron.schedule('niche-brainstorm-weekly', '47 12 * * 2', $c$select private.invoke('niche-discovery', '{"mode":"brainstorm"}')$c$);
select cron.schedule('location-ideas-weekly', '27 11 * * 4', $c$select private.invoke('location-ideas', '{"balance":true,"count":3}')$c$);
