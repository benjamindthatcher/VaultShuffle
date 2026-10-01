\set ON_ERROR_STOP on
\echo M3 phase ledger, map idempotence, archive privacy, and retention checks

DO $$
declare
  v_rel text;
  v_oid oid;
  v_att text;
begin
  foreach v_rel in array array[
    'migration.account_map', 'migration.game_map', 'migration.library_row_map',
    'migration.collection_map', 'migration.session_map', 'migration.runs',
    'migration.applied_steps', 'migration.relation_counts',
    'migration.conflict_report', 'migration.cutover_state',
    'migration.retention_holds', 'migration.legacy_user_game_state_audit',
    'migration.legacy_library_evidence', 'migration.legacy_family_member_evidence',
    'migration.legacy_family_access_orphans', 'migration.legacy_account_preferences_evidence',
    'migration.legacy_manual_session_audit', 'migration.legacy_auth_intent_audit',
    'migration.legacy_account_merge_audit', 'migration.legacy_purge_review_archive',
    'migration.legacy_collection_membership_evidence',
    'migration.legacy_ingest_queue_archive', 'migration.legacy_duration_job_archive',
    'migration.legacy_import_freeze_report',
    'migration.legacy_schema_migration_ledger',
    'ops.legacy_worker_runs',
    'catalog.game_sightings', 'catalog.seed_runs', 'catalog.duration_imports',
    'catalog.appid_terminal_rejections',
    'app.account_capability_evidence', 'app.library_legacy_measurements',
    'app.game_state_legacy_measurements',
    'app.purge_review_history', 'app.family_access_orphans'
  ] loop
    if to_regclass(v_rel) is null then
      raise exception 'required M3 destination % is missing', v_rel;
    end if;
  end loop;

  -- The registry is an executable deletion/export inventory. Every physical
  -- table in the private schemas must have one row; views and sequences are
  -- intentionally outside this relation-level inventory.
  for v_att in
    select format('%I.%I', n.nspname, c.relname)
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = any (array['app', 'catalog', 'reco', 'ops', 'support', 'migration'])
       and c.relkind in ('r', 'p')
       and not exists (
         select 1 from ops.data_retention_registry r where r.relation = c.oid
       )
  loop
    raise exception 'private table % is missing from deletion/export registry', v_att;
  end loop;

  for v_att in
    select format('%I.%I', n.nspname, c.relname)
      from ops.data_retention_registry r
      join pg_catalog.pg_class c on c.oid = r.relation
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where r.introduced_in = 'm3'
       and c.relkind in ('r', 'p')
       and (not c.relrowsecurity or not c.relforcerowsecurity)
  loop
    raise exception 'M3 table % is not FORCE ROW LEVEL SECURITY', v_att;
  end loop;

  if exists (
    select 1 from ops.retention_classes
     where scope = 'migration_staging' and max_days_after_cutover <> 30
  ) or exists (
    select 1 from ops.retention_classes
     where scope <> 'migration_staging' and max_days_after_cutover is not null
  ) then
    raise exception 'retention classes permit an unbounded staging window';
  end if;
  if exists (
    select 1 from ops.data_retention_registry
     where deletion_mode = 'de_identify' and account_uuid_columns <> '{}'::text[]
  ) then
    raise exception 'de-identified relation retains an original account UUID';
  end if;
  if not exists (
    select 1 from ops.data_retention_registry
     where relation = 'migration.legacy_user_game_state_audit'::regclass
       and retention_class = 'staging-30d-post-cutover'
       and deletion_mode = 'cascade'
       and export_scope = 'operator_only'
       and account_uuid_columns = '{source_user_id}'::text[]
  ) then
    raise exception 'stale user-game-state archive is not bounded staging';
  end if;
  if not exists (
    select 1 from ops.retention_classes
     where retention_class = 'ui-history-90d'
       and scope = 'operational'
       and description like '%latest 100%'
       and description like '%90 days%'
  ) then
    raise exception 'UI-history retention class is not explicitly bounded';
  end if;
  if exists (
    select 1 from ops.data_retention_registry
     where relation in (
       'app.vault_draws'::regclass,
       'app.vault_draw_events'::regclass,
       'app.vault_events'::regclass
     ) and retention_class <> 'ui-history-90d'
  ) then
    raise exception 'UI draw/event history is still classified as durable lifetime';
  end if;
  if exists (
    select 1 from ops.data_retention_registry
     where relation in (
       'app.completion_events'::regclass,
       'app.unknown_completion_history'::regclass,
       'app.completion_event_registry'::regclass
     ) and retention_class <> 'durable-account-lifetime'
  ) then
    raise exception 'completion history lost durable account retention';
  end if;
  foreach v_rel in array array[
    'app.ui_history_retention_candidates'
  ] loop
    if to_regclass(v_rel) is null then
      raise exception 'UI-history cleanup support % is missing', v_rel;
    end if;
  end loop;
  if position('NOT MATERIALIZED' in upper(
       pg_get_viewdef('app.ui_history_retention_candidates'::regclass)
     )) = 0 then
    raise exception 'UI-history candidate view must allow account predicate pushdown';
  end if;
  if to_regprocedure('app.detach_vault_draw_collection()') is not null then
    raise exception 'obsolete SECURITY DEFINER collection-detach helper remains';
  end if;
  if exists (select 1 from migration.staging_retention_status where purge_due) then
    raise exception 'staging is purge-due before a validated cutover';
  end if;
  if exists (select 1 from migration.unpreserved_evidence) then
    raise exception 'preservation gate has rows before any fixture load';
  end if;

  -- Credential-adjacent values must not have a physical archive column.
  foreach v_rel in array array[
    'migration.legacy_manual_session_audit',
    'migration.legacy_auth_intent_audit',
    'migration.legacy_import_freeze_report'
  ] loop
    v_oid := to_regclass(v_rel);
    if exists (
      select 1 from pg_attribute
      where attrelid = v_oid and attnum > 0 and not attisdropped
        and lower(attname) in (
          'token_hash', 'token_digest', 'nonce', 'openid_response_nonce',
          'processing_token', 'games'
        )
    ) then
      raise exception 'credential/payload column present in %', v_rel;
    end if;
  end loop;
