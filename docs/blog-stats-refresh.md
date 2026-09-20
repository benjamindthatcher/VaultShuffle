# Refreshing the blog statistics

`data/blog/stats.json` holds every aggregate a post quotes. It is checked in and
refreshed by hand. This is the file `lib/blog/stats.ts` reads and the reason the
posts can say "as of September 2026" honestly.

## Why it is not queried at build time

PostgREST selects, filters and orders; it does not aggregate. Getting these
numbers through the Supabase client would mean either pulling all 383,663 owned
rows into the build, or adding Postgres functions and calling them over `rpc` —
and an `rpc` against a changed function silently no-ops until the schema cache
is reloaded, which is a bad failure mode for a number printed in prose.

Game *lists* are different: they are ordinary filtered selects, so
`lib/blog/game-lists.ts` queries those live at build time. Only the aggregates
live here.

## When to refresh

Whenever a post's numbers would embarrass you. Monthly is plenty. The figures
move slowly — they are ratios over a large base, not counters.

After refreshing, **update `generatedAt`**. Every post dates its claims from
that field, so a stale date is the one thing that turns an honest statistic into
a wrong one.

## Running the queries

Via the Supabase CLI against the linked project:

```bash
supabase db query --linked -f scratch/blog-stats.sql
```

Or paste each one into the SQL editor. Either way, copy the results into
`data/blog/stats.json` and keep the shape — `lib/blog/stats.ts` types it.

### `library`

```sql
select
  (select count(distinct user_id) from user_games)                    as libraries,
  count(*)                                                            as owned_rows,
  count(*) filter (where coalesce(hours_played,0) = 0)                as never_launched,
  round(100.0 * count(*) filter (where coalesce(hours_played,0) = 0)
        / count(*), 1)                                                as pct_never_launched,
  round(100.0 * count(*) filter (where hours_played < 1)
        / count(*), 1)                                                as pct_under_one_hour,
  (select count(*) from user_games
    where access_source = 'owned' and status = 'Completed')           as completions
from user_games
where access_source = 'owned';
```

`access_source = 'owned'` is load-bearing: it drops family-shared rows, and
Steam does not report playtime for a borrowed copy, so including them would
inflate the never-launched share with games that simply cannot be measured.

### `catalogue`

```sql
select
  count(*)                                              as games,
  count(*) filter (where main_story_minutes is not null) as with_durations,
  count(*) filter (where deck_compatibility is not null) as with_deck_rating,
  count(*) filter (where deck_compatibility = 3)         as deck_verified
from catalog_games;
```

### `completionByLength`

```sql
select
  case when c.main_story_minutes < 120  then 'Under 2 hours'
       when c.main_story_minutes < 300  then '2-5 hours'
       when c.main_story_minutes < 600  then '5-10 hours'
       when c.main_story_minutes < 1200 then '10-20 hours'
       when c.main_story_minutes < 2400 then '20-40 hours'
       else '40+ hours' end                                        as band,
  count(*) filter (where ug.hours_played > 0)                       as started,
  count(*) filter (where ug.status = 'Completed')                   as completed,
  round(100.0 * count(*) filter (where ug.status = 'Completed')
        / nullif(count(*) filter (where ug.hours_played > 0), 0), 1) as pct_finished
from user_games ug
join catalog_games c on c.steam_appid = ug.catalog_steam_appid
where ug.access_source = 'owned'
  and c.duration_kind = 'finite'
  and c.main_story_minutes is not null
group by 1
order by min(c.main_story_minutes);
```

### `mostPlayed`

Ownership is a bad ranking — it mostly records what Valve bundled. This ranks
on what people did with a game instead. Note the two `having` floors and the
`nulls last`: without them the top of the list is giveaway games with 100
owners and zero players, whose score is null.

```sql
with base as (
  select c.name, c.steam_appid,
         round(c.main_story_minutes/60.0, 1)                      as main_hours,
         count(*)                                                 as owners,
         count(*) filter (where ug.hours_played > 0)              as launched,
         count(*) filter (where ug.status = 'Completed')           as completed,
         (percentile_cont(0.5) within group (order by ug.hours_played)
           filter (where ug.hours_played > 0))::numeric            as median_hours
  from user_games ug
  join catalog_games c on c.steam_appid = ug.catalog_steam_appid
  where ug.access_source = 'owned'
    and c.duration_kind = 'finite'
    and c.review_total >= 1000
    and c.main_story_minutes is not null
  group by c.name, c.steam_appid, c.main_story_minutes
  having count(*) >= 40
     and count(*) filter (where ug.hours_played > 0) >= 25
)
select name, steam_appid as appid, main_hours, owners,
       round(100.0 * launched / owners)::int      as pct_launched,
       round(median_hours, 1)                     as median_hours,
       round(100.0 * completed / launched)::int    as pct_finished,
       round((launched::numeric / owners)
             * least(median_hours, 60::numeric)
             * (1 + 2.0 * completed / launched), 1) as score
from base
order by score desc nulls last
limit 15;
```

`least(median_hours, 60)` caps the hours term so one genre of very long game
cannot take the whole table. `duration_kind = 'finite'` excludes endless games,
without which this is a list of MMOs and idle games that win an hours contest by
definition rather than by merit.

### `mostFinished`

```sql
select c.name, c.steam_appid as appid,
       round(c.main_story_minutes/60.0, 1)              as main_hours,
       count(*) filter (where ug.hours_played > 0)      as started,
       round(100.0 * count(*) filter (where ug.status = 'Completed')
             / nullif(count(*) filter (where ug.hours_played > 0), 0))::int as pct_finished
from user_games ug
join catalog_games c on c.steam_appid = ug.catalog_steam_appid
where ug.access_source = 'owned'
  and c.duration_kind = 'finite'
  and c.main_story_minutes is not null
group by c.name, c.steam_appid, c.main_story_minutes
having count(*) filter (where ug.hours_played > 0) >= 40
order by pct_finished desc
limit 12;
```

## The caveat every post has to carry

`status = 'Completed'` is a user action in the app. These are **marking** rates,
not true completion rates — anyone who finished a game and never ticked it off
is counted as unfinished. The absolute percentages are therefore low, and it is
the shape across bands, not the height, that any finding should rest on. Both
stats posts say this in an aside; keep it that way.

The sample is also not Steam. It is people who went looking for a backlog tool,
which if anything skews toward those whose backlog already bothers them.

## Before publishing any of this

`app/privacy/page.tsx` currently says nothing about aggregate or anonymised
data. Counts over hundreds of libraries are not personal data in any meaningful
sense, and nothing here can be traced to an account — but the policy should say
that the data is used this way before a post quoting it goes out.
