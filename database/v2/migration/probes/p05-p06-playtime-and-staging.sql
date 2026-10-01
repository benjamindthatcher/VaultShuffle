-- ============================================================================
-- M3 source probes P05-P06  --  readiness section 10, items 5 and 6
-- COUNT-ONLY. Read-only. NOT RUN in this batch; proposed for coordinator review.
--
-- These two probes decide two binding dispositions:
--   P05 decides whether app.library_games.playtime_minutes may be sourced from
--       observed_playtime_minutes ALONE.
--   P06 measures how far the stale public.user_game_state staging copy diverges from
--       the authoritative public.user_games row.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- P05  Authored playtime.
--
-- readiness 8.1: on the IMPORT path, hours_played is derived and rounded:
--     Math.round(((minutes ?? 0) / 60) * 10) / 10        lib/steam-owned-games.ts:32
-- But hours_played is ALSO client-authored (lib/validation.ts:26, :38;
-- app/api/games/[id]/route.ts:14, :26; lib/games.ts:117), while
-- observed_playtime_minutes has NO writer in lib/ or app/ at all -- it is set
-- only by server-side SQL in the import and refresh routines.
--
-- So an edited hours_played never reaches observed_playtime_minutes, and
-- sourcing minutes from the latter alone would silently discard exactly the
-- authored fact plan 14.2 says to preserve.
--
-- Plan section 2's count of 1,262 rows missing exact minutes -- all family rows
-- -- SUGGESTS the affected population may be zero. A count is not a proof.
-- This probe is the proof, or the refutation.
--
-- The comparison evaluates both a decimal arithmetic reproduction and the
-- positive IEEE-754 path used by JavaScript's Math.round. A disagreement between
-- those formulas is itself a measured boundary, never silently normalised.
-- ----------------------------------------------------------------------------

-- P05a  The headline number, split by access_source as readiness 10.5 requires.
with reproduced as (
  select
    case
      when ug.access_source in ('owned', 'family') then ug.access_source
      when ug.access_source is null then 'null'
      else 'other'
    end as access_source_bucket,
    ug.hours_played,
    ug.observed_playtime_minutes,
    case
      when ug.observed_playtime_minutes is null then null
      else round((ug.observed_playtime_minutes::numeric / 60) * 10) / 10
    end as hours_from_decimal,
    case
      when ug.observed_playtime_minutes is null then null
      else floor(
        ((ug.observed_playtime_minutes::double precision / 60.0) * 10.0) + 0.5
      ) / 10.0
    end as hours_from_ieee
  from public.user_games ug
)
select
  access_source_bucket,
  count(*)                                                          as rows_total,
  count(*) filter (where observed_playtime_minutes is null)         as minutes_null,
  count(*) filter (where observed_playtime_minutes is not null)     as minutes_present,
  -- The decisive number: minutes exist, but they do NOT reproduce the stored hours.
  count(*) filter (where observed_playtime_minutes is not null
                     and hours_played is distinct from hours_from_decimal)
                                                                  as hours_not_reproducible_by_decimal,
  count(*) filter (where observed_playtime_minutes is not null
                     and hours_played is distinct from hours_from_ieee::numeric)
                                                                  as hours_not_reproducible_by_ieee,
  count(*) filter (where hours_from_decimal is distinct from hours_from_ieee::numeric)
                                                                  as decimal_vs_ieee_formula_mismatch,
  -- Rows where hours are non-zero but exact minutes are absent entirely.
  count(*) filter (
    where observed_playtime_minutes is null and hours_played > 0
  )                                                                 as hours_without_minutes,
  -- readiness 8.1: hours_played = 0 must never become an OBSERVED zero.
  count(*) filter (
    where observed_playtime_minutes is null and hours_played = 0
  )                                                                 as zero_hours_unknown_minutes,
  count(*) filter (where observed_playtime_minutes = 0)             as observed_zero_minutes,
  count(*) filter (where observed_playtime_minutes in (0, 1, 3, 6, 59, 60, 61))
                                                                  as boundary_minute_rows,
  count(*) filter (where observed_playtime_minutes >= 2147483647)
                                                                  as max_integer_minute_rows
from reproduced
group by access_source_bucket
order by access_source_bucket;

