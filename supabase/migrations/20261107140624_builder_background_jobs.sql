-- Let agents start other agents in the background (service role only), and
-- let parallel Builder jobs each write their own part of a design's research.
create or replace function public.queue_agent(p_name text, p_body jsonb default '{}'::jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
begin
  return private.invoke(p_name, p_body);
end $$;
revoke execute on function public.queue_agent(text, jsonb) from public, anon, authenticated;
grant execute on function public.queue_agent(text, jsonb) to service_role;

create or replace function public.design_research_set(p_id uuid, p_key text, p_value jsonb, p_status text default null) returns void
language sql security definer set search_path = public as $$
  update designs
     set research = jsonb_set(coalesce(research, '{}'::jsonb), array[p_key], p_value, true),
         status = coalesce(p_status, status)
   where id = p_id;
$$;
revoke execute on function public.design_research_set(uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.design_research_set(uuid, text, jsonb, text) to service_role;
