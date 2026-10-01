\set ON_ERROR_STOP on
\echo M3 schema, privacy, evidence, and adversarial constraint checks

-- The marker and role boundary are checked before any fixture rows are made.
DO $$
declare
  v_version text;
  v_is_rls boolean;
  v_is_forced boolean;
  v_rel text;
begin
  select schema_version into v_version
    from ops.project_marker where marker = true;
  if v_version <> 'm1' then
    raise exception 'M1 project marker changed by M3: %', v_version;
  end if;

  foreach v_rel in array array[
    'app.vault_draws', 'app.vault_draw_events', 'app.vault_events',
    'app.unknown_completion_history', 'app.completion_event_registry',
    'app.game_state_legacy_measurements',
    'catalog.duration_estimates', 'catalog.duration_aliases',
    'catalog.review_decisions', 'catalog.offers', 'catalog.offer_prices',
    'catalog.provider_state', 'reco.warm_start_snapshots',
    'reco.user_genre_preferences', 'reco.genre_preference_globals',
    'reco.game_preference_globals', 'migration.runs',
    'migration.conflict_report', 'support.contact_messages'
  ] loop
    select c.relrowsecurity, c.relforcerowsecurity into v_is_rls, v_is_forced
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where format('%I.%I', n.nspname, c.relname) = v_rel;
    if not coalesce(v_is_rls, false) or not coalesce(v_is_forced, false) then
      raise exception 'M3 relation % is not forced RLS', v_rel;
    end if;
  end loop;

  foreach v_rel in array array[
    'app.ui_history_retention_candidates'
  ] loop
    if to_regclass(v_rel) is null then
      raise exception 'UI-history retention destination % is missing', v_rel;
    end if;
  end loop;
  if position('NOT MATERIALIZED' in upper(
       pg_get_viewdef('app.ui_history_retention_candidates'::regclass)
     )) = 0 then
    raise exception 'UI-history candidate view must allow account predicate pushdown';
  end if;

  if has_schema_privilege('vault_app', 'migration', 'USAGE')
     or has_schema_privilege('vault_worker', 'migration', 'USAGE')
     or has_schema_privilege('vault_app', 'support', 'USAGE')
     or has_schema_privilege('vault_worker', 'support', 'USAGE') then
    raise exception 'runtime role can use a private M3 schema';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    if has_schema_privilege('anon', 'support', 'USAGE')
       or has_schema_privilege('anon', 'migration', 'USAGE') then
      raise exception 'public Supabase role can use a private M3 schema';
    end if;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    if has_schema_privilege('authenticated', 'support', 'USAGE')
       or has_schema_privilege('authenticated', 'migration', 'USAGE') then
      raise exception 'public Supabase role can use a private M3 schema';
    end if;
  end if;
end
$$;

begin;

DO $$
declare
  aid integer;
  other_aid integer;
  gid integer;
  cid bigint;
  did bigint;
  old_did bigint;
  draw_public uuid;
  other_draw_public uuid;
  ceid bigint;
  unknown_id bigint;
  sid bigint;
  snapshot_id bigint;
  offer_id bigint;
  n integer;
