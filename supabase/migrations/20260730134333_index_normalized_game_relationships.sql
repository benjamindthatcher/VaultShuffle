-- Cover the foreign keys introduced by the shared catalogue and normalized
-- per-user vault state so deletes, updates, and joins remain efficient as the
-- user and draw-history tables grow.
create index if not exists games_catalog_steam_appid_idx
  on public.games (catalog_steam_appid);

create index if not exists user_game_snoozes_game_id_idx
  on public.user_game_snoozes (game_id);

create index if not exists user_vault_state_current_game_id_idx
  on public.user_vault_state (current_game_id)
  where current_game_id is not null;

create index if not exists vault_draws_steam_appid_idx
  on public.vault_draws (steam_appid);

