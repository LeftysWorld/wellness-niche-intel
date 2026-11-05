-- Sign-in is a single owner account with a password (no email links).
-- The auth user itself is created in the Supabase dashboard with Auto Confirm.
insert into app_users (email, role) values ('owner@wellness-niche-intel.app', 'owner') on conflict do nothing;
delete from app_users where email <> 'owner@wellness-niche-intel.app';
