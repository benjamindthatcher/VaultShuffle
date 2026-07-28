-- Applied to production as migration 20260726042956.
with blocked_labels(label) as (
  values
    ('animation & modeling'),
    ('audio production'),
    ('design & illustration'),
    ('education'),
    ('game development'),
    ('photo editing'),
    ('software'),
    ('software training'),
    ('utilities'),
    ('utility'),
    ('video production'),
    ('web publishing')
),
catalog_matches as (
  select
    cg.steam_appid,
    cg.name,
    cg.steam_type,
    cg.genres,
    cg.categories,
    matched.label
  from public.catalog_games cg
  cross join lateral (
    select lower(trim(label_value)) as label
    from unnest(
      coalesce(cg.genres, '{}'::text[]) ||
      coalesce(cg.categories, '{}'::text[])
    ) as label_value
    where lower(trim(label_value)) in (select label from blocked_labels)
    order by label
    limit 1
  ) matched
),
game_matches as (
  select distinct on (g.steam_appid::bigint)
    g.steam_appid::bigint as steam_appid,
    g.title as name,
    'game'::text as steam_type,
    array[g.genre]::text[] as genres,
    '{}'::text[] as categories,
    matched.label
  from public.games g
  cross join lateral (
    select lower(trim(label_value)) as label
    from regexp_split_to_table(coalesce(g.genre, ''), '[/,|]') as label_value
    where lower(trim(label_value)) in (select label from blocked_labels)
    order by label
    limit 1
  ) matched
  where g.steam_appid ~ '^[0-9]+$'
  order by g.steam_appid::bigint, g.updated_at desc
),
matches as (
  select * from catalog_matches
  union
  select * from game_matches
)
insert into public.catalog_game_quarantine (
  steam_appid,
  name,
  steam_type,
  matched_rule,
  reason,
  genres,
  categories,
  review_status,
  source,
  last_detected_at,
  updated_at
)
select distinct on (steam_appid)
  steam_appid,
  name,
  steam_type,
  'steam_label:' || label,
  'Steam classified this AppID as ' || label || ', not a game.',
  genres,
  categories,
  'excluded',
  'automatic',
  now(),
  now()
from matches
order by steam_appid, cardinality(genres) + cardinality(categories) desc
on conflict (steam_appid) do update
set name = coalesce(excluded.name, public.catalog_game_quarantine.name),
    steam_type = coalesce(excluded.steam_type, public.catalog_game_quarantine.steam_type),
    matched_rule = excluded.matched_rule,
    reason = excluded.reason,
    genres = excluded.genres,
    categories = excluded.categories,
    review_status = case
      when public.catalog_game_quarantine.source = 'manual'
       and public.catalog_game_quarantine.review_status = 'allowed'
        then 'allowed'
      else 'excluded'
    end,
    source = case
      when public.catalog_game_quarantine.source = 'manual'
        then 'manual'
      else 'automatic'
    end,
    last_detected_at = now(),
    updated_at = now();
