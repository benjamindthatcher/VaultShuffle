-- ============================================================================
-- M3 source probes P07  --  readiness section 10 item 7, plus sections 4 and 14
-- COUNT-ONLY. Read-only. NOT RUN in this batch; proposed for coordinator review.
--
-- IMPORTANT: everything these probes test is currently a POTENTIAL conflict,
-- inferred from schema metadata and the frozen migrations. NOTHING HAS BEEN
-- MEASURED. A zero result here retires a conflict; a non-zero result promotes
-- it from potential to measured, with a number attached.
--
-- No raw rows. No display names, notes, emails, digests or Steam IDs are
-- returned -- only counts of rows that would fail a v2 constraint.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- P07a  Collection ordering.        readiness 4.9
-- Legacy: PRIMARY KEY (collection_id, game_id), CHECK (position >= 0), and NO
-- uniqueness on position. v2 adds unique (account_id, collection_id, position)
-- at M1:368. Duplicates and gaps both need a deterministic, RECORDED renumbering.
-- ----------------------------------------------------------------------------
with per_collection as (
  select
    collection_id,
    count(*)                      as members,
    count(distinct position)      as distinct_positions,
    min(position)                 as min_position,
    max(position)                 as max_position
  from public.collection_games
  group by collection_id
)
select
  count(*)                                                       as collections_with_members,
  count(*) filter (where members <> distinct_positions)          as collections_with_duplicate_positions,
  count(*) filter (where min_position <> 0)                      as collections_not_starting_at_zero,
  count(*) filter (where max_position <> members - 1)            as collections_with_gaps_or_overshoot,
  count(*) filter (
    where members = distinct_positions
      and min_position = 0
      and max_position = members - 1
  )                                                              as collections_already_dense,
  sum(members) filter (where members <> distinct_positions)      as rows_in_duplicate_collections
from per_collection;


-- ----------------------------------------------------------------------------
-- P07b  Snooze ordering.  readiness 4.10, and readiness 14.6 for the ordering.
-- v2 app.snoozes adds check (until_at is null or until_at >= snoozed_at), M1:393.
-- The source enforces no such ordering.
-- ----------------------------------------------------------------------------
select
  count(*)                                                        as snooze_rows,
  count(*) filter (where snoozed_until is null)                   as open_ended_snoozes,
  count(*) filter (where snoozed_until < snoozed_at)              as until_before_snoozed_conflicts,
  count(*) filter (where snoozed_until = snoozed_at)              as zero_length_snoozes,
  min(snoozed_until - snoozed_at) filter (where snoozed_until < snoozed_at)
                                                                  as worst_negative_interval
from public.user_game_snoozes;


-- ----------------------------------------------------------------------------
-- P07c  Family member cap.  readiness 4.7, and readiness 14.7 for the trigger.
-- v2 enforces at most five members per account with the `family_member_limit`
-- TRIGGER (M1:538, M1:546-548), not a table constraint. A trigger fires PER ROW
-- during the load, so an over-cap account fails MID-TRANSACTION rather than at
-- validation time. This must be pre-checked, not discovered during the load.
-- ----------------------------------------------------------------------------
with per_account as (
  select user_id, count(*) as members
  from public.user_family_members
  group by user_id
)
select
  count(*)                                        as accounts_with_family,
  count(*) filter (where members > 5)             as accounts_over_the_five_member_cap,
  sum(members) filter (where members > 5)         as member_rows_in_over_cap_accounts,
  sum(greatest(members - 5, 0))                   as member_rows_that_cannot_load,
  max(members)                                    as largest_family
from per_account;


