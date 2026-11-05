-- is_app_user() is only needed by RLS policies for signed-in users.
revoke execute on function public.is_app_user() from anon, public;
grant execute on function public.is_app_user() to authenticated;
