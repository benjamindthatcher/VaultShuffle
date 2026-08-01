-- Correct false endless classifications and exclude explicit Steam staging clients.
-- A broad genre such as Free to Play is not evidence that a game has no ending.

with staging_candidates as (
  select
    catalog.steam_appid,
    catalog.name,
    catalog.steam_type,
    catalog.genres,
    catalog.categories
  from public.catalog_games catalog
  where catalog.name ~* '(^|[^[:alnum:]])staging([[:space:]-]+branch)?([^[:alnum:]]|$)'
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
select
  candidate.steam_appid,
  candidate.name,
  candidate.steam_type,
  'release_channel:staging',
  'The Steam title identifies this AppID as a staging branch rather than the released game.',
  coalesce(candidate.genres, array[]::text[]),
  coalesce(candidate.categories, array[]::text[]),
  'excluded',
  'automatic',
  now(),
  now()
from staging_candidates candidate
on conflict (steam_appid) do update
set name = excluded.name,
    steam_type = excluded.steam_type,
    matched_rule = excluded.matched_rule,
    reason = excluded.reason,
    genres = excluded.genres,
    categories = excluded.categories,
    review_status = 'excluded',
    last_detected_at = now(),
    updated_at = now()
where public.catalog_game_quarantine.source = 'automatic';

update public.catalog_ingest_queue queue
set status = 'rejected',
    rejection_reason = quarantine.reason,
    processed_at = now(),
    processing_started_at = null,
    last_error = null,
    updated_at = now()
from public.catalog_game_quarantine quarantine
where queue.steam_appid = quarantine.steam_appid
  and quarantine.review_status = 'excluded'
  and quarantine.source = 'automatic'
  and quarantine.matched_rule = 'release_channel:staging';

-- Fancy Skulls (Steam AppID 307090) has no provider duration yet, but it is a
-- finite action game. Remove the false endless classification and return it to
-- the duration review queue.
update public.catalog_games
set duration_kind = 'unknown',
    duration_status = 'review_required',
    updated_at = now()
where steam_appid = 307090
  and duration_kind = 'endless';

update public.game_duration_jobs
set status = 'needs_review',
    locked_at = null,
    locked_by = null,
    updated_at = now()
where steam_app_id = 307090;

-- Remove the 99% sentinel previously copied into per-user state. Until a
-- provider duration is matched, use the same conservative 20-hour action-game
-- fallback used by the application.
update public.games
set completion_percentage = least(
      99,
      greatest(0, round((coalesce(hours_played, 0) / 20.0) * 100))
    ),
    updated_at = now()
where steam_appid = '307090'
  and status <> 'Completed'
  and completion_percentage = 99;
