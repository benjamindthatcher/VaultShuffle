-- Shared duration and quarantine metadata belongs to the catalogue. Avoid
-- rewriting every user's ownership row whenever one catalogue row changes.
drop trigger if exists catalog_duration_propagation on public.catalog_games;
drop trigger if exists games_duration_progress on public.games;
drop function if exists public.propagate_catalog_duration();
drop function if exists public.sync_catalog_duration_to_user_games(bigint);
drop function if exists public.calculate_game_duration_progress();

alter table public.vault_draws
  drop constraint if exists vault_draws_steam_appid_fkey;
alter table public.vault_draws
  add constraint vault_draws_steam_appid_fkey
  foreign key (steam_appid)
  references public.catalog_games(steam_appid)
  on delete restrict
  not valid;
alter table public.vault_draws
  validate constraint vault_draws_steam_appid_fkey;

comment on column public.games.catalog_steam_appid is
  'Canonical shared catalogue identity. User-owned state remains on games; shared metadata belongs on catalog_games.';
comment on column public.games.title is
  'Compatibility snapshot only. New shared metadata reads should use catalog_games through catalog_steam_appid.';
comment on column public.games.genre is
  'Compatibility snapshot only. Canonical genres are stored once on catalog_games.';
comment on column public.games.rating is
  'Compatibility snapshot only. Canonical review data is stored once on catalog_games.';
