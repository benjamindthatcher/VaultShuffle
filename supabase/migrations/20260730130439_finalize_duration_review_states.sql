-- Remove the legacy no_match terminal state. Known endless and not-applicable
-- records are complete classifications; genuinely unresolved finite-duration
-- candidates are explicit review work.
update public.catalog_games
set duration_status = 'ready',
    updated_at = now()
where duration_kind in ('endless', 'not-applicable')
  and duration_status <> 'ready';

update public.catalog_games
set duration_status = 'review_required',
    updated_at = now()
where duration_kind = 'unknown'
  and duration_status <> 'review_required';

update public.game_duration_jobs j
set status = 'needs_review',
    locked_at = null,
    locked_by = null,
    updated_at = now()
from public.catalog_games c
where c.steam_appid = j.steam_app_id
  and c.duration_kind = 'unknown'
  and c.duration_status = 'review_required';

update public.game_duration_jobs j
set status = 'completed',
    locked_at = null,
    locked_by = null,
    last_error_code = null,
    last_error_message = null,
    updated_at = now()
from public.catalog_games c
where c.steam_appid = j.steam_app_id
  and c.duration_kind in ('finite', 'endless', 'not-applicable')
  and c.duration_status = 'ready';
-- Version aligned with the production Supabase migration history.