-- P05b  How BIG are the divergences? A one-decimal float artefact is a very
-- different finding from a user typing 40 hours into a game with 3 recorded
-- minutes. Bucketed; no per-row values.
with reproduced as (
  select
    case
      when ug.access_source in ('owned', 'family') then ug.access_source
      when ug.access_source is null then 'null'
      else 'other'
    end as access_source_bucket,
    ug.hours_played,
    round((ug.observed_playtime_minutes::numeric / 60) * 10) / 10 as hours_from_decimal
  from public.user_games ug
  where ug.observed_playtime_minutes is not null
),
divergent as (
  select access_source_bucket, abs(hours_played - hours_from_decimal) as delta
  from reproduced
  where hours_played is distinct from hours_from_decimal
)
select
  access_source_bucket,
  count(*)                                            as divergent_rows,
  count(*) filter (where delta <= 0.1)                as delta_within_one_decimal,
  count(*) filter (where delta > 0.1 and delta <= 1)  as delta_under_an_hour,
  count(*) filter (where delta > 1   and delta <= 10) as delta_under_ten_hours,
  count(*) filter (where delta > 10)                  as delta_over_ten_hours,
  max(delta)                                          as largest_delta_hours
from divergent
group by access_source_bucket
order by access_source_bucket;

-- P05c  How many ACCOUNTS are affected? A divergence concentrated in one
-- account is an anomaly; one spread across many is a systematic write path.
select
  count(distinct ug.user_id) as accounts_with_any_divergent_row
from public.user_games ug
where ug.observed_playtime_minutes is not null
  and ug.hours_played is distinct from
      (round((ug.observed_playtime_minutes::numeric / 60) * 10) / 10);

-- P05d  Corroboration from the pins table, whose hours_at_pin is the other
-- rounded-hours column and is subject to the same unit conversion (readiness 8.2).
select
  count(*)                                        as pin_rows,
  count(*) filter (where hours_at_pin is null)    as baseline_null,
  count(*) filter (where hours_at_pin::text in ('NaN', 'Infinity', '-Infinity'))
                                                   as non_finite_baseline_conflicts,
  count(*) filter (where hours_at_pin < 0)        as negative_baseline_conflicts,
  -- A non-integral minute value after conversion means the source hours had
  -- precision that round(hours*60) will silently discard.
  count(*) filter (
    where hours_at_pin is not null
      and (hours_at_pin::numeric * 60) <> round(hours_at_pin::numeric * 60)
  )                                               as conversion_loses_precision
from public.user_game_pins;

-- P05e  public.completion_events.hours_played, the third numeric narrowing in
-- readiness 8.2, which has no agreed home at all.
select
  count(*)                                             as completion_event_rows,
  count(*) filter (where hours_played is null)         as hours_null,
  count(*) filter (where estimate_minutes is null)     as estimate_minutes_null,
  count(*) filter (where price_cents is null)          as price_cents_null,
  count(*) filter (
    where hours_played is not null
      and (hours_played::numeric * 60) <> round(hours_played::numeric * 60)
  )                                                    as hours_not_whole_minutes,
  count(*) filter (
    where hours_played::text in ('NaN', 'Infinity', '-Infinity')
  )                                                    as non_finite_hours_conflicts
from public.completion_events;


-- ----------------------------------------------------------------------------
-- P06  Staging divergence.
--
-- readiness 5: public.user_game_state is a STALE child of public.user_games on
-- (user_id, appid) = (user_id, catalog_steam_appid) -- the exact join key a
-- transform would naturally use. Plan section 2 records that it CONTAINS 24,428
-- rows; how many actually DIFFER is unmeasured, and that is this probe.
--
-- Nothing this probe returns changes a migrated value. Its output goes in the
-- conflict report only. The staging table must never be joined to a target.
-- ----------------------------------------------------------------------------

