grant usage on schema public to service_role;

grant select, insert, update, delete on table public.app_users to service_role;
grant select, insert, update, delete on table public.sessions to service_role;
grant select, insert, update, delete on table public.games to service_role;
grant select, insert, update, delete on table public.recommendations to service_role;
grant select, insert, update, delete on table public.app_settings to service_role;

grant execute on function public.set_updated_at() to service_role;