end
$$;

begin;

DO $$
declare
  aid integer;
  other_aid integer;
  gid integer;
  cid bigint;
  sid bigint;
  v_run_id uuid;
  source_id uuid;
  delete_aid integer;
  delete_gid integer;
  delete_public uuid;
  keep_public uuid;
  delete_draw_id bigint;
  delete_draw_public uuid;
  delete_snapshot_id bigint;
  delete_completion_id bigint;
  delete_unknown_id bigint;
  delete_collection_id bigint;
  keep_collection_id bigint;
  keep_draw_id bigint;
  keep_draw_public uuid;
  collection_draw_id bigint;
  delete_member_id integer;
  delete_session_id bigint;
  delete_source_uuid uuid;
  delete_member_uuid uuid;
  delete_session_uuid uuid;
  delete_collection_uuid uuid;
  delete_game_uuid uuid;
  delete_user_uuid uuid;
  delete_intent_uuid uuid;
  delete_merge_uuid uuid;
  delete_review_id bigint;
  n bigint;
begin
  insert into app.accounts (account_kind, display_name)
    values ('manual', 'M3 replay owner') returning id into aid;
  insert into app.accounts (account_kind, display_name)
    values ('manual', 'M3 replay other') returning id into other_aid;
  insert into catalog.games (steam_app_id, title, normalized_sort_title)
    values (3999999996, 'M3 replay game', 'm3 replay game') returning id into gid;
  update catalog.games
    set first_seen_at = timestamptz '2026-09-01 00:00:00+00',
        last_seen_at = timestamptz '2026-09-10 00:00:00+00'
    where id = gid;
  insert into app.collections (account_id, collection_kind, name)
    values (aid, 'custom', 'M3 replay collection') returning id into cid;
  insert into app.sessions (
    account_id, token_digest, session_kind, created_at, expires_at
  ) values (
    aid, decode(repeat('02', 32), 'hex'), 'manual', now(), now() + interval '1 day'
  ) returning id into sid;

  source_id := gen_random_uuid();
  insert into migration.account_map (legacy_id, account_id, source_kind)
    values (source_id, aid, 'app_accounts');
  insert into migration.game_map (steam_appid, game_id)
    values (3999999996, gid);
  insert into migration.account_map (legacy_id, account_id, source_kind)
    values (source_id, aid, 'app_users')
    on conflict (legacy_id) do update
      set account_id = excluded.account_id,
          source_kind = excluded.source_kind;
  insert into migration.game_map (steam_appid, game_id)
    values (3999999996, gid)
    on conflict (steam_appid) do update set game_id = excluded.game_id;
  select count(*) into n from migration.account_map where legacy_id = source_id;
  if n <> 1 then raise exception 'account map retry created a duplicate'; end if;
  select count(*) into n from migration.game_map where steam_appid = 3999999996;
  if n <> 1 then raise exception 'game map retry created a duplicate'; end if;
  insert into migration.library_row_map (legacy_id, account_id, game_id, steam_appid)
    values (gen_random_uuid(), aid, gid, 3999999996);
  insert into migration.collection_map (legacy_id, account_id, collection_id)
    values (gen_random_uuid(), aid, cid);
  insert into migration.session_map (legacy_id, account_id, session_id)
    values (gen_random_uuid(), aid, sid);

  -- One source mapping may be replayed; a second target identity is rejected.
  begin
    insert into migration.account_map (legacy_id, account_id, source_kind)
      values (gen_random_uuid(), aid, 'app_accounts');
    raise exception 'account map target uniqueness was bypassed';
  exception when unique_violation then null;
  end;
  begin
    insert into migration.game_map (steam_appid, game_id)
      values (3999999995, gid);
    raise exception 'game map target uniqueness was bypassed';
  exception when unique_violation then null;
  end;

  insert into migration.runs (
    run_id, snapshot_key, source_project_ref, source_snapshot_hash,
    started_at, status, current_phase
  ) values (
    gen_random_uuid(), 'm3-replay-snapshot', 'vbjtbwelnhbbdfrqczyf',
    decode(repeat('cd', 32), 'hex'), now(), 'running', 'identity'
  ) returning run_id into v_run_id;
  insert into migration.applied_steps (
    run_id, phase, status, started_at, details
  ) values (v_run_id, 'identity', 'started', now(), '{"watermark":"source-1"}'::jsonb);
  update migration.applied_steps
    set status = 'complete', finished_at = now(), restart_watermark = 'source-1'
    where migration.applied_steps.run_id = v_run_id and phase = 'identity';
  update migration.runs
    set status = 'succeeded', finished_at = now(), current_phase = null
    where migration.runs.run_id = v_run_id;
  insert into migration.relation_counts (
    run_id, relation_name, source_rows, loaded_rows, archived_rows, conflict_rows,
    source_snapshot_hash
  ) values (v_run_id, 'user_games', 2, 1, 1, 1, decode(repeat('cd', 32), 'hex'));
  insert into migration.conflict_report (
    run_id, conflict_class, source_relation, source_column, conflict_count, decision
  ) values (v_run_id, 'authored-hours', 'user_games', 'hours_played', 1, 'retain raw evidence; await D-LIB-1');
  insert into migration.legacy_schema_migration_ledger (
    source_migration, source_version, source_sha256, target_migration,
    target_sha256, applied_at, status
  ) values (
    'legacy-public', 'source-snapshot-20260909', repeat('a', 64),
    'm3-preservation-schema', repeat('b', 64), now(), 'verified'
  );

  select count(*) into n from migration.runs r
    where r.run_id = v_run_id and r.status = 'succeeded' and r.finished_at is not null;
  if n <> 1 then raise exception 'phase run did not close'; end if;
  select count(*) into n from migration.applied_steps
    where migration.applied_steps.run_id = v_run_id and phase = 'identity'
      and status = 'complete' and finished_at is not null;
  if n <> 1 then raise exception 'phase step did not close'; end if;

  -- A validated cutover starts one shared, hard-bounded staging deadline.
  -- Anchor this fixture to the transaction clock so it remains valid after
  -- the original test date; prove a hold suppresses an actually due purge.
  update migration.cutover_state
     set validated_cutover_at = now() - interval '31 days',
         validated_by = 'm3-fixture',
         parity_report_ref = 'm3-parity-fixture',
         updated_at = now();
  select count(*) into n
    from migration.staging_retention_status
   where due_at = now() - interval '1 day'
     and staging_retention_days = 30
     and purge_due;
  if n = 0 then raise exception 'staging retention bound was not recorded'; end if;
  insert into migration.retention_holds
    (relation, incident_ref, approved_by, rationale, opened_at, expires_at)
  values ('migration.legacy_library_evidence', 'M3-INCIDENT-1', 'm3-fixture',
          'Synthetic recovery hold', now() - interval '1 hour',
          now() + interval '1 day');
  if not exists (
    select 1 from migration.staging_retention_status
     where relation = 'migration.legacy_library_evidence'::regclass
       and hold_active and not purge_due
  ) then
    raise exception 'recovery hold did not suppress staging purge';
  end if;
  update migration.retention_holds
     set expires_at = now() - interval '1 second'
   where incident_ref = 'M3-INCIDENT-1';
  if not exists (
    select 1 from migration.staging_retention_status
     where relation = 'migration.legacy_library_evidence'::regclass
       and not hold_active and purge_due
  ) then
    raise exception 'expired recovery hold still suppressed staging purge';
  end if;
  insert into ops.legacy_worker_runs (
    legacy_id, worker_name, status, run_class, started_at, finished_at,
    counts, summary, retention_until
  ) values (
    gen_random_uuid(), 'm3-fixture', 'succeeded', 'routine',
    timestamptz '2026-09-10 00:00:00+00', timestamptz '2026-09-10 00:01:00+00',
    '{}'::jsonb, '{}'::jsonb, timestamptz '2026-09-24 00:00:00+00'
  );
  begin
    insert into ops.legacy_worker_runs (
      legacy_id, worker_name, status, run_class, started_at,
      counts, summary, retention_until
    ) values (
      gen_random_uuid(), 'm3-fixture', 'succeeded', 'routine',
      timestamptz '2026-09-10 00:00:00+00', '{}'::jsonb, '{}'::jsonb,
      timestamptz '2026-09-25 00:00:00+00'
    );
    raise exception 'routine worker retention exceeded 14 days';
  exception when check_violation then null;
  end;
  insert into ops.legacy_worker_runs (
    legacy_id, worker_name, status, run_class, started_at,
    counts, summary, retention_until
  ) values (
    gen_random_uuid(), 'm3-fixture', 'failed', 'failure',
    timestamptz '2026-09-10 00:00:00+00', '{}'::jsonb, '{}'::jsonb,
    timestamptz '2026-10-10 00:00:00+00'
  );
  begin
    insert into ops.legacy_worker_runs (
      legacy_id, worker_name, status, run_class, started_at,
      counts, summary, retention_until
    ) values (
      gen_random_uuid(), 'm3-fixture', 'failed', 'failure',
      timestamptz '2026-09-10 00:00:00+00', '{}'::jsonb, '{}'::jsonb,
      timestamptz '2026-10-11 00:00:00+00'
    );
    raise exception 'failure worker retention exceeded 30 days';
  exception when check_violation then null;
  end;

  -- An unreproducible legacy measurement blocks cutover until its durable
  -- account-domain evidence is written; the row is never silently discarded.
  insert into migration.legacy_library_evidence (
    legacy_id, account_id, steam_appid, legacy_hours_played,
    legacy_hours_played_raw, date_added_raw, created_at,
    reproducible_from_observed, conversion_formula
  ) values (
    gen_random_uuid(), aid, 3999999996, 12.345, '12.345', '10/09/2026', now(),
    false, null
  );
  select count(*) into n from migration.unpreserved_evidence
   where gate = 'library_legacy_measurement' and account_id = aid;
  if n <> 1 then raise exception 'unreproducible library evidence did not block'; end if;
  insert into app.library_legacy_measurements (
    account_id, game_id, steam_app_id, ownership_kind,
    observed_minutes_at_freeze, legacy_hours_played, legacy_hours_played_raw,
    discrepancy_kind, recorded_at
  ) values (
    aid, gid, 3999999996, 'personal', 740, 12.345, '12.345',
    'hours_not_reproducible', now()
  );
  insert into app.account_capability_evidence (
    account_id, source_account_kind, evidence_precedence,
    raw_library_visible, raw_playtime_visible, raw_last_played_visible,
    projection_status
  ) values (aid, 'steam', 'account_writer', true, true, true, 'visible');
  select count(*) into n from migration.unpreserved_evidence
   where gate = 'library_legacy_measurement' and account_id = aid;
  if n <> 0 then raise exception 'durable library evidence did not close the gate'; end if;
  select count(*) into n from migration.unpreserved_evidence where account_id = aid;
  if n <> 0 then raise exception 'preservation gate retained an unresolved fixture row'; end if;

  -- The complete stale child is bounded staging.  An explicit row disposition
  -- promotes only sole/conflicting facts to the sparse durable account table.
  insert into migration.legacy_user_game_state_audit (
    account_id, source_user_id, steam_appid, raw_prev_active_status,
    raw_recency_code, evidence_disposition
  ) values (aid, gen_random_uuid(), 3999999996, 1, 2, 'durable_sparse_required');
  select count(*) into n from migration.unpreserved_evidence
   where gate = 'game_state_legacy_measurement' and account_id = aid;
  if n <> 1 then raise exception 'sole stale state evidence did not block staging expiry'; end if;
  insert into app.game_state_legacy_measurements (
    account_id, steam_app_id, source_user_id, raw_prev_active_status,
    raw_recency_code, evidence_reason
  )
  select account_id, steam_appid, source_user_id, raw_prev_active_status,
         raw_recency_code, 'unresolved_codebook'
    from migration.legacy_user_game_state_audit
   where account_id = aid and steam_appid = 3999999996;
  update migration.legacy_user_game_state_audit
     set evidence_disposition = 'durable_sparse_written'
   where account_id = aid and steam_appid = 3999999996;
  if exists (select 1 from migration.unpreserved_evidence where account_id = aid) then
    raise exception 'sparse durable state evidence did not close the preservation gate';
  end if;

  -- Orphan family evidence retains a source member without manufacturing a
  -- target app.family_members row.
  insert into migration.legacy_family_access_orphans (
    account_id, source_user_id, source_member_id, steam_appid, disposition
  ) values (aid, gen_random_uuid(), gen_random_uuid(), 3999999996, 'quarantine');
  if exists (select 1 from app.family_members where account_id = aid) then
    raise exception 'orphan fixture manufactured a family member';
  end if;

  -- Account deletion reaches durable evidence and all bounded rows that retain
  -- source UUIDs. The review decision is the deliberate SET NULL exception:
  -- it carries no source reviewer UUID, so de-identification is honest and the
  -- shared catalogue decision survives.
  insert into app.accounts (account_kind, display_name)
    values ('manual', 'M3 deletion fixture')
    returning id, public_id into delete_aid, delete_public;
  select public_id into keep_public from app.accounts where id = other_aid;
  insert into catalog.games (steam_app_id, title, normalized_sort_title)
    values (3999999994, 'M3 deletion game', 'm3 deletion game')
    returning id into delete_gid;
  insert into app.collections (account_id, collection_kind, name)
    values (delete_aid, 'custom', 'M3 deletion collection')
    returning id, public_id into delete_collection_id, delete_collection_uuid;
  -- Keep a second tenant's collection, draw, and current pointer in the same
  -- transaction. The draw deletion below must not affect this state.
  insert into app.collections (account_id, collection_kind, name)
    values (other_aid, 'custom', 'M3 keeper collection')
    returning id into keep_collection_id;
  insert into app.vault_draws (
    public_id, account_id, game_id, steam_app_id, drawn_at,
    source_collection_id, collection_id, eligible_pool_count, reroll_index
  ) values (
    gen_random_uuid(), other_aid, delete_gid, 3999999994, now(),
    gen_random_uuid(), keep_collection_id, 1, 0
  ) returning id, public_id into keep_draw_id, keep_draw_public;
  insert into app.vault_state (account_id, current_game_id, current_draw_ref)
    values (other_aid, null, keep_draw_public);
  insert into app.collection_games (account_id, collection_id, game_id, position)
    values (delete_aid, delete_collection_id, delete_gid, 0);
  insert into app.family_members (account_id, steam_id, candidate_app_ids, candidate_count)
    values (delete_aid, 76561198000000001, '[3999999994]'::jsonb, 1)
    returning id into delete_member_id;
  insert into app.family_game_access (account_id, member_id, game_id)
    values (delete_aid, delete_member_id, delete_gid);
  insert into app.sessions (
    account_id, token_digest, session_kind, created_at, expires_at
  ) values (
    delete_aid, decode(repeat('03', 32), 'hex'), 'manual',
    timestamptz '2026-09-10 01:00:00+00', timestamptz '2026-09-11 01:00:00+00'
  ) returning id into delete_session_id;
  delete_session_uuid := gen_random_uuid();
  delete_member_uuid := gen_random_uuid();
  delete_game_uuid := gen_random_uuid();
  delete_user_uuid := gen_random_uuid();
  delete_intent_uuid := gen_random_uuid();
  delete_merge_uuid := gen_random_uuid();
  delete_source_uuid := gen_random_uuid();

  insert into app.vault_draws (
    public_id, account_id, game_id, steam_app_id, drawn_at,
    source_collection_id, collection_id, selected_genres, eligible_pool_count,
    reroll_index, finalist_app_ids
  ) values (
    gen_random_uuid(), delete_aid, delete_gid, 3999999994, now(),
    delete_collection_uuid, delete_collection_id, '[]'::jsonb, 1, 0, null
  ) returning id, public_id into delete_draw_id, delete_draw_public;
  insert into app.vault_draw_events (public_id, account_id, draw_id, event_type, occurred_at)
    values (gen_random_uuid(), delete_aid, delete_draw_id, 'drawn', now());
  insert into app.vault_events (public_id, account_id, game_id, legacy_game_id, action, occurred_at)
    values (gen_random_uuid(), delete_aid, delete_gid, delete_game_uuid, 'dismissed', now());
  insert into app.vault_state (account_id, current_game_id, current_draw_ref)
    values (delete_aid, delete_gid, delete_draw_public);
  -- A draw deletion cascades its event and clears only the nullable draw
  -- pointer. The account, game pointer, and other tenant's state survive.
  delete from app.vault_draws where id = delete_draw_id;
  if exists (select 1 from app.vault_draws where id = delete_draw_id)
     or exists (select 1 from app.vault_draw_events where draw_id = delete_draw_id) then
    raise exception 'draw deletion left the draw or its event';
  end if;
  if not exists (
    select 1 from app.accounts where id = delete_aid
  ) or not exists (
    select 1 from app.vault_state
     where account_id = delete_aid
       and current_game_id = delete_gid
       and current_draw_ref is null
  ) then
    raise exception 'draw deletion did not preserve account and clear only current draw';
  end if;
  if not exists (
    select 1 from app.collections
     where id = keep_collection_id and account_id = other_aid
  ) or not exists (
    select 1 from app.vault_draws
     where id = keep_draw_id and account_id = other_aid
       and collection_id = keep_collection_id
  ) or not exists (
    select 1 from app.vault_state
     where account_id = other_aid and current_draw_ref = keep_draw_public
  ) then
    raise exception 'draw deletion crossed the tenant boundary';
  end if;

  -- A second draw still references the soon-to-be-deleted collection. Native
  -- column-scoped SET NULL must clear collection_id while retaining tenant and
  -- source UUIDs, without a trigger or SECURITY DEFINER helper.
  insert into app.vault_draws (
    public_id, account_id, game_id, steam_app_id, drawn_at,
    source_collection_id, collection_id, eligible_pool_count, reroll_index
  ) values (
    gen_random_uuid(), delete_aid, delete_gid, 3999999994, now(),
    delete_collection_uuid, delete_collection_id, 1, 0
  ) returning id into collection_draw_id;
  insert into app.library_games (account_id, game_id, playtime_minutes)
    values (delete_aid, delete_gid, 7);
  insert into app.game_state (account_id, game_id, completed_at)
    values (delete_aid, delete_gid, now());
  insert into app.game_activity (
    account_id, game_id, last_observed_minutes, observed_at, evidence_source
  ) values (delete_aid, delete_gid, 7, now(), 'steam_api');
  insert into app.playtime_daily (account_id, activity_day, observed_minutes)
    values (delete_aid, date '2026-09-10', 7);
  insert into app.pins (
    account_id, scope, slot, game_id, pinned_at, personal_minutes_baseline,
    legacy_hours_at_pin, legacy_hours_at_pin_raw, baseline_conversion_status
  ) values (delete_aid, 'library', 1, delete_gid, now(), 7, 0.116666666667,
            '0.116666666667', 'exact_minutes');
  insert into app.completion_events (
    account_id, game_id, source, dedupe_key, legacy_event_id
  ) values (delete_aid, delete_gid, 'migration', 'm3-delete-completion', delete_merge_uuid)
    returning id into delete_completion_id;
  insert into app.unknown_completion_history (
    legacy_event_id, account_id, source_game_id, actor, origin_surface,
    occurred_at, state, legacy_hours_played_raw
  ) values (delete_intent_uuid, delete_aid, delete_game_uuid, 'user', 'details',
            now(), 'occurred', 'unknown') returning id into delete_unknown_id;
  insert into app.completion_event_registry
    (legacy_event_id, account_id, record_kind, resolved_event_id)
  values (delete_merge_uuid, delete_aid, 'resolved', delete_completion_id);
  insert into app.completion_event_registry
    (legacy_event_id, account_id, record_kind, unknown_history_id)
  values (delete_intent_uuid, delete_aid, 'unknown', delete_unknown_id);
  insert into app.library_legacy_measurements (
    account_id, game_id, steam_app_id, ownership_kind,
    observed_minutes_at_freeze, legacy_hours_played, legacy_hours_played_raw,
    discrepancy_kind
  ) values (delete_aid, delete_gid, 3999999994, 'personal', 7, 0.2, '0.2',
            'hours_not_reproducible');
  insert into app.purge_review_history (
    account_id, game_id, steam_app_id, action, reviewed_at, playtime_minutes_at_review
  ) values (delete_aid, delete_gid, 3999999994, 'keep', now(), 7);
  insert into app.family_access_orphans (
    account_id, game_id, steam_app_id, lender_steam_id, disposition
  ) values (delete_aid, delete_gid, 3999999994, 76561198000000002, 'quarantine');
  insert into app.account_capability_evidence (
    account_id, source_account_kind, evidence_precedence, raw_library_visible,
    projection_status, captured_at
  ) values (delete_aid, 'manual', 'account_writer', false, 'unknown', now());
  insert into reco.warm_start_snapshots (
    snapshot_key, snapshot_version, status, frozen_at
  ) values ('m3-delete', 1, 'frozen', now()) returning id into delete_snapshot_id;
  insert into reco.user_genre_preferences (
    snapshot_id, source_user_id, account_id, genre, positive, total
  ) values (delete_snapshot_id, delete_user_uuid, delete_aid, 'Action', 1, 2);
  insert into ops.abuse_cooldowns (
    bucket, key_digest, account_id, window_started_at, request_count,
    observed_at, algorithm_version, status
  ) values ('m3_delete', decode(repeat('04', 32), 'hex'), delete_aid,
            now(), 1, now(), 'm3-test', 'active');
  insert into ops.account_aliases (
    source_account_id, target_account_id, source_public_id
  ) values (delete_aid, other_aid, delete_public);
  insert into ops.account_merges (
    source_account_id, target_account_id, mode, verified_steam_id, reason,
    legacy_merge_id, legacy_merge_mode, source_public_id, target_public_id
  ) values (delete_aid, other_aid, 'merge', 76561198000000003, 'M3 deletion test',
            delete_merge_uuid, 'merged_existing', delete_public, keep_public);
  insert into support.contact_messages (
    source_record_id, source_account_public_id, account_id, enquiry_type,
    email, subject, message, status_code, created_at, updated_at
  ) values (gen_random_uuid(), delete_public, delete_aid, 1, 'delete@example.com',
            'Deletion test', 'Delete with account', 0, now(), now());
  insert into support.feedback_submissions (
    source_record_id, source_account_public_id, account_id, feedback_type,
    message, status_code, created_at, updated_at
  ) values (gen_random_uuid(), delete_public, delete_aid, 0,
            'Deletion test feedback', 0, now(), now());

  insert into migration.account_map (legacy_id, account_id, source_kind)
    values (delete_source_uuid, delete_aid, 'app_users');
  insert into migration.library_row_map (
    legacy_id, account_id, game_id, steam_appid
  ) values (gen_random_uuid(), delete_aid, delete_gid, 3999999994);
  insert into migration.collection_map (legacy_id, account_id, collection_id)
    values (gen_random_uuid(), delete_aid, delete_collection_id);
  insert into migration.session_map (legacy_id, account_id, session_id)
    values (delete_session_uuid, delete_aid, delete_session_id);
  insert into migration.legacy_user_game_state_audit (
    account_id, source_user_id, steam_appid, raw_completed_at
  ) values (delete_aid, delete_user_uuid, 3999999994, now());
  if not exists (
    select 1 from migration.legacy_user_game_state_audit
     where account_id = delete_aid
       and steam_appid = 3999999994
       and retention_class = 'staging-30d-post-cutover'
       and evidence_disposition = 'reconcile_only'
  ) then
    raise exception 'stale user-game-state evidence did not remain bounded staging';
  end if;
  insert into app.game_state_legacy_measurements (
    account_id, steam_app_id, source_user_id, raw_completed_at, evidence_reason
  ) values (delete_aid, 3999999994, delete_user_uuid, now(), 'stale_conflict');
  update migration.legacy_user_game_state_audit
     set evidence_disposition = 'durable_sparse_written'
   where account_id = delete_aid and steam_appid = 3999999994;
  insert into migration.legacy_library_evidence (
    legacy_id, account_id, steam_appid, legacy_hours_played,
    legacy_hours_played_raw, date_added_raw, created_at
  ) values (gen_random_uuid(), delete_aid, 3999999994, 0.2, '0.2',
            '10/09/2026', now());
  insert into migration.legacy_family_member_evidence (
    legacy_member_id, account_id, steam_id, created_at
  ) values (delete_member_uuid, delete_aid, 76561198000000001, now());
  insert into migration.legacy_family_access_orphans (
    account_id, source_user_id, source_member_id, steam_appid, disposition
  ) values (delete_aid, delete_user_uuid, delete_member_uuid, 3999999994, 'quarantine');
  insert into migration.legacy_account_preferences_evidence (
    account_id, source_account_id, preference_key, value
  ) values (delete_aid, delete_public, 'm3-delete', '{"value":true}'::jsonb);
  insert into migration.legacy_manual_session_audit (
    legacy_session_id, account_id, created_at, last_seen_at, expires_at,
    expired_at_freeze
  ) values (delete_session_uuid, delete_aid, now(), now(), now() + interval '1 day', false);
  insert into migration.legacy_auth_intent_audit (
    legacy_intent_id, account_id, source_account_id, legacy_session_id,
    created_at, expires_at, target_account_id, target_mapped_account_id,
    verified_steam_id
  ) values (gen_random_uuid(), delete_aid, delete_public, delete_session_uuid,
            now(), now() + interval '1 day', keep_public, other_aid, '76561198000000004');
  insert into migration.legacy_account_merge_audit (
    legacy_merge_id, mapped_source_account_id, mapped_target_account_id,
    source_account_id, target_account_id, verified_steam_id, merge_mode, created_at
  ) values (gen_random_uuid(), delete_aid, other_aid, delete_public, keep_public,
            '76561198000000005', 'merged_existing', now());
  insert into migration.legacy_purge_review_archive (
    legacy_id, account_id, source_game_id, action, reviewed_at,
    playtime_minutes_at_review
  ) values (gen_random_uuid(), delete_aid, delete_game_uuid, 'keep', now(), 7);
  insert into migration.legacy_collection_membership_evidence (
    account_id, source_collection_id, source_game_id, collection_id,
    source_position, source_created_at, position_resolution
  ) values (delete_aid, delete_collection_uuid, delete_game_uuid,
            delete_collection_id, 0, now(), 'source');
  insert into migration.legacy_import_freeze_report (
    account_id, source_user_id, status, total_games, imported_games,
    play_history_missing, started_at, updated_at
  ) values (delete_aid, delete_user_uuid, 'complete', 1, 1, false, now(), now());

  insert into catalog.review_decisions (
    game_id, steam_app_id, decision_kind, source_relation, source_record_key,
    source, precedence_rank, decision_status, reviewer_account_id,
    created_at, updated_at
  ) values (delete_gid, 3999999994, 'manual_override', 'catalog_games',
            'm3-delete-review', 'm3-test', 100, 'approved', delete_aid, now(), now())
    returning id into delete_review_id;

  -- This native column-scoped FK intentionally SET NULLs only collection_id.
  -- The staging row still carries both source UUIDs until account deletion.
  delete from app.collections where id = delete_collection_id;
  if not exists (
    select 1 from migration.legacy_collection_membership_evidence
     where account_id = delete_aid
       and source_collection_id = delete_collection_uuid
       and collection_id is null
  ) then
    raise exception 'SET NULL collection FK discarded source ordering UUID';
  end if;
  if not exists (
    select 1 from app.vault_draws
     where id = collection_draw_id
       and account_id = delete_aid
       and collection_id is null
       and source_collection_id = delete_collection_uuid
  ) then
    raise exception 'collection deletion did not detach draw while retaining tenant/source identity';
  end if;
  if not exists (
    select 1 from app.collections
     where id = keep_collection_id and account_id = other_aid
  ) or not exists (
    select 1 from app.vault_draws
     where id = keep_draw_id and account_id = other_aid
       and collection_id = keep_collection_id
  ) or not exists (
    select 1 from app.vault_state
     where account_id = other_aid and current_draw_ref = keep_draw_public
  ) then
    raise exception 'collection deletion crossed the tenant boundary';
  end if;

  delete from app.accounts where id = delete_aid;
  if exists (select 1 from app.accounts where id = delete_aid) then
    raise exception 'account deletion did not remove the account row';
  end if;
  if exists (select 1 from app.sessions where account_id = delete_aid)
     or exists (select 1 from app.library_games where account_id = delete_aid)
     or exists (select 1 from app.game_state where account_id = delete_aid)
     or exists (select 1 from app.game_activity where account_id = delete_aid)
     or exists (select 1 from app.playtime_daily where account_id = delete_aid)
     or exists (select 1 from app.vault_draws where account_id = delete_aid)
     or exists (select 1 from app.vault_events where account_id = delete_aid)
     or exists (select 1 from app.unknown_completion_history where account_id = delete_aid)
     or exists (select 1 from app.library_legacy_measurements where account_id = delete_aid)
     or exists (select 1 from app.game_state_legacy_measurements where account_id = delete_aid)
     or exists (select 1 from app.purge_review_history where account_id = delete_aid)
     or exists (select 1 from app.family_access_orphans where account_id = delete_aid)
     or exists (select 1 from app.account_capability_evidence where account_id = delete_aid)
     or exists (select 1 from reco.user_genre_preferences where account_id = delete_aid)
     or exists (select 1 from ops.abuse_cooldowns where account_id = delete_aid)
     or exists (select 1 from migration.account_map where account_id = delete_aid)
     or exists (select 1 from migration.legacy_user_game_state_audit where account_id = delete_aid)
     or exists (select 1 from migration.legacy_library_evidence where account_id = delete_aid)
     or exists (select 1 from migration.legacy_family_member_evidence where account_id = delete_aid)
     or exists (select 1 from migration.legacy_family_access_orphans where account_id = delete_aid)
     or exists (select 1 from migration.legacy_account_preferences_evidence where account_id = delete_aid)
     or exists (select 1 from migration.legacy_manual_session_audit where account_id = delete_aid)
     or exists (select 1 from migration.legacy_auth_intent_audit where account_id = delete_aid)
     or exists (select 1 from migration.legacy_account_merge_audit where mapped_source_account_id = delete_aid)
     or exists (select 1 from migration.legacy_purge_review_archive where account_id = delete_aid)
     or exists (select 1 from migration.legacy_collection_membership_evidence where account_id = delete_aid)
     or exists (select 1 from migration.legacy_import_freeze_report where account_id = delete_aid)
     or exists (select 1 from support.contact_messages where account_id = delete_aid)
     or exists (select 1 from support.feedback_submissions where account_id = delete_aid)
     or exists (select 1 from ops.account_aliases where source_account_id = delete_aid)
     or exists (select 1 from ops.account_merges where source_account_id = delete_aid) then
    raise exception 'account deletion left a private derivative row';
  end if;
  if exists (select 1 from migration.account_map where legacy_id = delete_source_uuid)
     or exists (select 1 from app.game_state_legacy_measurements
                 where source_user_id = delete_user_uuid)
     or exists (select 1 from migration.legacy_account_preferences_evidence
                 where source_account_id = delete_public)
     or exists (select 1 from migration.legacy_auth_intent_audit
                 where source_account_id = delete_public or target_account_id = delete_public)
     or exists (select 1 from migration.legacy_account_merge_audit
                 where source_account_id = delete_public or target_account_id = delete_public)
     or exists (select 1 from support.contact_messages
                 where source_account_public_id = delete_public)
     or exists (select 1 from support.feedback_submissions
                 where source_account_public_id = delete_public) then
    raise exception 'account deletion left an original account UUID';
  end if;
  select count(*) into n from catalog.review_decisions
   where id = delete_review_id and reviewer_account_id is null;
  if n <> 1 then
    raise exception 'SET NULL reviewer FK did not de-identify shared decision';
  end if;
  delete from catalog.games where id = delete_gid;
  if exists (select 1 from catalog.review_decisions where id = delete_review_id and game_id is not null) then
    raise exception 'SET NULL catalogue FK was not applied after game deletion';
  end if;
end
$$;

rollback;
\echo M3 replay and archive transaction passed