-- P06a  Total divergence across every duplicated field.
select
  count(*)                                                       as staging_rows,
  count(ug.user_id)                                              as staging_rows_with_live_parent,
  -- The two fields readiness 5 control 3 names explicitly.
  count(*) filter (
    where s.completed_at is not null and ug.completed_at is null
  )                                                              as staging_asserts_unrecorded_completion,
  count(*) filter (
    where s.slept_at is not null and ug.slept_at is null
  )                                                              as staging_asserts_unrecorded_sleep,
  count(*) filter (
    where s.completed_at is null and ug.completed_at is not null
  )                                                              as live_completion_absent_from_staging,
  count(*) filter (
    where s.slept_at is null and ug.slept_at is not null
  )                                                              as live_sleep_absent_from_staging,
  -- Any disagreement at all on a completion or sleep instant.
  count(*) filter (where s.completed_at is distinct from ug.completed_at)
                                                                 as completed_at_differs,
  count(*) filter (where s.slept_at is distinct from ug.slept_at) as slept_at_differs,
  count(*) filter (where s.review_requested_at is distinct from ug.review_requested_at)
                                                                 as review_requested_differs,
  count(*) filter (where s.dismissed_at is distinct from ug.completion_suggestion_dismissed_at)
                                                                 as dismissed_at_differs,
  count(*) filter (where s.dismissed_playtime is distinct from ug.completion_suggestion_dismissed_playtime)
                                                                 as dismissed_playtime_differs,
  count(*) filter (where s.last_played_at is distinct from ug.last_played_at)
                                                                 as last_played_differs,
  count(*) filter (where s.last_observed_played_at is distinct from ug.last_observed_played_at)
                                                                 as last_observed_differs,
  count(*) filter (where s.recency_evidence_at is distinct from ug.recency_evidence_at)
                                                                 as recency_evidence_differs,
  count(*) filter (where s.family_owner_steam_id is distinct from ug.family_owner_steam_id)
                                                                 as family_owner_differs,
  count(*) filter (where s.family_verified_at is distinct from ug.family_verified_at)
                                                                 as family_verified_differs
from public.user_game_state s
left join public.user_games ug
  on ug.user_id = s.user_id
 and ug.catalog_steam_appid = s.appid;

-- P06b  How many ACCOUNTS are affected, and how concentrated is it?
-- readiness 5 control 3 requires a PER-ACCOUNT count; this reports the shape of
-- that distribution without emitting an account identifier.
with divergent as (
  select
    s.user_id,
    count(*) as divergent_rows
  from public.user_game_state s
  left join public.user_games ug
    on ug.user_id = s.user_id
   and ug.catalog_steam_appid = s.appid
  where s.completed_at is distinct from ug.completed_at
     or s.slept_at     is distinct from ug.slept_at
  group by s.user_id
)
select
  count(*)                                         as accounts_affected,
  sum(divergent_rows)                              as divergent_rows_total,
  min(divergent_rows)                              as min_rows_per_account,
  max(divergent_rows)                              as max_rows_per_account,
  round(avg(divergent_rows), 2)                    as mean_rows_per_account,
  count(*) filter (where divergent_rows = 1)       as accounts_with_one,
  count(*) filter (where divergent_rows between 2 and 10)  as accounts_with_2_to_10,
  count(*) filter (where divergent_rows > 10)      as accounts_with_over_10
from divergent;

-- P06c  Age of the staging copy. If every divergent row is old, the table is
-- simply abandoned; if any are recent, something is still writing to it and the
-- quarantine assumption needs re-examining before the freeze.
select
  count(*)                                                     as staging_rows,
  max(greatest(
    coalesce(completed_at,  '-infinity'::timestamptz),
    coalesce(slept_at,      '-infinity'::timestamptz),
    coalesce(dismissed_at,  '-infinity'::timestamptz),
    coalesce(review_requested_at, '-infinity'::timestamptz),
    coalesce(recency_evidence_at, '-infinity'::timestamptz)
  ))                                                           as most_recent_staging_activity,
  count(*) filter (
    where greatest(
      coalesce(completed_at,  '-infinity'::timestamptz),
      coalesce(slept_at,      '-infinity'::timestamptz),
      coalesce(dismissed_at,  '-infinity'::timestamptz),
      coalesce(review_requested_at, '-infinity'::timestamptz),
      coalesce(recency_evidence_at, '-infinity'::timestamptz)
    ) > now() - interval '30 days'
  )                                                            as rows_touched_in_last_30_days
from public.user_game_state;

-- P06d  Orphan check. The FK cascades, so there should be no staging row
-- without a parent. A non-zero result would mean the FK is not what the
-- inventory says it is.
select count(*) as staging_rows_without_parent
from public.user_game_state s
left join public.user_games ug
  on ug.user_id = s.user_id
 and ug.catalog_steam_appid = s.appid
where ug.user_id is null;