-- ----------------------------------------------------------------------------
-- P07d  Family member array and count caps.   readiness 4.7
-- v2: candidate_count BETWEEN 0 AND 10000 (M1:324); candidate_app_ids at most
-- 10000 entries (M1:326) and 262144 bytes (M1:327). Legacy bounds neither.
--
-- Also tests the SEMANTIC question flagged in the manifest: legacy library_seen
-- is the lender's observed library SIZE, while v2 candidate_count reads as the
-- count of candidate ids. If they routinely differ, mapping one to the other is
-- a MISMAPPING, not a narrowing.
-- ----------------------------------------------------------------------------
select
  count(*)                                                                as member_rows,
  count(*) filter (where library_seen > 10000)                            as library_seen_over_cap,
  count(*) filter (where cardinality(candidate_appids) > 10000)           as candidate_array_over_cap,
  count(*) filter (where pg_column_size(candidate_appids) > 262144)       as candidate_array_over_bytes,
  count(*) filter (where library_seen <> cardinality(candidate_appids))   as library_seen_differs_from_array_length,
  max(library_seen)                                                       as max_library_seen,
  max(cardinality(candidate_appids))                                      as max_candidate_count,
  max(pg_column_size(candidate_appids))                                   as max_candidate_bytes,
  -- v2 requires steam_id > 0 as a bigint (M1:318). A text value that will not
  -- convert is a hard conflict.
  count(*) filter (where steam_id !~ '^[0-9]{1,19}$')                     as steam_id_not_bigint_shaped,
  -- Every appid must fit catalog.games' 1..4294967295 bound (M1:170-171).
  count(*) filter (
    where exists (
      select 1 from unnest(candidate_appids) as a(appid)
      where a.appid < 1 or a.appid > 4294967295
    )
  )                                                                       as members_with_out_of_range_appid
from public.user_family_members;


-- ----------------------------------------------------------------------------
-- P07e  Family access without a member row.   readiness 4.8
-- Legacy public.user_games.family_owner_steam_id is plain text with NO foreign key.
-- v2 app.family_game_access (M1:331) requires a composite FK to
-- app.family_members(account_id, id). A family row whose lender row has since
-- been removed CANNOT be represented as family access, and the coordinator
-- ruling forbids fabricating a member to make it fit.
-- ----------------------------------------------------------------------------
select
  count(*) filter (where ug.family_owner_steam_id is not null)     as family_access_rows,
  count(*) filter (
    where ug.family_owner_steam_id is not null and m.id is null
  )                                                               as family_rows_with_no_member,
  count(distinct ug.user_id) filter (
    where ug.family_owner_steam_id is not null and m.id is null
  )                                                               as accounts_affected,
  count(*) filter (
    where ug.family_owner_steam_id is not null and ug.family_verified_at is not null
  )                                                               as family_rows_verified,
  count(*) filter (
    where ug.family_owner_steam_id is null and ug.access_source <> 'owned'
  )                                                               as non_owned_rows_without_a_lender
from public.user_games ug
left join public.user_family_members m
  on m.user_id  = ug.user_id
 and m.steam_id = ug.family_owner_steam_id;


-- ----------------------------------------------------------------------------
-- P07f  Visibility disagreement between public.app_accounts and public.app_users.
-- (Added by this batch; not in readiness 10.7.)
-- v2 has ONE destination, app.account_capabilities, keyed by account. Legacy
-- stores the same triple twice. Precedence is settled by
-- docs/v2-m3-capability-decision.md: the ACCOUNT-side tuple is authoritative as
-- a tuple, and this probe re-measures the disagreement rather than assuming it.
-- Neither false nor NULL may become 'hidden'. readiness 8.3 guarded NULL only;
-- lib/steam-owned-games.ts:117 shows false is an availability heuristic (an
-- unplayed but fully visible library yields false), so both project to
-- 'unknown'. This probe counts disagreement only; it decides nothing.
-- ----------------------------------------------------------------------------
select
  count(*)                                                                as accounts_with_both_rows,
  count(*) filter (where a.steam_library_visible    is distinct from u.steam_library_visible)
                                                                          as library_visible_differs,
  count(*) filter (where a.steam_playtime_visible   is distinct from u.steam_playtime_visible)
                                                                          as playtime_visible_differs,
  count(*) filter (where a.steam_last_played_visible is distinct from u.steam_last_played_visible)
                                                                          as last_played_visible_differs,
  count(*) filter (where a.steam_visibility_checked_at is distinct from u.steam_visibility_checked_at)
                                                                          as checked_at_differs,
  count(*) filter (where a.steam_games_seen         is distinct from u.steam_games_seen)
                                                                          as games_seen_differs,
  -- A disagreement where one side is NULL is the dangerous kind: picking the
  -- wrong side turns "unknown" into a definite answer.
  count(*) filter (
    where (a.steam_library_visible is null) <> (u.steam_library_visible is null)
  )                                                                       as library_visible_null_mismatch,
  count(*) filter (where a.last_visited_at is distinct from u.last_login_at)
                                                                          as visit_and_login_differ
