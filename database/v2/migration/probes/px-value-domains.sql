-- ============================================================================
-- M3 source probes PX-a .. PX-i  --  value-domain questions added by this batch
-- COUNT-ONLY. Read-only. NOT RUN in this batch; proposed for coordinator review.
--
-- These are not from readiness section 10. They arose while writing the
-- disposition manifest: each one is a column whose disposition cannot be
-- decided without knowing what values the source actually holds.
--
-- Every GROUP BY here is over a low-cardinality, non-identifying enumeration.
-- No free text, no name, no email, no URL and no JSON VALUE is returned.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- PX-a  public.user_games.ownership.
-- v2 app.library_games has account_id, game_id and playtime_minutes only
-- (M1:226-231) and carries NO ownership column, yet app.pins.scope has a
-- 'wishlist' value (M1:374), so v2 expects the concept to live somewhere.
-- Dropping ownership silently would collapse wishlist rows into the owned library.
-- ----------------------------------------------------------------------------
select
  case
    when ownership in ('Owned', 'Wishlist') then ownership
    when ownership is null then 'null'
    else 'other'
  end                                                     as ownership_bucket,
  case
    when access_source in ('owned', 'family') then access_source
    when access_source is null then 'null'
    else 'other'
  end                                                     as access_source_bucket,
  count(*)                                                as rows,
  count(distinct user_id)                                 as accounts,
  count(*) filter (where observed_playtime_minutes is not null) as with_exact_minutes,
  count(*) filter (where hours_played > 0)                as with_nonzero_hours
from public.user_games
group by 1, 2
order by count(*) desc;


-- ----------------------------------------------------------------------------
-- PX-b  public.user_games.previous_active_status.
-- v2 constrains it to 'Not Started' | 'Sampled' | 'In Progress' (M1:238-239).
-- It remains one of plan 14.2's open fields: readiness 8.4 explicitly declines
-- to close it. A value outside the v2 domain is a reported conflict, never a
-- coercion.
-- ----------------------------------------------------------------------------
select
  case
    when previous_active_status in ('Not Started', 'Sampled', 'In Progress')
      then previous_active_status
    when previous_active_status is null then 'null'
    else 'other'
  end                                                          as value_bucket,
  count(*)                                                     as rows,
  count(*) filter (where previous_active_status is not null
                     and previous_active_status not in
                         ('Not Started', 'Sampled', 'In Progress'))
                                                               as outside_v2_domain
from public.user_games
group by 1
order by count(*) desc;

-- PX-b-2  status, for the same reason. readiness 8.4 concludes status is
-- DERIVED and therefore retirable, so this confirms the derivation holds
-- rather than assuming it.
select
  case
    when status in ('Not Started', 'Sampled', 'In Progress', 'Slept', 'Completed')
      then status
    when status is null then 'null'
    else 'other'
  end                                                          as status_bucket,
  count(*)                                                    as rows,
  count(*) filter (where completed_at is not null)            as with_completed_at,
  count(*) filter (where slept_at is not null)                as with_slept_at,
  min(completion_percentage)                                  as min_progress,
  max(completion_percentage)                                  as max_progress
from public.user_games
group by 1
order by count(*) desc;


-- ----------------------------------------------------------------------------
-- PX-c  public.purge_reviews with action = 'complete' that have no matching
-- public.completion_events row.
--
-- Plan section 3 requires user history to survive. If a purge completion was
-- never recorded as a completion event, then archiving public.purge_reviews alone
-- LOSES a completion. If it always was recorded, then generating events from
-- public.purge_reviews would DOUBLE-COUNT. Decision D-PRG-1 turns on this number.
-- ----------------------------------------------------------------------------
select
  case
    when pr.action in ('keep', 'pin', 'sleep', 'complete') then pr.action
    when pr.action is null then 'null'
    else 'other'
  end                                                               as action_bucket,
  count(*)                                                        as review_rows,
  count(distinct pr.user_id)                                      as accounts,
  count(*) filter (where ug.id is null)                           as reviews_whose_library_row_is_gone,
  count(*) filter (
    where pr.action = 'complete'
      and not exists (
        select 1
        from public.completion_events ce
        where ce.user_id = pr.user_id
          and ce.game_id = pr.game_id
          and ce.undone_at is null
      )
  )                                                               as completions_with_no_matching_event
from public.purge_reviews pr
left join public.user_games ug on ug.id = pr.game_id
group by 1
order by count(*) desc;


