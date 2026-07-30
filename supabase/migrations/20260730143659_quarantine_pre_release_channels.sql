-- Pre-release clients are separate Steam AppIDs rather than playable library
-- entries. Keep them reviewable in quarantine while excluding them from every
-- user-facing pool.
with release_channel_candidates as (
  select
    catalog.steam_appid,
    catalog.name,
    catalog.steam_type,
    catalog.genres,
    catalog.categories,
    case
      when catalog.name ~* '(^|[^[:alnum:]])playtest([^[:alnum:]]|$)' then 'release_channel:playtest'
      when catalog.name ~* '(^|[^[:alnum:]])public[[:space:]-]+test([^[:alnum:]]|$)' then 'release_channel:public_test'
      when catalog.name ~* '(^|[^[:alnum:]])test[[:space:]-]+(realm|server)([^[:alnum:]]|$)' then 'release_channel:test_environment'
      when catalog.name ~* '(^|[^[:alnum:]])ptr([^[:alnum:]]|$)' then 'release_channel:ptr'
      when catalog.name ~* '(^|[^[:alnum:]])pts([^[:alnum:]]|$)' then 'release_channel:pts'
      when catalog.name ~* '(^|[^[:alnum:]])beta([^[:alnum:]]|$)' then 'release_channel:beta'
    end as matched_rule
  from public.catalog_games catalog
  where catalog.name ~* '(^|[^[:alnum:]])(playtest|ptr|pts|beta)([^[:alnum:]]|$)|(^|[^[:alnum:]])public[[:space:]-]+test([^[:alnum:]]|$)|(^|[^[:alnum:]])test[[:space:]-]+(realm|server)([^[:alnum:]]|$)'
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
  candidate.matched_rule,
  'The Steam title identifies this AppID as a beta, PTR, playtest, or other test environment.',
  coalesce(candidate.genres, array[]::text[]),
  coalesce(candidate.categories, array[]::text[]),
  'excluded',
  'automatic',
  now(),
  now()
from release_channel_candidates candidate
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
  and quarantine.matched_rule like 'release_channel:%';

