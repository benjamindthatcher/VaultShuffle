update public.steam_app_metadata
set
  status = 'pending',
  failure_count = 0,
  last_error = null,
  next_attempt_at = now(),
  processing_started_at = null,
  updated_at = now()
where status = 'failed'
  and (
    last_error ilike '%HTTP 429%'
    or last_error ilike '%HTTP 403%'
  );
