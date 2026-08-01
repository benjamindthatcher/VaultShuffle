-- Resolve duration-less games only when their stored Steam metadata provides a
-- decisive replayability signal. Real finite estimates and prior classifications
-- are deliberately left untouched.
with replayable as (
  select steam_appid
  from public.catalog_games
  where duration_kind = 'unknown'
    and coalesce(main_story_minutes, 0) <= 0
    and coalesce(main_extras_minutes, 0) <= 0
    and coalesce(completionist_minutes, 0) <= 0
    and (
      exists (
        select 1
        from jsonb_object_keys(coalesce(tags, '{}'::jsonb)) as tag(value)
        where lower(tag.value) in (
          'auto battler', 'battle royale', 'clicker', 'idler',
          'massively multiplayer', 'mmo', 'mmorpg', 'moba'
        )
      )
      or exists (
        select 1
        from unnest(coalesce(genres, '{}'::text[]) || coalesce(categories, '{}'::text[])) as signal(value)
        where lower(signal.value) in ('massively multiplayer', 'mmo', 'mmorpg')
      )
      or (
        exists (
          select 1
          from (
            select value from jsonb_object_keys(coalesce(tags, '{}'::jsonb)) as tag(value)
            union all
            select value from unnest(coalesce(genres, '{}'::text[]) || coalesce(categories, '{}'::text[])) as signal(value)
          ) signals
          where lower(signals.value) in (
            'live service', 'massively multiplayer', 'mmo', 'mmorpg', 'persistent online'
          )
        )
        and exists (
          select 1
          from (
            select value from jsonb_object_keys(coalesce(tags, '{}'::jsonb)) as tag(value)
            union all
            select value from unnest(coalesce(genres, '{}'::text[]) || coalesce(categories, '{}'::text[])) as signal(value)
          ) signals
          where lower(signals.value) in (
            'competitive', 'esports', 'open world survival craft', 'online co-op',
            'online pvp', 'pvp', 'sandbox', 'survival'
          )
        )
      )
    )
)
update public.catalog_games game
set duration_kind = 'endless',
    duration_status = 'ready',
    duration_source = 'steam-tags',
    duration_source_game_id = null,
    duration_source_updated_at = now(),
    duration_confidence = 'medium',
    updated_at = now()
from replayable
where game.steam_appid = replayable.steam_appid;