-- ----------------------------------------------------------------------------
-- PX-d  public.collections.kind, and smart public.collections with no rules.
-- v2 requires collection_kind in ('custom','smart') (M1:346) AND that a smart
-- collection have non-null rules (M1:355), which legacy does not enforce.
-- rules is bounded to 16384 bytes (M1:357).
--
-- JSON KEYS ONLY where structure is inspected. No rule VALUE is returned.
-- ----------------------------------------------------------------------------
select
  case
    when kind in ('custom', 'smart') then kind
    when kind is null then 'null'
    else 'other'
  end                                                            as kind_bucket,
  count(*)                                                       as collection_rows,
  count(*) filter (where kind not in ('custom', 'smart'))         as outside_v2_domain,
  count(*) filter (where rules = '{}'::jsonb)                     as empty_rules_object,
  count(*) filter (where jsonb_typeof(rules) <> 'object')         as rules_not_an_object,
  count(*) filter (where kind = 'smart' and rules = '{}'::jsonb)  as smart_with_empty_rules,
  count(*) filter (where pg_column_size(rules) > 16384)           as rules_over_v2_size_bound,
  max(pg_column_size(rules))                                      as max_rules_bytes
from public.collections
group by 1
order by count(*) desc;


-- ----------------------------------------------------------------------------
-- PX-e  public.user_game_pins slot, scope, and the v2 uniqueness v1 lacks.
-- v2: slot BETWEEN 1 AND 3 (M1:376); scope in library|wishlist|family|all
-- (M1:375); unique (account_id, scope, game_id) (M1:382), which legacy does not
-- enforce, so the same game pinned to two slots in one scope is a conflict.
-- ----------------------------------------------------------------------------
select
  case
    when scope in ('library', 'wishlist', 'family', 'all') then scope
    when scope is null then 'null'
    else 'other'
  end                                                          as scope_bucket,
  count(*)                                                     as pins,
  count(*) filter (where scope not in ('library','wishlist','family','all'))
                                                               as scope_outside_v2_domain,
  count(*) filter (where slot < 1 or slot > 3)                 as slot_outside_v2_range,
  count(*) filter (where hours_at_pin is null)                 as baseline_null
from public.user_game_pins
group by 1
order by count(*) desc;

-- PX-e-2  Duplicate (account, scope, game) triples, which v2 forbids.
select
  count(*)                                              as duplicate_triples,
  coalesce(sum(pins - 1), 0)                            as pin_rows_that_cannot_load
from (
  select user_id, scope, game_id, count(*) as pins
  from public.user_game_pins
  group by user_id, scope, game_id
  having count(*) > 1
) d;


-- ----------------------------------------------------------------------------
-- PX-f  Vault event vocabularies.
-- No v2 relation exists for draws or events (readiness 3), so before any target
-- constraint is written we must know what values the source really holds -- a
-- constraint written from assumption would reject real rows at load time.
-- ----------------------------------------------------------------------------
select 'vault_draw_events.event_type' as column_ref,
       case
         when event_type in (
           'opened_on_steam', 'pinned', 'unpinned', 'drew_again',
           'hidden_for_session', 'snoozed_7_days', 'snoozed_30_days',
           'slept', 'marked_completed', 'restored', 'liked', 'disliked',
           'reroll_too_long', 'reroll_wrong_mood', 'reroll_played_enough',
           'reroll_not_interested', 'reroll_not_tonight'
         ) then event_type
         when event_type is null then 'null'
         else 'other'
       end                            as value_bucket,
       count(*)                       as rows
from public.vault_draw_events
group by 1, 2
union all
select 'vault_events.action',
       case
         when action in ('drawn', 'pinned', 'unpinned', 'snoozed', 'unsnoozed')
           then action
         when action is null then 'null'
         else 'other'
       end,
       count(*)
from public.vault_events
group by 1, 2, action
order by column_ref, rows desc;

-- PX-f-2  Draw filter-context vocabularies. These are the keys the recommender
-- warm-start aggregates are dimensioned by (public.user_genre_preferences.context_mood
-- and public.genre_preference_globals.context_mood), so retiring draws would orphan them.
select 'session' as facet,
       case
         when session in ('short', 'evening', 'weekend') then session
         when session is null then 'null'
         else 'other'
       end as value_bucket,
       count(*) as draws
from public.vault_draws group by 1, 2
union all
select 'mood',
       case
         when mood in ('brain-off', 'chill', 'intense') then mood
         when mood is null then 'null'
         else 'other'
       end,
       count(*) from public.vault_draws group by 1, 2
union all
select 'goal',
       case
         when goal in ('new', 'finish', 'surprise') then goal
         when goal is null then 'null'
         else 'other'
       end,
       count(*) from public.vault_draws group by 1, 2
order by facet, draws desc;

