-- Harden the staging table created by the remote backfill_user_game_state migration.
-- The current app still uses user_games; no application view/function reads this table.
-- Preserve service_role's existing permissions. Do not expose staging data or invent
-- auth.uid() policies: VaultShuffle uses server-validated Steam/manual sessions.
set local lock_timeout = '2s';
set local statement_timeout = '10s';

alter table public.user_game_state enable row level security;
revoke all on table public.user_game_state from public, anon, authenticated;

-- No client policies are intentional: deny by default, including if a future
-- migration accidentally grants table access. A future cutover must explicitly
-- review server grants and its read/write paths before using this staging table.