from public.app_accounts a
join public.app_users u on u.id = a.id;


-- ----------------------------------------------------------------------------
-- P07g  Completion events: unresolvable targets and origin surfaces.
--   readiness 4.1 (source domain), readiness 4.2 (required game_id FK),
--   readiness 14.6 (undone_at ordering).
-- v2 requires game_id integer NOT NULL references catalog.games(id) (M1:408),
-- while legacy game_id is NULLABLE with NO foreign key and steam_appid is
-- nullable too. The legacy source enum is the six values recorded in the
-- inventory; the migration preserves that origin surface in a separate field.
-- ----------------------------------------------------------------------------
select
  count(*)                                                              as completion_event_rows,
  count(*) filter (where ce.game_id is null and ce.steam_appid is null) as unresolvable_no_target_at_all,
  count(*) filter (where ce.game_id is null and ce.steam_appid is not null)
                                                                        as resolvable_only_by_appid,
  count(*) filter (where ce.game_id is not null and ug.id is null)      as game_id_points_at_deleted_library_row,
  count(*) filter (
    where ce.game_id is not null and ug.id is null and ce.steam_appid is null
  )                                                                     as unmigratable_after_fallback,
  count(*) filter (where ce.steam_appid is not null and cg.steam_appid is null)
                                                                        as appid_not_in_catalogue,
  -- readiness 14.6: v2 requires undone_at >= occurred_at (M1:414).
  count(*) filter (where ce.undone_at < ce.claimed_at)                  as undone_before_claimed_conflicts,
  count(*) filter (where ce.undone_at is not null)                      as undone_events
from public.completion_events ce
left join public.user_games    ug on ug.id = ce.game_id
left join public.catalog_games cg on cg.steam_appid = ce.steam_appid;

-- P07g-2  The origin-surface distribution. Values are reduced to the fixed
-- inventory enum plus null/other before grouping, so a future unexpected value
-- cannot be printed as freeform text.
select
  case
    when source in ('sweep', 'sweep_bulk', 'library', 'vault', 'purge', 'details')
      then source
    when source is null then 'null'
    else 'other'
  end                                             as source_bucket,
  count(*)                                        as events,
  count(*) filter (where undone_at is not null)   as undone,
  count(*) filter (where game_id is null)         as null_game_id,
  count(*) filter (where steam_appid is null)     as null_steam_appid,
  min(claimed_at)                                 as earliest,
  max(claimed_at)                                 as latest
from public.completion_events
group by 1
order by count(*) desc;


-- ----------------------------------------------------------------------------
-- P07h  Text length and shape checks against v2 bounds.
-- v2 bounds: display_name btrim 1..80 (M1:111-112), avatar_url <= 2048
-- (M1:114), profile_url <= 2048 (M1:115), collection name btrim 1..200
-- (M1:347), description <= 2000 (M1:348), collection note <= 10000 (M1:366),
-- game_state.notes btrim 1..10000 (M1:245), catalog title btrim 1..500 (M1:172).
--
-- COUNTS ONLY. No name, note or URL is returned. Nonempty text must never be
-- truncated to fit; an over-length row is a reported conflict.
-- ----------------------------------------------------------------------------
select 'app_users.display_name' as column_ref,
       count(*)                                                          as rows_total,
       count(*) filter (where display_name is null)                      as null_rows,
       count(*) filter (where display_name is not null
                          and length(btrim(display_name)) = 0)           as blank_rows,
       count(*) filter (where length(btrim(display_name)) > 80)          as over_length_conflicts
from public.app_users
union all
select 'manual_steam_profiles.display_name',
       count(*), 0,
       count(*) filter (where length(btrim(display_name)) = 0),
       count(*) filter (where length(btrim(display_name)) > 80)