-- PX-f-3  Draw volume and shape, which sizes decisions D-VLT-2 to D-VLT-5.
select
  count(*)                                                  as draws,
  count(distinct user_id)                                   as accounts,
  min(drawn_at)                                             as earliest,
  max(drawn_at)                                             as latest,
  count(*) filter (where collection_id is not null)         as collection_scoped_draws,
  count(*) filter (where finalist_appids is null)           as draws_without_finalists,
  max(cardinality(finalist_appids))                         as max_finalists,
  max(cardinality(selected_genres))                         as max_selected_genres,
  max(reroll_index)                                         as max_reroll_index,
  (select count(*) from public.vault_draw_events)                  as draw_event_rows,
  (select count(*) from public.vault_events)                       as vault_event_rows
from public.vault_draws;


-- ----------------------------------------------------------------------------
-- PX-g  JSON document shape for unaudited documents.
--
-- The output reports only aggregate shape and key-count bounds. It never emits
-- a JSON key or value, so a document cannot disclose an identifier through the
-- probe result.
--
-- If a key name itself looks identifying, that is a finding to report, not a
-- reason to then read the value.
-- ----------------------------------------------------------------------------
select 'feedback_submissions.client_context' as column_ref,
       count(*)                              as documents,
       count(*) filter (where client_context is null) as null_documents,
       count(*) filter (where jsonb_typeof(client_context) = 'object') as object_documents,
       count(*) filter (where jsonb_typeof(client_context) = 'array') as array_documents,
       count(*) filter (
         where client_context is not null
           and jsonb_typeof(client_context) not in ('object', 'array')
       ) as scalar_documents,
       max(case when jsonb_typeof(client_context) = 'object'
                then (select count(*) from jsonb_object_keys(client_context))
                else 0 end) as max_object_keys,
       coalesce(sum(case when jsonb_typeof(client_context) = 'object'
                         then (select count(*) from jsonb_object_keys(client_context))
                         else 0 end), 0)
         as total_object_keys
from public.feedback_submissions
union all
select 'vault_events.context',
       count(*),
       count(*) filter (where context is null),
       count(*) filter (where jsonb_typeof(context) = 'object'),
       count(*) filter (where jsonb_typeof(context) = 'array'),
       count(*) filter (
         where context is not null
           and jsonb_typeof(context) not in ('object', 'array')
       ),
       max(case when jsonb_typeof(context) = 'object'
                then (select count(*) from jsonb_object_keys(context))
                else 0 end),
       coalesce(sum(case when jsonb_typeof(context) = 'object'
                         then (select count(*) from jsonb_object_keys(context))
                         else 0 end), 0)
from public.vault_events
order by column_ref;

-- PX-g-2  Size and shape of every jsonb column we may have to carry, so the
-- exporter's memory bounds and v2's pg_column_size checks can be planned.
-- readiness 8.5: all of these are hashed AS TEXT and never re-serialised.
select 'catalog_games.tags'                    as column_ref,
       count(*)                                as rows,
       count(*) filter (where jsonb_typeof(tags) <> 'array')      as not_an_array,
       max(pg_column_size(tags))               as max_bytes,
       sum(pg_column_size(tags))               as total_bytes
from public.catalog_games
union all
select 'collections.rules', count(*),
       count(*) filter (where jsonb_typeof(rules) <> 'object'),
       max(pg_column_size(rules)), sum(pg_column_size(rules))
from public.collections
union all
select 'game_duration_estimates.evidence', count(*), 0,
       max(pg_column_size(evidence)), sum(pg_column_size(evidence))
from public.game_duration_estimates
union all
select 'catalog_ingest_queue.source_payload', count(*), 0,
       max(pg_column_size(source_payload)), sum(pg_column_size(source_payload))
from public.catalog_ingest_queue
union all
select 'catalog_duration_import_runs.manifest', count(*), 0,
       max(pg_column_size(manifest)), sum(pg_column_size(manifest))
from public.catalog_duration_import_runs
union all
select 'metadata_worker_runs.counts', count(*), 0,
       max(pg_column_size(counts)), sum(pg_column_size(counts))
from public.metadata_worker_runs
union all
select 'metadata_worker_runs.summary', count(*), 0,
       max(pg_column_size(summary)), sum(pg_column_size(summary))
from public.metadata_worker_runs
union all
-- public.steam_import_jobs.games is NEVER migrated (readiness 7, plan section 13).
-- Its size is measured only to prove how much the exporter avoids carrying.
select 'steam_import_jobs.games [NOT MIGRATED]', count(*), 0,
       max(pg_column_size(games)), sum(pg_column_size(games))
from public.steam_import_jobs
order by column_ref;


