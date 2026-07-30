-- The normalized vault-state tables are accessed only through server-side API
-- routes. RLS remains enabled, while the service role receives the DML grants
-- PostgREST requires in addition to its RLS bypass.

revoke all on table public.user_game_snoozes from anon, authenticated;
revoke all on table public.user_vault_state from anon, authenticated;

grant select, insert, update, delete
  on table public.user_game_snoozes
  to service_role;

grant select, insert, update, delete
  on table public.user_vault_state
  to service_role;
-- Version aligned with the production Supabase migration history.