from public.manual_steam_profiles
union all
select 'manual_steam_profiles.steam_display_name',
       count(*), 0,
       count(*) filter (where length(btrim(steam_display_name)) = 0),
       count(*) filter (where length(btrim(steam_display_name)) > 80)
from public.manual_steam_profiles
union all
select 'manual_steam_profiles.steam_profile_url',
       count(*), 0, 0,
       count(*) filter (where length(steam_profile_url) > 2048)
from public.manual_steam_profiles
union all
select 'user_family_members.display_name',
       count(*), 0,
       count(*) filter (where length(btrim(display_name)) = 0),
       count(*) filter (where length(btrim(display_name)) > 80)
from public.user_family_members
union all
select 'collections.name',
       count(*), 0,
       count(*) filter (where length(btrim(name)) = 0),
       count(*) filter (where length(btrim(name)) > 200)
from public.collections
union all
select 'collections.description',
       count(*),
       count(*) filter (where description is null), 0,
       count(*) filter (where length(description) > 2000)
from public.collections
union all
select 'collection_games.notes',
       count(*),
       count(*) filter (where notes is null),
       count(*) filter (where notes is not null and length(btrim(notes)) = 0),
       count(*) filter (where length(notes) > 10000)
from public.collection_games
union all
select 'catalog_games.name',
       count(*), 0,
       count(*) filter (where length(btrim(name)) = 0),
       count(*) filter (where length(btrim(name)) > 500)
from public.catalog_games
union all
select 'catalog_games.normalized_name',
       count(*), 0,
       count(*) filter (where length(normalized_name) = 0),
       count(*) filter (where length(normalized_name) > 500)
from public.catalog_games;

-- P07h-2  public.user_games.notes.       readiness 4.11
-- Legacy text NOT NULL, may be ''. v2 requires btrim length 1..10000 (M1:245),
-- and app.game_state carries a disjunction check (M1:254-259) so a row whose
-- ONLY content was a blank note must be SUPPRESSED, not inserted empty.
select
  count(*)                                                     as library_rows,
  count(*) filter (where length(btrim(notes)) = 0)             as blank_notes_normalise_to_null,
  count(*) filter (where length(btrim(notes)) > 0)             as nonempty_notes,
  count(*) filter (where length(btrim(notes)) > 10000)         as over_length_note_conflicts,
  -- Rows that would produce an EMPTY app.game_state and must be suppressed.
  count(*) filter (
    where length(btrim(notes)) = 0
      and completed_at is null
      and slept_at is null
      and previous_active_status is null
      and review_requested_at is null
      and completion_suggestion_dismissed_at is null
      and completion_suggestion_dismissed_playtime is null
  )                                                            as state_rows_to_suppress
from public.user_games;


-- ----------------------------------------------------------------------------
-- P07i  Session digest shape.      readiness 8.7
-- public.manual_profile_sessions has CHECK (token_hash ~ '^[0-9a-f]{64}$').
-- `public.sessions` has ONLY a UNIQUE constraint, so malformed or uppercase digests
-- are possible THERE AND ONLY THERE. v2 requires octet_length(digest) = 32
-- (M1:132), which a 64-char lowercase hex string decodes to exactly.
--
-- PRIVATE VALUES. Counts only. No digest is ever returned, grouped by, or
-- written to any report.
-- ----------------------------------------------------------------------------
select
  count(*)                                                        as session_rows,
  count(*) filter (where token_hash is null
                     or token_hash !~ '^[0-9a-f]{64}$')            as digests_failing_v2_shape,
  count(*) filter (where token_hash ~ '^[0-9A-F]{64}$'
                     and token_hash !~ '^[0-9a-f]{64}$')          as uppercase_digests,
  count(*) filter (where token_hash is null or length(token_hash) <> 64)
                                                                    as wrong_length_digests,
  count(*) filter (where expires_at <= created_at)                as expiry_ordering_conflicts,
  count(*) filter (where expires_at > now())                      as unexpired_sessions
from public.sessions;

