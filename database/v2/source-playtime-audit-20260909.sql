begin transaction isolation level repeatable read read only; set local statement_timeout = '30s'; set local lock_timeout = '2s'; set local timezone = 'UTC'; select jsonb_build_object('source_project_ref','pfvblcopcmairdfeqdep','observed_at_utc',clock_timestamp(),'evidence_kind','read-only playtime/staging aggregate audit; not export or freeze','probe_1', (select coalesce(jsonb_agg(row_to_json(r)), '[]'::jsonb) from (with reproduced as (
  select
    ug.access_source,
    ug.hours_played,
    ug.observed_playtime_minutes,
    case
      when ug.observed_playtime_minutes is null then null
      else round((ug.observed_playtime_minutes::numeric / 60) * 10) / 10
    end as hours_from_minutes
  from user_games ug
)
select
  access_source,
  count(*)                                                          as rows_total,
  count(*) filter (where observed_playtime_minutes is null)         as minutes_null,
  count(*) filter (where observed_playtime_minutes is not null)     as minutes_present,
  count(*) filter (
    where observed_playtime_minutes is not null
      and hours_played is distinct from hours_from_minutes
  )                                                                 as hours_not_reproducible,
  count(*) filter (
    where observed_playtime_minutes is null and hours_played > 0
  )                                                                 as hours_without_minutes,
  count(*) filter (
    where observed_playtime_minutes is null and hours_played = 0
  )                                                                 as zero_hours_unknown_minutes,
  count(*) filter (where observed_playtime_minutes = 0)             as observed_zero_minutes
from reproduced
group by access_source
order by access_source) r),'probe_2', (select coalesce(jsonb_agg(row_to_json(r)), '[]'::jsonb) from (with reproduced as (
  select
    ug.access_source,
    ug.hours_played,
    round((ug.observed_playtime_minutes::numeric / 60) * 10) / 10 as hours_from_minutes
  from user_games ug
  where ug.observed_playtime_minutes is not null
),
divergent as (
  select access_source, abs(hours_played - hours_from_minutes) as delta
  from reproduced
  where hours_played is distinct from hours_from_minutes
)
select
  access_source,
  count(*)                                            as divergent_rows,
  count(*) filter (where delta <= 0.1)                as delta_within_one_decimal,
  count(*) filter (where delta > 0.1 and delta <= 1)  as delta_under_an_hour,
  count(*) filter (where delta > 1   and delta <= 10) as delta_under_ten_hours,
  count(*) filter (where delta > 10)                  as delta_over_ten_hours,
  max(delta)                                          as largest_delta_hours
from divergent
group by access_source
order by access_source) r),'probe_3', (select coalesce(jsonb_agg(row_to_json(r)), '[]'::jsonb) from (select
  count(distinct ug.user_id) as accounts_with_any_divergent_row
from user_games ug
where ug.observed_playtime_minutes is not null
  and ug.hours_played is distinct from
      (round((ug.observed_playtime_minutes::numeric / 60) * 10) / 10)) r),'probe_4', (select coalesce(jsonb_agg(row_to_json(r)), '[]'::jsonb) from (select
  count(*)                                        as pin_rows,
  count(*) filter (where hours_at_pin is null)    as baseline_null,
  count(*) filter (where hours_at_pin < 0)        as negative_baseline_conflicts,
  count(*) filter (
    where hours_at_pin is not null
      and (hours_at_pin::numeric * 60) <> round(hours_at_pin::numeric * 60)
  )                                               as conversion_loses_precision
from user_game_pins) r),'probe_5', (select coalesce(jsonb_agg(row_to_json(r)), '[]'::jsonb) from (select
  count(*)                                             as completion_events,
  count(*) filter (where hours_played is null)         as hours_null,
  count(*) filter (where estimate_minutes is null)     as estimate_minutes_null,
  count(*) filter (where price_cents is null)          as price_cents_null,
  count(*) filter (
    where hours_played is not null
      and (hours_played::numeric * 60) <> round(hours_played::numeric * 60)
  )                                                    as hours_not_whole_minutes
from completion_events) r),'probe_6', (select coalesce(jsonb_agg(row_to_json(r)), '[]'::jsonb) from (select
  count(*)                                                       as staging_rows,
  count(ug.user_id)                                              as staging_rows_with_live_parent,
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
from user_game_state s
left join user_games ug
  on ug.user_id = s.user_id
 and ug.catalog_steam_appid = s.appid) r),'probe_7', (select coalesce(jsonb_agg(row_to_json(r)), '[]'::jsonb) from (with divergent as (
  select
    s.user_id,
    count(*) as divergent_rows
  from user_game_state s
  left join user_games ug
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
from divergent) r),'probe_8', (select coalesce(jsonb_agg(row_to_json(r)), '[]'::jsonb) from (select
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
from user_game_state) r),'probe_9', (select coalesce(jsonb_agg(row_to_json(r)), '[]'::jsonb) from (select count(*) as staging_rows_without_parent
from user_game_state s
left join user_games ug
  on ug.user_id = s.user_id
 and ug.catalog_steam_appid = s.appid
where ug.user_id is null) r)) as audit; commit;
