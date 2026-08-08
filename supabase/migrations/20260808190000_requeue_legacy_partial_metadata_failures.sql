-- Earlier metadata workers terminalised useful partial Steam responses after a
-- single attempt. The current worker accepts partial records and retries
-- transient failures, so make those legacy rows eligible for processing again.
update public.steam_app_metadata
set status = 'pending',
    failure_count = 0,
    last_error = null,
    next_attempt_at = now(),
    processing_started_at = null,
    updated_at = now()
where status = 'failed'
  and failure_count < 6
  and last_error in (
    'Steam did not return genre or review metadata.',
    'Steam returned reviews but not genre metadata.'
  );

-- Preserve genuinely unavailable Steam apps as terminal failures. Some rows
-- created by the old worker retained a retry timestamp despite being permanent.
update public.steam_app_metadata
set next_attempt_at = null,
    processing_started_at = null,
    updated_at = now()
where status = 'failed'
  and last_error like 'Steam Store reports AppID % as unavailable.';
