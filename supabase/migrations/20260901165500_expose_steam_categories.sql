-- Steam's own categories, for the player-mode global filter.
--
-- The view already carries c.tags, but tags are crowd votes and cannot carry a
-- filter: Counter-Strike 2 has thirty thousand votes for "Co-op" and is not a
-- co-op game. Filtering on that would quietly hide the wrong games, which is the
-- worst thing a filter can do. categories is Steam's own structured field -
-- "Single-player", "Multi-player", "Co-op", "Online Co-op", "Shared/Split
-- Screen" - and it is what the filter can actually stand on.
--
-- Appended at the end because CREATE OR REPLACE VIEW may only add columns after
-- the existing ones, never reorder them. The rest of this definition is
-- unchanged from what is live.

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
    g.review_requested_at,
    c.categories AS steam_categories
   FROM user_games g
     JOIN catalog_games c ON c.steam_appid = g.catalog_steam_appid
     LEFT JOIN catalog_game_quarantine q ON q.steam_appid = c.steam_appid AND q.review_status = 'excluded'::text;