-- ----------------------------------------------------------------------------
-- PX-h  Smallint code distributions on the support relations.
-- Same discipline as P08: these frequencies size the problem; the MEANING must
-- come from a definition (P08a/P08b), never from ordering or frequency.
--
-- No message, subject, email or dedupe hash is returned.
-- ----------------------------------------------------------------------------
select 'contact_messages.enquiry_type' as column_ref,
       case
         when enquiry_type between 0 and 5 then enquiry_type::text
         when enquiry_type is null then 'null'
         else 'other'
       end                              as code_bucket,
       count(*)                        as rows
from public.contact_messages group by 1, 2
union all
select 'contact_messages.status',
       case
         when status between 0 and 2 then status::text
         when status is null then 'null'
         else 'other'
       end,
       count(*)
from public.contact_messages group by 1, 2
union all
select 'feedback_submissions.feedback_type',
       case
         when feedback_type in (0, 1) then feedback_type::text
         when feedback_type is null then 'null'
         else 'other'
       end,
       count(*)
from public.feedback_submissions group by 1, 2
union all
select 'feedback_submissions.status',
       case
         when status between 0 and 2 then status::text
         when status is null then 'null'
         else 'other'
       end,
       count(*)
from public.feedback_submissions group by 1, 2
order by column_ref, rows desc;

-- PX-h-2  Support-record volume, consent and account linkage, which size
-- decisions D-SUP-1 to D-SUP-4. Counts only.
select
  (select count(*) from public.contact_messages)                              as contact_rows,
  (select count(*) from public.contact_messages where user_id is null)        as contact_rows_without_account,
  (select min(created_at) from public.contact_messages)                       as earliest_contact,
  (select max(created_at) from public.contact_messages)                       as latest_contact,
  (select count(*) from public.feedback_submissions)                          as feedback_rows,
  (select count(*) from public.feedback_submissions where user_id is null)    as feedback_rows_without_account,
  -- D-SUP-4: a contact_email present while consent is FALSE is precisely the
  -- pair that must never be separated by the migration.
  (select count(*) from public.feedback_submissions where contact_allowed)    as feedback_with_consent,
  (select count(*) from public.feedback_submissions
    where contact_email is not null and not contact_allowed)           as email_present_without_consent,
  (select count(*) from public.feedback_submissions
    where contact_email is null and contact_allowed)                   as consent_without_email;


-- ----------------------------------------------------------------------------
-- PX-i  Merge tombstones: source accounts that no longer exist.
--
-- Covered numerically by P07k-2. This adds the shape of what a tombstone
-- account row would have to look like under decision D-MRG-1, so the coordinator
-- can judge the proposal. Counts only; no account identifier is returned.
-- ----------------------------------------------------------------------------
select
  count(*)                                                    as merge_rows,
  count(*) filter (where a.id is null)                        as tombstones_required,
  count(distinct m.target_account_id) filter (where a.id is null)
                                                              as distinct_targets_affected,
  min(m.created_at) filter (where a.id is null)               as earliest_orphaned_merge,
  max(m.created_at) filter (where a.id is null)               as latest_orphaned_merge,
  -- Does any surviving row still reference the deleted source? If not, the
  -- tombstone is purely an audit anchor and can be minimal.
  count(*) filter (
    where a.id is null
      and exists (select 1 from public.user_games ug where ug.user_id = m.source_account_id)
  )                                                           as deleted_sources_still_holding_library_rows
from public.account_merges m
left join public.app_accounts a on a.id = m.source_account_id;


-- ----------------------------------------------------------------------------
-- PX-j  Playtime snapshot shape.        readiness 8.6
-- total_minutes is a RUNNING CUMULATIVE TOTAL, differenced at
-- lib/playtime-summary.ts:32 to produce the daily gain. This probe confirms the
-- cumulative invariant HOLDS in the data before the M3 contract asserts it: a
-- snapshot that DECREASES day over day would mean the invariant is already
-- broken and copying verbatim would carry the break forward.
-- ----------------------------------------------------------------------------
with ordered as (
  select
    user_id,
    captured_on,
    total_minutes,
    games_with_playtime,
    lag(total_minutes) over (partition by user_id order by captured_on) as prev_minutes
  from public.user_playtime_snapshots
)
select
  count(*)                                                    as snapshot_rows,
  count(distinct user_id)                                     as accounts,
  min(captured_on)                                            as earliest_day,
  max(captured_on)                                            as latest_day,
  count(*) filter (where prev_minutes is not null
                     and total_minutes < prev_minutes)        as days_where_total_DECREASED,
  count(*) filter (where prev_minutes is not null
                     and total_minutes = prev_minutes)        as days_with_no_change,
  count(*) filter (where total_minutes < 0)                   as negative_totals,
  count(*) filter (where games_with_playtime < 0)             as negative_game_counts,
  max(total_minutes)                                          as largest_cumulative_total
from ordered;