-- P07j  Cross-table digest collision.
-- v2 has ONE global unique digest across both session kinds (M1:132); legacy has
-- two INDEPENDENT unique constraints, so a collision is possible in principle.
-- Returns a COUNT of colliding digests, never a digest.
select count(*) as colliding_digests_across_session_tables
from (
  select decode(lower(token_hash), 'hex') as token_digest
  from public.sessions
  where token_hash ~ '^[0-9A-Fa-f]{64}$'
  intersect
  select decode(lower(token_hash), 'hex')
  from public.manual_profile_sessions
  where token_hash ~ '^[0-9A-Fa-f]{64}$'
) as collisions;

-- P07j-2  Manual session shape, for completeness. The CHECK should make this
-- zero; a non-zero result would mean the constraint is not what the inventory says.
select
  count(*)                                                    as manual_session_rows,
  count(*) filter (where token_hash is null
                     or token_hash !~ '^[0-9a-f]{64}$')        as digests_failing_shape,
  count(*) filter (where expires_at > now())                  as unexpired_manual_sessions,
  count(*) filter (where expires_at <= created_at)            as expiry_ordering_conflicts
from public.manual_profile_sessions;


-- ----------------------------------------------------------------------------
-- P07k  Ordering conflicts the source does not enforce.   readiness 14.6
-- Consolidated with P07b and P07g above; this covers the remaining pairs.
-- ----------------------------------------------------------------------------
select
  count(*)                                                                     as library_rows,
  -- readiness 10.7: status says Completed or Slept but the timestamp is null.
  count(*) filter (where status = 'Completed' and completed_at is null)         as completed_status_without_timestamp,
  count(*) filter (where status = 'Slept'     and slept_at     is null)         as slept_status_without_timestamp,
  count(*) filter (where completed_at is not null and status <> 'Completed')    as completed_timestamp_without_status,
  count(*) filter (where slept_at     is not null and status <> 'Slept')        as slept_timestamp_without_status,
  -- Negative or impossible numerics against v2's >= 0 checks.
  count(*) filter (where hours_played < 0)                                      as negative_hours,
  count(*) filter (where observed_playtime_minutes < 0)                         as negative_minutes,
  count(*) filter (where completion_suggestion_dismissed_playtime < 0)          as negative_dismissed_playtime,
  count(*) filter (
    where completion_suggestion_dismissed_playtime is not null
      and completion_suggestion_dismissed_playtime
          <> round(completion_suggestion_dismissed_playtime)
  )                                                                             as non_integral_dismissed_playtime,
  count(*) filter (where completion_percentage < 0 or completion_percentage > 100)
                                                                                as progress_out_of_range,
  -- app.game_activity requires last_observed_minutes or last_played_at non-null (M1:273).
  count(*) filter (
    where last_played_at is null
      and last_observed_played_at is null
      and observed_playtime_minutes is null
      and recency_evidence_at is null
  )                                                                             as rows_with_no_activity_evidence
from public.user_games;

-- P07k-2  Merge audit ordering and the PX-i foreign-key blocker.  readiness 4.6
select
  count(*)                                                              as merge_rows,
  count(*) filter (where m.merge_mode = 'promoted')                     as promotions,
  count(*) filter (where m.merge_mode = 'merged_existing')              as merges_of_existing,
  -- readiness 14 correction: promotions insert (source_id, source_id) and DO
  -- satisfy v2's promote branch. This confirms it rather than assuming it.
  count(*) filter (
    where m.merge_mode = 'promoted' and m.source_account_id <> m.target_account_id
  )                                                                     as promotions_violating_v2_promote_branch,
  -- The real conflict: ops.account_merges.source_account_id (M1:459) references
  -- app.accounts(id), but the merge path DELETES the source account at
  -- 20260830151421_secure_manual_profiles.sql:708.
  count(*) filter (where a.id is null)                                  as merge_rows_with_deleted_source_account,
  count(*) filter (where m.merge_mode = 'merged_existing' and a.id is null)
                                                                        as merged_existing_rows_failing_the_fk,
  count(*) filter (where m.analytics_delivered_at is null)              as merges_never_reported_to_analytics
from public.account_merges m
left join public.app_accounts a on a.id = m.source_account_id;


