-- Let a player put a game back into the Purge queue by hand.
--
-- The queue is built from evidence: never opened, or observed to have gone
-- untouched. That is right as a default, but it leaves no way to say "actually,
-- I want to decide about this one" - which is exactly what someone browsing
-- their already-reviewed and never-flagged games wants to do.
--
-- A flag is cleared the moment a decision is recorded, so it pushes a game into
-- the queue once rather than pinning it there.

alter table public.user_games
  add column if not exists review_requested_at timestamptz;

create index if not exists user_games_review_requested_idx
  on public.user_games (user_id)
  where review_requested_at is not null;

create or replace function public.request_user_game_review(
  p_user_id uuid,
  p_game_ids uuid[]
) returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_updated integer;
begin
  if p_user_id is null then
    raise exception 'INVALID_REVIEW_USER';
  end if;
  if p_game_ids is null or cardinality(p_game_ids) = 0 then
    return 0;
  end if;
  if cardinality(p_game_ids) > 500 then
    raise exception 'REVIEW_BATCH_TOO_LARGE';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  update public.user_games
  set review_requested_at = now(),
      updated_at = now()
  where user_id = p_user_id
    and id = any(p_game_ids)
    and ownership = 'Owned'
    -- A completed or sleeping game is not waiting on a decision; those are
    -- changed from the Library, not flagged back into a review queue.
    and status in ('Not Started', 'Sampled', 'In Progress');

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$function$;

revoke all on function public.request_user_game_review(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.request_user_game_review(uuid, uuid[]) to service_role;

-- Surface the manual review flag.
create or replace view public.user_games_with_catalog as
SELECT g.id,
    g.user_id,
    c.name AS title,
        CASE
            WHEN cardinality(c.genres) > 0 THEN array_to_string(c.genres, ' / '::text)
            ELSE 'Unknown'::text
        END AS genre,
    'Steam'::text AS store,
    g.ownership,
    g.status,
        CASE
            WHEN COALESCE(c.review_total, 0) > 0 THEN round(c.review_positive::numeric * 10.0 / c.review_total::numeric)::integer
            ELSE g.rating
        END AS rating,
    g.hours_played,
    g.completion_percentage,
    g.priority,
    g.date_added,
    g.notes,
    c.steam_appid::text AS steam_appid,
    g.created_at,
    g.updated_at,
    g.last_played_at,
    g.completed_at,
    g.slept_at,
    g.completion_suggestion_dismissed_at,
    g.completion_suggestion_dismissed_playtime,
    c.main_story_minutes,
    c.main_extras_minutes,
    c.completionist_minutes,
    c.duration_source,
    c.duration_source_updated_at,
    c.duration_confidence,
    g.previous_active_status,
    q.steam_appid IS NOT NULL AS is_quarantined,
    q.reason AS quarantine_reason,
    c.steam_appid AS catalog_steam_appid,
    c.capsule_url,
    c.header_url,
    c.price_currency,
    c.price_initial,
    c.price_final,
    c.discount_percent,
    c.is_free,
    c.duration_kind,
    c.tags AS steam_tags,
    c.platform_windows,
    c.platform_mac,
    c.platform_linux,
    c.deck_compatibility,
    c.review_positive,
    c.review_negative,
    c.review_total,
    c.release_date,
    c.duration_status,
    c.tags_status,
    c.short_description,
    g.last_observed_played_at,
    g.recency_source,
    g.recency_evidence_at,
    g.observed_playtime_minutes,
    g.review_requested_at
   FROM user_games g
     JOIN catalog_games c ON c.steam_appid = g.catalog_steam_appid
     LEFT JOIN catalog_game_quarantine q ON q.steam_appid = c.steam_appid AND q.review_status = 'excluded'::text;
