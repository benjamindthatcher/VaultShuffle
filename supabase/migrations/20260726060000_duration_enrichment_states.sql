alter table public.catalog_games
  add column if not exists duration_kind text not null default 'unknown';

alter table public.catalog_games
  drop constraint if exists catalog_games_duration_kind_check;
alter table public.catalog_games
  add constraint catalog_games_duration_kind_check
  check (duration_kind in ('finite', 'endless', 'not-applicable', 'unknown'));

create table if not exists public.game_duration_aliases (
  steam_app_id bigint primary key references public.catalog_games(steam_appid) on delete cascade,
  search_title text not null,
  release_year integer,
  review_status text not null default 'approved'
    check (review_status in ('approved', 'needs_review', 'rejected')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.game_duration_aliases enable row level security;
revoke all on public.game_duration_aliases from public, anon, authenticated;
grant select, insert, update, delete on public.game_duration_aliases to service_role;

insert into public.game_duration_aliases (steam_app_id, search_title, release_year, review_status, notes)
values
  (10180, 'Call of Duty: Modern Warfare 2', 2009, 'approved', 'Steam edition title alias.'),
  (10190, 'Call of Duty: Modern Warfare 2', 2009, 'approved', 'Steam edition title alias.'),
  (1938090, 'Call of Duty: Modern Warfare II (2022)', 2022, 'approved', 'Disambiguates the 2022 release.'),
  (34460, 'Sid Meier''s Civilization IV: Beyond the Sword', 2007, 'approved', 'IGDB canonical title.'),
  (34440, 'Civilization IV', 2005, 'approved', 'IGDB canonical title.'),
  (47790, 'Medal of Honor (2010)', 2010, 'approved', 'Disambiguates the 2010 release.'),
  (47830, 'Medal of Honor (2010)', 2010, 'approved', 'Disambiguates the 2010 release.'),
  (56437, 'Warhammer 40,000: Dawn of War II - Retribution', 2011, 'approved', 'IGDB punctuation alias.'),
  (4584110, 'Soul Land: Awakening World', 2026, 'needs_review', 'New release; no confirmed duration match yet.')
on conflict (steam_app_id) do update
set search_title = excluded.search_title,
    release_year = excluded.release_year,
    review_status = excluded.review_status,
    notes = excluded.notes,
    updated_at = now();

with not_applicable_names(name) as (
  values
    ('aseprite'),
    ('black myth: wukong benchmark tool'),
    ('blender'),
    ('chocolate factory simulator: prologue'),
    ('crosshair x'),
    ('evga precision x1'),
    ('hunt: showdown 1896 test server'),
    ('lossless scaling'),
    ('soundpad'),
    ('source filmmaker'),
    ('the jackbox megapicker'),
    ('wallpaper engine'),
    ('z1 battle royale test server')
),
not_applicable as (
  select c.steam_appid, c.name, c.steam_type, c.genres, c.categories
  from public.catalog_games c
  where lower(c.name) in (select name from not_applicable_names)
     or lower(c.name) ~ '(benchmark tool|test server|\\bplaytest\\b|\\bprologue$)'
  union
  select
    g.steam_appid::bigint, g.title, 'game', regexp_split_to_array(g.genre, '\\s*/\\s*'), '{}'::text[]
  from public.games g
  where g.steam_appid ~ '^[0-9]+$'
    and (
      lower(g.title) in (select name from not_applicable_names)
      or lower(g.title) ~ '(benchmark tool|test server|\\bplaytest\\b|\\bprologue$)'
    )
)
insert into public.catalog_game_quarantine (
  steam_appid, name, steam_type, matched_rule, reason, genres, categories,
  review_status, source, last_detected_at, updated_at
)
select distinct on (steam_appid)
  steam_appid, name, steam_type, 'duration_kind:not-applicable',
  'Tool, utility, benchmark, test build, demo or prologue; a game duration is not applicable.',
  genres, categories, 'excluded', 'automatic', now(), now()
from not_applicable
order by steam_appid, cardinality(genres) + cardinality(categories) desc
on conflict (steam_appid) do update
set name = coalesce(excluded.name, public.catalog_game_quarantine.name),
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
    last_detected_at = now(),
    updated_at = now();

update public.catalog_games c
set duration_kind = case
  when exists (
    select 1 from public.catalog_game_quarantine q
    where q.steam_appid = c.steam_appid
      and q.review_status = 'excluded'
      and q.matched_rule = 'duration_kind:not-applicable'
  ) then 'not-applicable'
  when c.main_story_minutes is not null
    or c.main_extras_minutes is not null
    or c.completionist_minutes is not null then 'finite'
  when lower(c.name) ~ '(battlefield|hunt: showdown|war thunder|dota underlords|tabletop simulator|planet zoo|cities: skylines|crusaders of the lost idols|counter-?strike|destiny|apex legends|rust|palworld|new world|for honor|warframe|dota|team fortress|pubg|rainbow six|rocket league|dead by daylight|elder scrolls online|final fantasy xiv|path of exile|lost ark|factorio|rimworld|terraria|monster hunter)'
    or exists (
      select 1
      from public.games g
      where g.steam_appid = c.steam_appid::text
        and lower(g.genre) ~ '(massively multiplayer|\\bmmo\\b|battle royale|\\bmoba\\b|live service|sandbox|idle|incremental|free to play|\\bpvp\\b|\\bpve\\b)'
    ) then 'endless'
  else 'unknown'
end,
updated_at = now();

create or replace function public.queue_missing_game_durations(p_limit integer default 250)
returns integer
language plpgsql
security definer
set search_path = 'public'
as $$
declare queued_count integer;
begin
  with candidates as (
    select c.steam_appid
    from public.catalog_games c
    where c.steam_type = 'game'
      and c.duration_kind = 'unknown'
      and not exists (
        select 1 from public.game_duration_estimates e
        where e.steam_app_id = c.steam_appid
          and e.match_status = 'matched'
          and (e.next_refresh_at is null or e.next_refresh_at > now())
      )
    order by c.users_that_imported desc, c.import_sighting_count desc, c.created_at
    limit greatest(1, least(coalesce(p_limit, 250), 1000))
  ), inserted as (
    insert into public.game_duration_jobs (steam_app_id, status, priority, next_attempt_at)
    select steam_appid, 'pending', 60, now() from candidates
    on conflict (steam_app_id) do update
      set status = case
            when public.game_duration_jobs.status in ('failed','needs_review','completed')
              then 'retry'
            else public.game_duration_jobs.status
          end,
          next_attempt_at = case
            when public.game_duration_jobs.status in ('failed','needs_review','completed')
              then now()
            else public.game_duration_jobs.next_attempt_at
          end,
          updated_at = now()
    returning 1
  )
  select count(*) into queued_count from inserted;
  return queued_count;
end;
$$;

revoke all on function public.queue_missing_game_durations(integer) from public, anon, authenticated;
grant execute on function public.queue_missing_game_durations(integer) to service_role;

create or replace function public.sync_duration_estimate()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  update public.catalog_games
  set main_story_minutes = case when new.match_status = 'matched' then new.main_story_minutes else main_story_minutes end,
      main_extras_minutes = case when new.match_status = 'matched' then new.main_extra_minutes else main_extras_minutes end,
      completionist_minutes = case when new.match_status = 'matched' then new.completionist_minutes else completionist_minutes end,
      duration_source = new.provider,
      duration_source_game_id = new.provider_game_id::text,
      duration_source_updated_at = coalesce(new.provider_updated_at, new.checked_at),
      duration_confidence = case when new.match_confidence in ('low','medium','high') then new.match_confidence else null end,
      duration_status = case when new.match_status = 'matched' then 'ready' when new.match_status in ('no_duration','not_found') then 'no_match' else 'failed' end,
      duration_kind = case when new.match_status = 'matched' then 'finite' else duration_kind end,
      updated_at = now()
  where steam_appid = new.steam_app_id;

  if new.match_status = 'matched' then
    update public.games
    set main_story_minutes = new.main_story_minutes,
        main_extras_minutes = new.main_extra_minutes,
        completionist_minutes = new.completionist_minutes,
        duration_source = new.provider,
        duration_source_updated_at = coalesce(new.provider_updated_at, new.checked_at),
        duration_confidence = case when new.match_confidence in ('low','medium','high') then new.match_confidence else null end,
        updated_at = now()
    where steam_appid is not null
      and steam_appid ~ '^[0-9]+$'
      and steam_appid::bigint = new.steam_app_id;
  end if;
  return new;
end;
$$;

revoke all on function public.sync_duration_estimate() from public, anon, authenticated;
