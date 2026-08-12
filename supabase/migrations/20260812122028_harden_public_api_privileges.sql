-- Keep internal tables and helper functions out of PostgREST's anonymous and
-- authenticated roles. RLS remains enabled as defence in depth, but it should
-- not be the only barrier protecting server-owned objects.

revoke all on table public.catalog_game_quarantine
from anon, authenticated;

revoke execute on function public.lowest_positive_duration_minutes(integer, integer, integer)
from public, anon, authenticated;
revoke execute on function public.set_updated_at()
from public, anon, authenticated;
revoke execute on function public.trim_vault_draw_history()
from public, anon, authenticated;

grant execute on function public.lowest_positive_duration_minutes(integer, integer, integer)
to service_role;
grant execute on function public.set_updated_at()
to service_role;
grant execute on function public.trim_vault_draw_history()
to service_role;

-- Ordinary project migrations create public-schema objects as postgres. Keep
-- those future objects private until a migration grants exact privileges.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;
