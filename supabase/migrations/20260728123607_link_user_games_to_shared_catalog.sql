-- Link user-owned rows to the canonical shared Steam catalogue.
insert into public.catalog_games (
  steam_appid,
  name,
  normalized_name,
  genres,
  first_seen_reason,
  first_seen_at,
  last_seen_at,
  metadata_fetched_at
)
select distinct on (g.catalog_steam_appid)
  g.catalog_steam_appid,
  g.title,
  lower(regexp_replace(trim(g.title), '[^a-z0-9]+', ' ', 'gi')),
  case when g.genre in ('', 'Unknown') then '{}'::text[] else array[g.genre] end,
  'user_import',
  coalesce(g.created_at, now()),
  now(),
  now()
from public.games g
where g.catalog_steam_appid is not null
order by g.catalog_steam_appid, g.updated_at desc
on conflict (steam_appid) do nothing;

alter table public.games
  add constraint games_catalog_steam_appid_fkey
  foreign key (catalog_steam_appid)
  references public.catalog_games(steam_appid)
  on delete restrict
  not valid;

alter table public.games
  validate constraint games_catalog_steam_appid_fkey;

create trigger games_catalog_identity
before insert or update of steam_appid on public.games
for each row execute function public.set_game_catalog_identity();
