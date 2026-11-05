-- Route scheduled calls through the single api function (api/<agent>).
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
