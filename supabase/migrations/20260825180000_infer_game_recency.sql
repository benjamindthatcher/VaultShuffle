-- VaultShuffle-owned recency.
--
-- Steam's GetOwnedGames returns rtime_last_played for the account that owns the
-- API key, but not reliably for ordinary third-party users, even when their
-- library and lifetime playtime are public. Exact last-played timestamps can
-- therefore no longer be the foundation of anything.
--
-- Recency is now inferred from evidence VaultShuffle can actually obtain:
-- watching cumulative playtime rise between observations, and Steam's
-- recently-played window. Exact timestamps stay as one optional extra source.
--
-- The rule that matters: absent evidence is UNKNOWN, never "a long time ago".

alter table public.user_games
  add column if not exists last_observed_played_at timestamptz,
  add column if not exists recency_source text,
  add column if not exists recency_evidence_at timestamptz,
  -- The cumulative playtime we last saw, in minutes. A rise above this is proof
  -- the game was played between that observation and this one. Null means we
  -- have never observed it, which is why a first import proves nothing.
  add column if not exists observed_playtime_minutes integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'user_games_recency_source_check'
  ) then
    alter table public.user_games
      add constraint user_games_recency_source_check
      check (recency_source is null or recency_source in (
        'steam_exact',
        'observed_playtime_change',
        'steam_recent_window'
      ));
  end if;
end $$;

-- Existing exact timestamps are real evidence and are kept as such. A null stays
-- null: it means we do not know, and must never be read as ancient.
update public.user_games
set last_observed_played_at = last_played_at,
    recency_source = 'steam_exact',
    recency_evidence_at = coalesce(updated_at, created_at, now())
where last_played_at is not null
  and recency_source is null;

-- Seed the playtime baseline from what we already hold, so the next observation
-- has something to compare against. This deliberately records no recency: 150
-- lifetime hours is not evidence the game was played today.
update public.user_games
set observed_playtime_minutes = round(coalesce(hours_played, 0) * 60)::integer
where observed_playtime_minutes is null;

create index if not exists user_games_recency_idx
  on public.user_games (user_id, last_observed_played_at desc nulls last);

-- Surface the inferred recency to the app.
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
    g.observed_playtime_minutes
   FROM user_games g
     JOIN catalog_games c ON c.steam_appid = g.catalog_steam_appid
     LEFT JOIN catalog_game_quarantine q ON q.steam_appid = c.steam_appid AND q.review_status = 'excluded'::text;
