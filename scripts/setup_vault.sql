-- One-time setup, run in the Supabase SQL editor. Creates the two Vault
-- secrets the scheduler needs. The scheduler secret is random and is never
-- shown; nothing here needs to be copied anywhere.
-- Replace <project-ref> with your project ref before running.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'project_url') then
    perform vault.create_secret('https://<project-ref>.supabase.co', 'project_url', 'Base URL for edge function calls');
  end if;
  if not exists (select 1 from vault.secrets where name = 'cron_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'cron_secret', 'Scheduler → edge function shared secret');
  end if;
end $$;
