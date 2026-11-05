-- Scheduling: pg_cron fires edge functions through pg_net. The function URL
-- base and a random scheduler secret live in Supabase Vault (created once by
-- scripts/setup_vault.sql, never committed). Functions check the secret with
-- check_cron_secret(), which only the service role may call.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function public.check_cron_secret(given text) returns boolean
language sql stable security definer set search_path = public, vault as $$
  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'cron_secret' and decrypted_secret = given
  )
$$;
revoke execute on function public.check_cron_secret(text) from public, anon, authenticated;
grant execute on function public.check_cron_secret(text) to service_role;

-- Fire one agent (through the api router function) with a JSON body.
create or replace function private.invoke(fn text, body jsonb default '{}'::jsonb) returns bigint
language plpgsql security definer set search_path = public, vault, net as $$
declare
  base text;
  secret text;
begin
  select decrypted_secret into base from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'cron_secret';
  if base is null or secret is null then
    raise exception 'Vault secrets project_url and cron_secret must exist (run scripts/setup_vault.sql)';
  end if;
  return net.http_post(
    url := base || '/functions/v1/api/' || fn,
    body := body,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret),
    timeout_milliseconds := 300000
  );
end $$;
revoke execute on function private.invoke(text, jsonb) from public, anon, authenticated;

-- Schedules (UTC). Minutes are spread off the hour on purpose.
select cron.schedule('orchestrator-tick',      '23 * * * *',  $$select private.invoke('orchestrator', '{"task":"tick"}')$$);
select cron.schedule('location-refresh',       '52 7 * * *',  $$select private.invoke('orchestrator', '{"task":"refresh","limit":2}')$$);
select cron.schedule('discovery-daily',        '41 10 * * *', $$select private.invoke('discovery-loop', '{"mode":"daily"}')$$);
select cron.schedule('discovery-weekly-0',     '13 9 * * 0',  $$select private.invoke('discovery-loop', '{"mode":"weekly","page":0,"pages":4}')$$);
select cron.schedule('discovery-weekly-1',     '28 9 * * 0',  $$select private.invoke('discovery-loop', '{"mode":"weekly","page":1,"pages":4}')$$);
select cron.schedule('discovery-weekly-2',     '43 9 * * 0',  $$select private.invoke('discovery-loop', '{"mode":"weekly","page":2,"pages":4}')$$);
select cron.schedule('discovery-weekly-3',     '58 9 * * 0',  $$select private.invoke('discovery-loop', '{"mode":"weekly","page":3,"pages":4}')$$);
select cron.schedule('niche-drafts-weekly',    '37 12 * * 0', $$select private.invoke('niche-discovery', '{"mode":"draft","limit":3}')$$);
select cron.schedule('niche-brainstorm-monthly','47 12 1 * *', $$select private.invoke('niche-discovery', '{"mode":"brainstorm"}')$$);
select cron.schedule('fit-screen-weekly',      '17 11 * * 1', $$select private.invoke('fit-screen', '{}')$$);
select cron.schedule('digest-weekly',          '33 13 * * 1', $$select private.invoke('orchestrator', '{"task":"digest"}')$$);