-- ----------------------------------------------------------------------------
-- P07l  The misclassified non-game population.
--   readiness 4.13 (forced steam_type), readiness 14.4 (quarantine keeps types).
-- Live public.catalog_games carries CHECK (steam_type = 'game'), so EVERY row claims to
-- be a game, including the DLC and demo entries known to be stored there.
-- public.catalog_game_quarantine.steam_type is UNVALIDATED text and is the one place
-- the source retains real type information, which makes it the natural input to
-- the D-CAT-1 reclassification decision.
-- ----------------------------------------------------------------------------

-- P07l-1  What types does quarantine actually hold, and do they fit v2's
-- game_type domain (game|dlc|demo|software|video|unknown, M1:174-175)?
select
  case
    when steam_type in ('game', 'dlc', 'demo', 'software', 'video', 'unknown')
      then steam_type
    when steam_type is null then 'null'
    else 'other'
  end                                                         as steam_type_bucket,
  count(*)                                                    as quarantine_rows,
  count(*) filter (
    where steam_type not in ('game','dlc','demo','software','video','unknown')
       or steam_type is null
  )                                                           as outside_v2_game_type_domain,
  count(*) filter (where review_status = 'pending')           as pending_review
from public.catalog_game_quarantine
group by 1
order by count(*) desc;

-- P07l-2  How much of the live catalogue is quarantine-flagged, and how much of
-- that is actually IN a user's library? A misclassified row nobody owns is a
-- catalogue tidiness problem; one that is owned is a migration problem.
select
  (select count(*) from public.catalog_games)                                as catalogue_rows,
  (select count(*) from public.catalog_game_quarantine)                      as quarantine_rows,
  count(*)                                                            as quarantined_and_in_catalogue,
  count(*) filter (where q.review_status = 'pending')                 as pending_review,
  (
    select count(*)
    from public.user_games ug
    join public.catalog_game_quarantine q2 on q2.steam_appid = ug.catalog_steam_appid
  )                                                                   as library_rows_on_quarantined_apps,
  (
    select count(distinct ug.user_id)
    from public.user_games ug
    join public.catalog_game_quarantine q2 on q2.steam_appid = ug.catalog_steam_appid
  )                                                                   as accounts_holding_quarantined_apps
from public.catalog_game_quarantine q
join public.catalog_games cg on cg.steam_appid = q.steam_appid;

-- P07l-3  Catalogue value-domain checks against v2's frozen bounds.
select
  count(*)                                                                as catalogue_rows,
  count(*) filter (where steam_appid < 1 or steam_appid > 4294967295)     as appid_outside_v2_range,
  count(*) filter (where popularity_rank < 0)                             as negative_popularity_rank,
  count(*) filter (where main_story_minutes < 0
                      or main_extras_minutes < 0
                      or completionist_minutes < 0)                       as negative_duration_minutes,
  -- readiness 4.12: the displayed rating is review_positive * 10.0 / review_total,
  -- so a null or zero denominator is not merely cosmetic.
  count(*) filter (where review_total is null)                            as review_total_null,
  count(*) filter (where review_total = 0 and review_positive > 0)        as positives_with_zero_total,
  count(*) filter (where review_total is not null
                      and review_positive + review_negative <> review_total)
                                                                          as review_counts_do_not_sum,
  -- readiness 4.12 confirms the source GUARANTEES US prices structurally.
  count(*) filter (where price_currency is not null and price_currency <> 'USD')
                                                                          as non_usd_prices,
  -- readiness 4.4: the four-way Deck categorisation.
  count(*) filter (where deck_compatibility is not null)                  as deck_observations,
  count(*) filter (where duration_manual_override)                        as manual_duration_overrides
from public.catalog_games;

-- P07l-4  Deck compatibility distribution. A small integer code is a safe
-- grouping key; this is what sizes the Playable-versus-Verified loss (readiness 4.4).
select
  case
    when deck_compatibility between 0 and 3 then deck_compatibility::text
    when deck_compatibility is null then 'null'
    else 'other'
  end                                               as deck_compatibility_bucket,
  count(*)                                        as apps,
  count(*) filter (where deck_checked_at is null) as undated_observations
from public.catalog_games
group by 1, deck_compatibility
order by 1;
