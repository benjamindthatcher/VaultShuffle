-- Replace the retired timed Sleep state with a permanent Blacklist flag.
-- PREPARED LOCALLY, NOT APPLIED. M1, M2, M3 and the preservation follow-up
-- are immutable. This migration is intentionally destructive only to the
-- obsolete Sleep timestamps/history the 12 September product decision retired.

begin;

alter table app.game_state
  add column blacklisted boolean not null default false;

-- A timestamp never creates Blacklist membership by itself. The loader derives
-- membership from the frozen legacy status = 'Slept'. Fail rather than infer if
-- an older loader has already populated Sleep state in this target.
do $$
begin
  if exists (select 1 from app.game_state where slept_at is not null) then
    raise exception
      'blacklist migration requires a reload from authoritative legacy status; slept_at is not membership evidence';
  end if;
end
$$;

alter table app.game_state drop constraint game_state_check;
alter table app.game_state
  drop column slept_at,
  drop column restored_at,
  drop column restored_from_slept_at,
  drop column restored_from_previous_active_status;

alter table app.game_state
  add constraint game_state_check check (
    completed_at is not null or blacklisted or previous_active_status is not null or
    manual_progress is not null or notes is not null or review_requested_at is not null or
    completion_dismissed_at is not null
  );

comment on column app.game_state.blacklisted is
  'Permanent manual exclusion from the active library and Vault pool. No time '
  'is recorded and no automatic expiry exists; only an explicit Reactivate '
  'sets this false.';

-- Retire the stale child timestamp everywhere. Rows for which raw_slept_at was
-- the only promoted datum no longer carry a user-valued fact and are removed.
delete from app.game_state_legacy_measurements
where raw_slept_at is not null
  and raw_completed_at is null
  and raw_prev_active_status is null
  and raw_dismissed_at is null
  and raw_dismissed_playtime is null
  and raw_review_requested_at is null
  and raw_last_played_at is null
  and raw_last_observed_at is null
  and raw_recency_code is null
  and raw_recency_evidence_at is null
  and raw_family_owner_steam_id is null
  and raw_family_verified_at is null;

alter table app.game_state_legacy_measurements
  drop constraint game_state_legacy_measurements_check;
alter table app.game_state_legacy_measurements
  drop column raw_slept_at;
alter table app.game_state_legacy_measurements
  add constraint game_state_legacy_measurements_check check (
    raw_completed_at is not null
    or raw_prev_active_status is not null
    or raw_dismissed_at is not null
    or raw_dismissed_playtime is not null
    or raw_review_requested_at is not null
    or raw_last_played_at is not null
    or raw_last_observed_at is not null
    or raw_recency_code is not null
    or raw_recency_evidence_at is not null
    or raw_family_owner_steam_id is not null
    or raw_family_verified_at is not null
  );

alter table migration.legacy_user_game_state_audit
  drop column raw_slept_at;

-- Existing purge decisions keep their meaning under the current vocabulary.
alter table app.purge_review_history
  drop constraint purge_review_history_action_check;
update app.purge_review_history set action = 'blacklist' where action = 'sleep';
alter table app.purge_review_history
  add constraint purge_review_history_action_check
  check (action in ('keep', 'pin', 'blacklist', 'complete'));

alter table migration.legacy_purge_review_archive
  drop constraint legacy_purge_review_archive_action_check;
update migration.legacy_purge_review_archive set action = 'blacklist' where action = 'sleep';
alter table migration.legacy_purge_review_archive
  add constraint legacy_purge_review_archive_action_check
  check (action in ('keep', 'pin', 'blacklist', 'complete'));

update app.vault_draw_events set event_type = 'blacklisted' where event_type = 'slept';
update app.vault_events set action = 'blacklisted' where action = 'slept';

-- Preserve tuned operator values while changing only the two retired keys.
do $$
begin
  if exists (
    select 1 from reco.operator_weight_versions old_weight
    join reco.operator_weight_versions new_weight
      on new_weight.config_version = old_weight.config_version
     and new_weight.weight_key = case old_weight.weight_key
       when 'event:slept' then 'event:blacklisted'
       when 'decision:sleep' then 'decision:blacklist'
     end
    where old_weight.weight_key in ('event:slept', 'decision:sleep')
  ) then
    raise exception 'blacklist operator-weight key collision';
  end if;
end
$$;

update reco.operator_weight_versions
set weight_key = case weight_key
  when 'event:slept' then 'event:blacklisted'
  when 'decision:sleep' then 'decision:blacklist'
end
where weight_key in ('event:slept', 'decision:sleep');

-- The existing sparse row remains the state boundary. This SECURITY INVOKER
-- function uses the session-derived tenant and never accepts an account id.
create or replace function app.set_game_blacklisted(
  p_game_id integer,
  p_blacklisted boolean
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account_id integer := app.current_account_id();
begin
  if p_game_id is null or p_blacklisted is null then
    raise exception 'INVALID_BLACKLIST_CHANGE';
  end if;
  if v_account_id is null then
    raise exception 'ACCOUNT_CONTEXT_REQUIRED';
  end if;

  perform pg_advisory_xact_lock(v_account_id, p_game_id);
  perform 1
  from app.library_games
  where account_id = v_account_id and game_id = p_game_id
  for update;
  if not found then
    raise exception 'GAME_NOT_FOUND';
  end if;

  if p_blacklisted then
    insert into app.game_state (
      account_id, game_id, completed_at, blacklisted, revision, updated_at
    ) values (
      v_account_id, p_game_id, null, true, 1, statement_timestamp()
    )
    on conflict (account_id, game_id) do update
    set completed_at = null,
        blacklisted = true,
        revision = app.game_state.revision + 1,
        updated_at = statement_timestamp()
    where app.game_state.completed_at is not null
       or app.game_state.blacklisted is distinct from true;
  else
    -- Remove a flag-only sparse row in one statement; setting false first
    -- would transiently violate game_state_check. Rows with other authored
    -- state survive and lose only Blacklist membership/terminal fallback.
    delete from app.game_state
    where account_id = v_account_id
      and game_id = p_game_id
      and blacklisted
      and completed_at is null
      and manual_progress is null
      and notes is null
      and review_requested_at is null
      and completion_dismissed_at is null;

    update app.game_state
    set blacklisted = false,
        previous_active_status = null,
        revision = revision + 1,
        updated_at = statement_timestamp()
    where account_id = v_account_id
      and game_id = p_game_id
      and blacklisted;

  end if;

  return true;
end
$$;

revoke all on function app.set_game_blacklisted(integer, boolean) from public;
do $$
begin
  if to_regrole('anon') is not null then
    execute 'revoke all on function app.set_game_blacklisted(integer, boolean) from anon';
  end if;
  if to_regrole('authenticated') is not null then
    execute 'revoke all on function app.set_game_blacklisted(integer, boolean) from authenticated';
  end if;
end
$$;
grant execute on function app.set_game_blacklisted(integer, boolean) to vault_app;

commit;
