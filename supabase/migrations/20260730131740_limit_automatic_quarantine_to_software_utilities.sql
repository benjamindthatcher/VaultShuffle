-- Automatic exclusion is intentionally narrow. Titles, Steam app types,
-- missing metadata, test labels, and generic tool-like words are not reliable
-- enough to remove an imported game. Manual decisions remain untouched.
delete from public.catalog_game_quarantine q
where q.source = 'automatic'
  and not (
    q.matched_rule in ('steam_label:software', 'steam_label:utilities')
    or exists (
      select 1
      from unnest(coalesce(q.genres, array[]::text[]) || coalesce(q.categories, array[]::text[])) label
      where lower(trim(label)) in ('software', 'utilities')
    )
  );

update public.catalog_game_quarantine q
set matched_rule = case
      when exists (
        select 1 from unnest(coalesce(q.genres, array[]::text[]) || coalesce(q.categories, array[]::text[])) label
        where lower(trim(label)) = 'software'
      ) then 'steam_label:software'
      else 'steam_label:utilities'
    end,
    reason = case
      when exists (
        select 1 from unnest(coalesce(q.genres, array[]::text[]) || coalesce(q.categories, array[]::text[])) label
        where lower(trim(label)) = 'software'
      ) then 'Steam classified this AppID as software, not a game.'
      else 'Steam classified this AppID as utilities, not a game.'
    end,
    updated_at = now()
where q.source = 'automatic';

update public.catalog_ingest_queue queue
set status = 'pending',
    attempts = 0,
    next_attempt_at = now(),
    processing_started_at = null,
    processed_at = null,
    rejection_reason = null,
    last_error = null,
    updated_at = now()
where queue.status = 'rejected'
  and not exists (
    select 1
    from public.catalog_game_quarantine q
    where q.steam_appid = queue.steam_appid
      and q.review_status = 'excluded'
  );
-- Version aligned with the production Supabase migration history.