begin
  insert into app.accounts (account_kind, display_name)
    values ('manual', 'M3 fixture') returning id into aid;
  insert into app.accounts (account_kind, display_name)
    values ('manual', 'M3 other fixture') returning id into other_aid;
  -- The two legacy instants have different writers and remain independent.
  update app.accounts
     set last_seen_at = timestamptz '2026-09-10 12:00:00+00',
         last_login_at = timestamptz '2026-09-09 12:00:00+00'
   where id = aid;
  if not exists (
    select 1 from app.accounts
     where id = aid
       and last_seen_at = timestamptz '2026-09-10 12:00:00+00'
       and last_login_at = timestamptz '2026-09-09 12:00:00+00'
  ) then
    raise exception 'last_login_at was derived from or collapsed into last_seen_at';
  end if;
  if exists (select 1 from app.accounts where id = other_aid and last_login_at is not null) then
    raise exception 'NULL legacy last_login_at was invented';
  end if;
  insert into catalog.games (steam_app_id, title, normalized_sort_title, first_seen_reason)
    values (3999999999, 'M3 fixture game', 'm3 fixture game', 'manual') returning id into gid;
  update catalog.games
    set first_seen_at = timestamptz '2026-09-01 00:00:00+00',
        last_seen_at = timestamptz '2026-09-10 00:00:00+00'
    where id = gid;
  if not exists (
    select 1 from catalog.games
     where id = gid
       and first_seen_at = timestamptz '2026-09-01 00:00:00+00'
       and first_seen_at <> created_at
  ) then
    raise exception 'catalogue first_seen_at was collapsed into target creation time';
  end if;
  insert into catalog.game_metadata (game_id, developer, publisher, release_date)
    values (gid, 'Fixture Dev', 'Fixture Pub', date '2026-09-10');
  insert into catalog.game_features (
    game_id, extras_duration_minutes, duration_confidence_label, duration_status,
    duration_kind, windows_compatibility, mac_compatibility, deck_compatibility_detail,
    review_positive, review_negative, review_total, popularity_low, popularity_high
  ) values (
    gid, 60, 'medium', 'ready', 'finite', 'supported', 'unknown', 3,
    80, 20, 100, 10, 50
  );
  insert into app.collections (account_id, collection_kind, name)
    values (aid, 'custom', 'M3 collection') returning id into cid;
  insert into app.collection_games (account_id, collection_id, game_id, position)
    values (aid, cid, gid, 0);
  insert into app.sessions (
    account_id, token_digest, session_kind, created_at, expires_at
  ) values (
    aid, decode(repeat('01', 32), 'hex'), 'manual',
    timestamptz '2026-09-10 00:00:00+00', timestamptz '2026-09-11 00:00:00+00'
  ) returning id into sid;
  insert into app.vault_draws (
    public_id, account_id, game_id, steam_app_id, drawn_at,
    source_collection_id, collection_id, selected_genres, eligible_pool_count,
    reroll_index, finalist_app_ids, source_snapshot_hash
  ) values (
    gen_random_uuid(), aid, gid, 3999999999, now(), gen_random_uuid(), cid,
    '["Action"]'::jsonb, 1, 0, '[3999999999]'::jsonb, decode(repeat('ab', 32), 'hex')
  ) returning id, public_id into did, draw_public;
  insert into app.vault_draws (
    public_id, account_id, game_id, steam_app_id, drawn_at,
    eligible_pool_count, reroll_index, finalist_app_ids
  ) values (
    gen_random_uuid(), other_aid, gid, 3999999999, now(), 1, 0,
    null
  ) returning public_id into other_draw_public;
  insert into app.vault_draw_events (public_id, account_id, draw_id, event_type, occurred_at)
    values (gen_random_uuid(), aid, did, 'drawn', now());
  insert into app.vault_events (public_id, account_id, game_id, action, context, occurred_at)
    values (gen_random_uuid(), aid, gid, 'pinned', '{"source":"m3-test"}'::jsonb, now());
  insert into app.vault_state (account_id, current_game_id, current_draw_ref)
    values (aid, gid, draw_public);

  -- The owner-only candidate view exposes both parts of plan 13's bound:
  -- age is measured from the source event instant, while the draw cap uses a
  -- deterministic account/time/id rank.  The cleanup runner is deliberately
  -- outside this migration; this fixture only proves its indexed candidates.
  insert into app.vault_draws (
    public_id, account_id, game_id, steam_app_id, drawn_at,
    eligible_pool_count, reroll_index
  ) values (
    gen_random_uuid(), aid, gid, 3999999999,
    now() - interval '91 days', 1, 0
  ) returning id into old_did;
  insert into app.vault_draw_events (public_id, account_id, draw_id, event_type, occurred_at)
    values (gen_random_uuid(), aid, old_did, 'drawn', now() - interval '91 days');
  insert into app.vault_events (
    public_id, account_id, game_id, action, occurred_at
  ) values (
    gen_random_uuid(), aid, gid, 'old-action', now() - interval '91 days'
  );
  insert into app.vault_draws (
    public_id, account_id, game_id, steam_app_id, drawn_at,
    eligible_pool_count, reroll_index
  )
  select gen_random_uuid(), aid, gid, 3999999999,
         now() - (g * interval '1 second'), 1, 0
    from generate_series(1, 101) as s(g);
  if not exists (
    select 1 from app.ui_history_retention_candidates
     where account_id = aid and relation_name = 'app.vault_draws'
       and reason = 'age-90d'
  ) then
    raise exception 'aged UI draw was not a retention candidate';
  end if;
  if not exists (
    select 1 from app.ui_history_retention_candidates
     where account_id = aid and relation_name = 'app.vault_draws'
       and reason = 'draw-cap'
  ) then
    raise exception 'draw beyond latest-100 cap was not a retention candidate';
  end if;
  if not exists (
    select 1 from app.ui_history_retention_candidates
     where account_id = aid and relation_name = 'app.vault_draw_events'
       and reason = 'age-90d'
  ) then
    raise exception 'aged UI draw event was not a retention candidate';
  end if;
  if not exists (
    select 1 from app.ui_history_retention_candidates
     where account_id = aid and relation_name = 'app.vault_events'
       and reason = 'age-90d'
  ) then
    raise exception 'aged UI action was not a retention candidate';
  end if;

  insert into app.playtime_daily (account_id, activity_day, observed_minutes, games_with_playtime)
    values (aid, date '2026-09-10', 120, 1);
  insert into app.game_activity (
    account_id, game_id, last_observed_minutes, observed_at,
    evidence_source, recency_evidence_kind
  ) values (aid, gid, 120, now(), 'steam_api', 'observed_playtime_change');
  insert into app.pins (
    account_id, scope, slot, game_id, personal_minutes_baseline,
    legacy_hours_at_pin, legacy_hours_at_pin_raw, baseline_conversion_status
  ) values (aid, 'library', 1, gid, 120, 2.0, '2.0', 'exact_minutes');

  insert into app.completion_events (
    account_id, game_id, source, dedupe_key, legacy_event_id, origin_surface,
    legacy_steam_appid, legacy_hours_played, legacy_hours_played_raw,
    legacy_estimate_minutes, legacy_price_cents, metric_provenance
  ) values (
    aid, gid, 'user', 'm3-resolved', gen_random_uuid(), 'vault', 3999999999,
    2.000000000000, '2.0', 120, 999, '{"unit":"hours"}'::jsonb
  ) returning id into ceid;
  insert into app.unknown_completion_history (
    legacy_event_id, account_id, actor, origin_surface, occurred_at, state,
    legacy_hours_played_raw, metric_provenance
  ) values (
    gen_random_uuid(), aid, 'user', 'details', now(), 'occurred', 'unknown',
    '{"reason":"no-library-row"}'::jsonb
  ) returning id into unknown_id;
  insert into app.completion_event_registry
    (legacy_event_id, account_id, record_kind, resolved_event_id)
    select legacy_event_id, aid, 'resolved', ceid
      from app.completion_events where id = ceid;
  insert into app.completion_event_registry
    (legacy_event_id, account_id, record_kind, unknown_history_id)
    select legacy_event_id, aid, 'unknown', unknown_id
      from app.unknown_completion_history where id = unknown_id;

  insert into catalog.duration_estimates (
    game_id, steam_app_id, provider, checked_at, created_at, updated_at,
    match_status, match_confidence, evidence
  ) values (gid, 3999999999, 'm3-fixture', now(), now(), now(), 'matched', 'high', '{"raw":true}'::jsonb);
  insert into catalog.duration_aliases (
    steam_app_id, game_id, search_title, review_status, created_at, updated_at
  ) values (3999999998, gid, 'M3 fixture alias', 'needs_review', now(), now());
  insert into catalog.offers (
    game_id, provider, first_observed_at, last_observed_at, is_free
  ) values (gid, 'm3-fixture', now(), now(), false) returning id into offer_id;
  insert into catalog.offer_prices (
    offer_id, observed_at, price_initial_cents, price_final_cents,
    discount_percent, is_free, retention_until
  ) values (offer_id, now(), 1000, 500, 50, false, now() + interval '30 days');
  insert into catalog.provider_state (
    game_id, provider, evidence_kind, status, updated_at
  ) values (gid, 'm3-fixture', 'metadata', 'ready', now());

  insert into reco.warm_start_snapshots (
    snapshot_key, snapshot_version, status, frozen_at
  ) values ('m3-fixture', 1, 'frozen', now()) returning id into snapshot_id;
  insert into reco.user_genre_preferences (
    snapshot_id, source_user_id, account_id, genre, positive, total
  ) values (snapshot_id, gen_random_uuid(), aid, 'Action', 2, 3);
  insert into reco.genre_preference_globals (snapshot_id, genre, positive, total)
    values (snapshot_id, 'Action', 4, 8);
  insert into reco.game_preference_globals (snapshot_id, steam_app_id, game_id, positive, total, total_hours)
    values (snapshot_id, 3999999999, gid, 1, 2, 2);
  insert into reco.operator_weight_versions (config_version, weight_key, positive, total)
    values ('m3-fixture-v1', 'genre', 1, 1);

  insert into migration.account_map (legacy_id, account_id, source_kind)
    values (gen_random_uuid(), aid, 'app_accounts');
  insert into migration.game_map (steam_appid, game_id)
    values (3999999999, gid);
  insert into migration.collection_map (legacy_id, account_id, collection_id)
    values (gen_random_uuid(), aid, cid);
  insert into migration.session_map (legacy_id, account_id, session_id)
    values (gen_random_uuid(), aid, sid);
  insert into migration.legacy_user_game_state_audit (
    account_id, source_user_id, steam_appid, raw_completed_at, raw_prev_active_status,
    raw_dismissed_playtime, raw_recency_code, raw_recency_evidence_at
  ) values (
    aid, gen_random_uuid(), 3999999999, now(), 2, 1.25, 3, now()
  );
  insert into migration.legacy_library_evidence (
    legacy_id, account_id, steam_appid, legacy_hours_played,
    legacy_hours_played_raw, date_added_raw, created_at
  ) values (
    gen_random_uuid(), aid, 3999999999, 12.3, '12.3', '10/09/2026', now()
  );
  insert into app.account_capability_evidence (
    account_id, source_account_kind, evidence_precedence, raw_library_visible,
    raw_playtime_visible, raw_last_played_visible, projection_status, conflict_code
  ) values (aid, 'steam', 'account_writer', false, null, false, 'unknown', 'false-is-not-private');
  if not exists (
    select 1 from app.account_capability_evidence
     where account_id = aid and projection_status = 'unknown'
       and raw_library_visible is false and raw_last_played_visible is false
  ) then
    raise exception 'false capability flags were not preserved as unknown';
  end if;
  begin
    insert into app.account_capability_evidence (
      account_id, source_account_kind, evidence_precedence,
      raw_library_visible, raw_playtime_visible, raw_last_played_visible,
      projection_status
    ) values (aid, 'steam', 'profile_reader', false, false, false, 'visible');
    raise exception 'false capability tuple was projected as visible';
  exception when check_violation then null;
  end;
  insert into migration.runs (snapshot_key, started_at, status)
    values ('m3-fixture-snapshot', now(), 'planned');

  -- Cumulative totals and exact values are preserved independently.
  select count(*) into n from app.playtime_daily
    where account_id = aid and observed_minutes = 120
      and observed_minutes_semantic = 'cumulative_total' and games_with_playtime = 1;
  if n <> 1 then raise exception 'playtime semantic fixture failed'; end if;
  select count(*) into n from app.completion_events
    where account_id = aid and legacy_hours_played_raw = '2.0';
  if n <> 1 then raise exception 'raw completion metric fixture failed'; end if;

  -- Negative or semantically incomplete values must be rejected.
  begin
    insert into app.playtime_daily (account_id, activity_day, observed_minutes, games_with_playtime)
      values (aid, date '2026-09-11', 1, -1);
    raise exception 'negative games_with_playtime was accepted';
  exception when check_violation then null;
  end;
  begin
    update app.vault_state set current_draw_ref = gen_random_uuid() where account_id = aid;
    raise exception 'dangling current_draw_ref was accepted';
  exception when foreign_key_violation then null;
  end;
  begin
    update app.vault_state set current_draw_ref = other_draw_public where account_id = aid;
    raise exception 'cross-account current_draw_ref was accepted';
  exception when foreign_key_violation then null;
  end;
  begin
    update catalog.games
       set first_seen_at = timestamptz '2026-09-11 00:00:00+00',
           last_seen_at = timestamptz '2026-09-10 00:00:00+00'
     where id = gid;
    raise exception 'catalogue seen-order conflict was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into app.unknown_completion_history (
      legacy_event_id, account_id, actor, origin_surface, occurred_at, undone_at, state
    ) values (gen_random_uuid(), aid, 'user', 'details', now(), null, 'undone');
    raise exception 'undone completion without timestamp was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into app.completion_event_registry (
      legacy_event_id, account_id, record_kind, resolved_event_id, unknown_history_id
    ) values (gen_random_uuid(), aid, 'resolved', ceid, unknown_id);
    raise exception 'completion registry XOR was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into catalog.offer_prices (
      offer_id, observed_at, currency, is_free, retention_until
    ) values (offer_id, now() + interval '1 second', 'EUR', false, now() + interval '30 days');
    raise exception 'non-US currency was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into catalog.offer_prices (
      offer_id, observed_at, is_free, retention_until
    ) values (offer_id, now() + interval '2 seconds', false, now() + interval '30 days');
    raise exception 'second current offer price was accepted';
  exception when unique_violation then null;
  end;
  begin
    insert into catalog.provider_state (
      game_id, provider, evidence_kind, status, next_attempt_at, updated_at
    ) values (gid, 'm3-fixture', 'tags', 'ready', now(), now());
    raise exception 'ready provider state with retry timestamp was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into catalog.review_decisions (
      steam_app_id, decision_kind, source_relation, source_record_key, source,
      precedence_rank, decision_status, response_kind, created_at, updated_at
    ) values (3999999999, 'duration', 'catalog_duration_reviews', 'm3-bad', 'test', 1,
      'needs_review', 'hltb_url', now(), now());
    raise exception 'incomplete review decision was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into support.feedback_submissions (
      source_record_id, feedback_type, message, contact_allowed, contact_email,
      status_code, created_at, updated_at
    ) values (gen_random_uuid(), 0, 'valid fixture message', false, 'secret@example.com', 0, now(), now());
    raise exception 'contact email without consent was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into reco.user_genre_preferences (
      snapshot_id, source_user_id, account_id, genre, positive, total
    ) values (snapshot_id, gen_random_uuid(), aid, 'Bad', 5, 4);
    raise exception 'positive aggregate above total was accepted';
  exception when check_violation then null;
  end;
end
$$;

rollback;
\echo M3 constraint fixture transaction passed
