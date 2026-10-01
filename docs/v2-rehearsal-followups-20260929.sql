-- VaultShuffle2 ONLY: migrations 6–11. One transaction; refuses identity, ledger, schema or row drift.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';
select pg_advisory_xact_lock(20260929, 6);

do $guard$
declare actual text; relation_name text; n bigint;
begin
 if current_database()<>'postgres' or not exists(select 1 from ops.project_marker where marker and project_name='VaultShuffle2' and expected_project_ref='vbjtbwelnhbbdfrqczyf' and schema_version='m1') then raise exception 'Wrong rehearsal target'; end if;
 if (select array_agg(version order by version) from supabase_migrations.schema_migrations) is distinct from array['20260906093036','20260907163356','20260910232654','20260911234500','20260912193000']::text[] then raise exception 'Applied migration history drift'; end if;
 if not exists(select 1 from supabase_migrations.schema_migrations where version='20260906093036' and name='m1_private_foundation' and cardinality(statements)=1 and encode(sha256(convert_to(array_to_string(statements,chr(10)),'UTF8')),'hex')='54fe0a7defd029e91568b78d51393670ac7ca6edcf915919670c7f64c2476389') then raise exception 'Applied statement bytes drift'; end if;
 if not exists(select 1 from supabase_migrations.schema_migrations where version='20260907163356' and name='m2_jobs_quota_publish' and cardinality(statements)=1 and encode(sha256(convert_to(array_to_string(statements,chr(10)),'UTF8')),'hex')='f09d7ca900f3cdaaee81eff0f507adc5869865f16eb7f340eeb1729223bc5aba') then raise exception 'Applied statement bytes drift'; end if;
 if not exists(select 1 from supabase_migrations.schema_migrations where version='20260910232654' and name='m3_preservation_schema' and cardinality(statements)=1 and encode(sha256(convert_to(array_to_string(statements,chr(10)),'UTF8')),'hex')='605b72a3d9df1328ec27033c3420c1813a238f6e15bd8fc28f971cddaf30a24a') then raise exception 'Applied statement bytes drift'; end if;
 if not exists(select 1 from supabase_migrations.schema_migrations where version='20260911234500' and name='m3_legacy_preservation_followup' and cardinality(statements)=11 and encode(sha256(convert_to(array_to_string(statements,chr(10)),'UTF8')),'hex')='b3c4f18000ad5cdaed0b34cb7ec9e3a7f5ad525f5df6cccf72637d27a48ff915') then raise exception 'Applied statement bytes drift'; end if;
 if not exists(select 1 from supabase_migrations.schema_migrations where version='20260912193000' and name='blacklist_semantics' and cardinality(statements)=27 and encode(sha256(convert_to(array_to_string(statements,chr(10)),'UTF8')),'hex')='e00462c5a54c128ea07aa5434a86adf383c0f8a7e9a74aa8f89a4893a7904870') then raise exception 'Applied statement bytes drift'; end if;
 select schema_fingerprint into actual from (with requested(name) as (values ('app.account_capabilities'),('app.account_capability_evidence'),('app.account_preferences'),('app.accounts'),('app.collection_games'),('app.collections'),('app.completion_event_registry'),('app.completion_events'),('app.family_access_legacy_measurements'),('app.family_access_orphans'),('app.family_game_access'),('app.family_members'),('app.game_activity'),('app.game_state'),('app.game_state_legacy_measurements'),('app.legacy_compatibility_settings'),('app.library_games'),('app.library_legacy_measurements'),('app.pins'),('app.playtime_daily'),('app.purge_review_history'),('app.retired_library_games'),('app.sessions'),('app.snoozes'),('app.steam_profiles'),('app.unknown_completion_history'),('app.vault_draw_events'),('app.vault_draws'),('app.vault_events'),('app.vault_state'),('app.wishlist_games'),('catalog.appid_terminal_rejections'),('catalog.duration_aliases'),('catalog.duration_estimates'),('catalog.duration_imports'),('catalog.game_features'),('catalog.game_metadata'),('catalog.game_sightings'),('catalog.games'),('catalog.offer_prices'),('catalog.offers'),('catalog.provider_state'),('catalog.review_decisions'),('catalog.seed_runs'),('migration.account_map'),('migration.collection_map'),('migration.legacy_account_merge_audit'),('migration.legacy_account_preferences_evidence'),('migration.legacy_auth_intent_audit'),('migration.legacy_collection_membership_evidence'),('migration.legacy_duration_job_archive'),('migration.legacy_family_access_orphans'),('migration.legacy_family_member_evidence'),('migration.legacy_import_freeze_report'),('migration.legacy_ingest_queue_archive'),('migration.legacy_library_evidence'),('migration.legacy_purge_review_archive'),('migration.legacy_user_game_state_audit'),('migration.library_row_map'),('migration.session_map'),('ops.abuse_cooldowns'),('ops.account_aliases'),('ops.account_merges'),('ops.legacy_worker_runs'),('reco.game_preference_globals'),('reco.genre_preference_globals'),('reco.operator_weight_versions'),('reco.user_genre_preferences'),('reco.warm_start_snapshots'),('support.contact_messages'),('support.feedback_submissions'),('support.retention_policy_decisions')), signatures as (select r.name,coalesce(string_agg(case when c.column_name is not null then format('%s.%s|%s|%s|%s',c.table_schema,c.table_name,c.column_name,c.data_type,c.is_nullable) end,E'\n' order by c.column_name collate "C"),r.name||'|<missing>') as signature from requested r left join information_schema.columns c on c.table_schema||'.'||c.table_name=r.name group by r.name) select encode(sha256(convert_to(string_agg(signature,E'\n' order by name collate "C"),'UTF8')),'hex') as schema_fingerprint from signatures) q;
 if actual <> 'e43736b643c2ccbf76020ae53f33a4206dc2e3378fbb053da0c868dafdfe4b0a' then raise exception 'Baseline fingerprint drift'; end if;
 foreach relation_name in array array['app.account_capabilities','app.account_capability_evidence','app.account_preferences','app.accounts','app.collection_games','app.collections','app.completion_event_registry','app.completion_events','app.family_access_legacy_measurements','app.family_access_orphans','app.family_game_access','app.family_members','app.game_activity','app.game_state','app.game_state_legacy_measurements','app.legacy_compatibility_settings','app.library_games','app.library_legacy_measurements','app.pins','app.playtime_daily','app.purge_review_history','app.retired_library_games','app.sessions','app.snoozes','app.steam_profiles','app.unknown_completion_history','app.vault_draw_events','app.vault_draws','app.vault_events','app.vault_state','app.wishlist_games','catalog.appid_terminal_rejections','catalog.duration_aliases','catalog.duration_estimates','catalog.duration_imports','catalog.game_features','catalog.game_metadata','catalog.game_sightings','catalog.games','catalog.offer_prices','catalog.offers','catalog.provider_state','catalog.review_decisions','catalog.seed_runs','migration.account_map','migration.collection_map','migration.legacy_account_merge_audit','migration.legacy_account_preferences_evidence','migration.legacy_auth_intent_audit','migration.legacy_collection_membership_evidence','migration.legacy_duration_job_archive','migration.legacy_family_access_orphans','migration.legacy_family_member_evidence','migration.legacy_import_freeze_report','migration.legacy_ingest_queue_archive','migration.legacy_library_evidence','migration.legacy_purge_review_archive','migration.legacy_user_game_state_audit','migration.library_row_map','migration.session_map','ops.abuse_cooldowns','ops.account_aliases','ops.account_merges','ops.legacy_worker_runs','reco.game_preference_globals','reco.genre_preference_globals','reco.operator_weight_versions','reco.user_genre_preferences','reco.warm_start_snapshots','support.contact_messages','support.feedback_submissions','migration.runs'] loop
  if to_regclass(relation_name) is not null then
   execute format('select count(*) from %s',to_regclass(relation_name)) into n;
   if n<>0 then raise exception 'Rehearsal target must be empty: %',relation_name; end if;
  end if;
 end loop;
end $guard$;

-- Apply 20260913191021_m4_manual_session_touch.sql SHA256 7b993f3e0f7978ea48975cee7c9787de17097f4dcb422a2d2bd07258cd8677bd
-- M4: bounded manual-session sliding renewal.
--
-- The app runtime never receives direct privileges on app.sessions. This
-- narrowly-scoped definer function receives the HMAC digest already verified
-- by app.resolve_session and that resolver's session ID, then returns only the
-- effective expiry. The database statement clock is authoritative.

create function app.touch_manual_session(
  p_token_digest bytea,
  p_session_id bigint
)
returns table (expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
begin
  return query
  update app.sessions as s
     set last_seen_at = statement_timestamp(),
         expires_at = statement_timestamp() + interval '365 days'
    from app.accounts as a
   where p_token_digest is not null
     and octet_length(p_token_digest) = 32
     and p_session_id > 0
     and s.id = p_session_id
     and s.token_digest = p_token_digest
     and s.session_kind = 'manual'
     and s.account_id = a.id
     and a.account_kind = 'manual'
     and a.lifecycle_status = 'active'
     and s.revoked_at is null
     and s.expires_at > statement_timestamp()
     and (s.last_seen_at is null or s.last_seen_at <= statement_timestamp() - interval '1 hour')
  returning s.expires_at;

  if found then
    return;
  end if;

  -- A valid session inside the hourly gate is still a successful lookup. Do
  -- not update it, but return its database-held expiry to the repository.
  return query
  select s.expires_at
    from app.sessions as s
    join app.accounts as a on a.id = s.account_id
   where p_token_digest is not null
     and octet_length(p_token_digest) = 32
     and p_session_id > 0
     and s.id = p_session_id
     and s.token_digest = p_token_digest
     and s.session_kind = 'manual'
     and a.account_kind = 'manual'
     and a.lifecycle_status = 'active'
     and s.revoked_at is null
     and s.expires_at > statement_timestamp();
end
$$;

-- The session resolver and this renewal boundary must have the same migration
-- owner. A different owner could silently alter the SECURITY DEFINER trust
-- boundary when a target replays this additive migration.
do $$
declare
  resolver_owner oid;
  touch_owner oid;
begin
  select proowner into resolver_owner
    from pg_catalog.pg_proc
   where oid = 'app.resolve_session(bytea,text)'::regprocedure;
  select proowner into touch_owner
    from pg_catalog.pg_proc
   where oid = 'app.touch_manual_session(bytea,bigint)'::regprocedure;

  if resolver_owner is null or touch_owner is null or resolver_owner <> touch_owner then
    raise exception 'app.touch_manual_session must share app.resolve_session ownership';
  end if;
end
$$;

revoke all on function app.touch_manual_session(bytea, bigint) from public, vault_app, vault_worker;
grant execute on function app.touch_manual_session(bytea, bigint) to vault_app;


insert into supabase_migrations.schema_migrations(version,name,statements) values('20260913191021','m4_manual_session_touch',array['-- M4: bounded manual-session sliding renewal.
--
-- The app runtime never receives direct privileges on app.sessions. This
-- narrowly-scoped definer function receives the HMAC digest already verified
-- by app.resolve_session and that resolver''s session ID, then returns only the
-- effective expiry. The database statement clock is authoritative.

create function app.touch_manual_session(
  p_token_digest bytea,
  p_session_id bigint
)
returns table (expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
begin
  return query
  update app.sessions as s
     set last_seen_at = statement_timestamp(),
         expires_at = statement_timestamp() + interval ''365 days''
    from app.accounts as a
   where p_token_digest is not null
     and octet_length(p_token_digest) = 32
     and p_session_id > 0
     and s.id = p_session_id
     and s.token_digest = p_token_digest
     and s.session_kind = ''manual''
     and s.account_id = a.id
     and a.account_kind = ''manual''
     and a.lifecycle_status = ''active''
     and s.revoked_at is null
     and s.expires_at > statement_timestamp()
     and (s.last_seen_at is null or s.last_seen_at <= statement_timestamp() - interval ''1 hour'')
  returning s.expires_at;

  if found then
    return;
  end if;

  -- A valid session inside the hourly gate is still a successful lookup. Do
  -- not update it, but return its database-held expiry to the repository.
  return query
  select s.expires_at
    from app.sessions as s
    join app.accounts as a on a.id = s.account_id
   where p_token_digest is not null
     and octet_length(p_token_digest) = 32
     and p_session_id > 0
     and s.id = p_session_id
     and s.token_digest = p_token_digest
     and s.session_kind = ''manual''
     and a.account_kind = ''manual''
     and a.lifecycle_status = ''active''
     and s.revoked_at is null
     and s.expires_at > statement_timestamp();
end
$$;

-- The session resolver and this renewal boundary must have the same migration
-- owner. A different owner could silently alter the SECURITY DEFINER trust
-- boundary when a target replays this additive migration.
do $$
declare
  resolver_owner oid;
  touch_owner oid;
begin
  select proowner into resolver_owner
    from pg_catalog.pg_proc
   where oid = ''app.resolve_session(bytea,text)''::regprocedure;
  select proowner into touch_owner
    from pg_catalog.pg_proc
   where oid = ''app.touch_manual_session(bytea,bigint)''::regprocedure;

  if resolver_owner is null or touch_owner is null or resolver_owner <> touch_owner then
    raise exception ''app.touch_manual_session must share app.resolve_session ownership'';
  end if;
end
$$;

revoke all on function app.touch_manual_session(bytea, bigint) from public, vault_app, vault_worker;
grant execute on function app.touch_manual_session(bytea, bigint) to vault_app;
']::text[]);

-- Apply 20260913220031_m3_reco_game_precision.sql SHA256 177ede8c99144bd840c9c5f33b6314ce13ee9fe628a47775486e1d7238513186
-- M3 recommendation evidence precision correction. PREPARED LOCALLY, NOT APPLIED.
--
-- The real snapshot proves all three float8 values on
-- public.game_preference_globals need more fractional precision than
-- numeric(30,12) can retain exactly. This changes only their destination type
-- modifiers. NOT NULL, ordering/nonnegative checks, primary/FK constraints,
-- indexes, RLS policies, grants and retention registration remain attached.

do $$
declare
  v_column text;
  v_type text;
  v_check text;
begin
  foreach v_column in array array['positive', 'total', 'total_hours'] loop
    select format_type(att.atttypid, att.atttypmod)
      into v_type
    from pg_attribute att
    join pg_class rel on rel.oid = att.attrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'reco'
      and rel.relname = 'game_preference_globals'
      and att.attname = v_column
      and att.attnum > 0
      and not att.attisdropped;

    if v_type is distinct from 'numeric(30,12)' then
      raise exception 'drift: reco.game_preference_globals.% type is %, expected numeric(30,12)', v_column, v_type;
    end if;
  end loop;

  for v_column, v_check in
    select con.conname, pg_get_constraintdef(con.oid)
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'reco'
      and rel.relname = 'game_preference_globals'
      and con.conname in (
        'game_preference_globals_positive_check',
        'game_preference_globals_check',
        'game_preference_globals_total_hours_check'
      )
  loop
    if (v_column = 'game_preference_globals_positive_check' and v_check is distinct from 'CHECK ((positive >= (0)::numeric))')
      or (v_column = 'game_preference_globals_check' and v_check is distinct from 'CHECK ((total >= positive))')
      or (v_column = 'game_preference_globals_total_hours_check' and v_check is distinct from 'CHECK ((total_hours >= (0)::numeric))')
    then
      raise exception 'drift: % is %, expected the M3 counter check', v_column, v_check;
    end if;
  end loop;

  if (select count(*) from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
      where nsp.nspname = 'reco'
        and rel.relname = 'game_preference_globals'
        and con.conname in (
          'game_preference_globals_positive_check',
          'game_preference_globals_check',
          'game_preference_globals_total_hours_check'
        )) <> 3
  then
    raise exception 'drift: reco.game_preference_globals counter checks are incomplete';
  end if;
end $$;

alter table reco.game_preference_globals
  alter column positive type numeric using positive::numeric,
  alter column total type numeric using total::numeric,
  alter column total_hours type numeric using total_hours::numeric,
  add constraint game_preference_globals_finite_check check (
    positive::text not in ('NaN', 'Infinity', '-Infinity')
    and total::text not in ('NaN', 'Infinity', '-Infinity')
    and total_hours::text not in ('NaN', 'Infinity', '-Infinity')
  );

comment on column reco.game_preference_globals.positive is
  'Exact finite legacy float8 text interpreted as an unconstrained nonnegative numeric; no rounding or JavaScript number conversion.';
comment on column reco.game_preference_globals.total is
  'Exact finite legacy float8 text interpreted as an unconstrained numeric not less than positive; no rounding or JavaScript number conversion.';
comment on column reco.game_preference_globals.total_hours is
  'Exact finite legacy float8 text interpreted as an unconstrained nonnegative numeric; no rounding, clamping, unit conversion or JavaScript number conversion.';


insert into supabase_migrations.schema_migrations(version,name,statements) values('20260913220031','m3_reco_game_precision',array['-- M3 recommendation evidence precision correction. PREPARED LOCALLY, NOT APPLIED.
--
-- The real snapshot proves all three float8 values on
-- public.game_preference_globals need more fractional precision than
-- numeric(30,12) can retain exactly. This changes only their destination type
-- modifiers. NOT NULL, ordering/nonnegative checks, primary/FK constraints,
-- indexes, RLS policies, grants and retention registration remain attached.

begin;

do $$
declare
  v_column text;
  v_type text;
  v_check text;
begin
  foreach v_column in array array[''positive'', ''total'', ''total_hours''] loop
    select format_type(att.atttypid, att.atttypmod)
      into v_type
    from pg_attribute att
    join pg_class rel on rel.oid = att.attrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = ''reco''
      and rel.relname = ''game_preference_globals''
      and att.attname = v_column
      and att.attnum > 0
      and not att.attisdropped;

    if v_type is distinct from ''numeric(30,12)'' then
      raise exception ''drift: reco.game_preference_globals.% type is %, expected numeric(30,12)'', v_column, v_type;
    end if;
  end loop;

  for v_column, v_check in
    select con.conname, pg_get_constraintdef(con.oid)
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = ''reco''
      and rel.relname = ''game_preference_globals''
      and con.conname in (
        ''game_preference_globals_positive_check'',
        ''game_preference_globals_check'',
        ''game_preference_globals_total_hours_check''
      )
  loop
    if (v_column = ''game_preference_globals_positive_check'' and v_check is distinct from ''CHECK ((positive >= (0)::numeric))'')
      or (v_column = ''game_preference_globals_check'' and v_check is distinct from ''CHECK ((total >= positive))'')
      or (v_column = ''game_preference_globals_total_hours_check'' and v_check is distinct from ''CHECK ((total_hours >= (0)::numeric))'')
    then
      raise exception ''drift: % is %, expected the M3 counter check'', v_column, v_check;
    end if;
  end loop;

  if (select count(*) from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
      where nsp.nspname = ''reco''
        and rel.relname = ''game_preference_globals''
        and con.conname in (
          ''game_preference_globals_positive_check'',
          ''game_preference_globals_check'',
          ''game_preference_globals_total_hours_check''
        )) <> 3
  then
    raise exception ''drift: reco.game_preference_globals counter checks are incomplete'';
  end if;
end $$;

alter table reco.game_preference_globals
  alter column positive type numeric using positive::numeric,
  alter column total type numeric using total::numeric,
  alter column total_hours type numeric using total_hours::numeric,
  add constraint game_preference_globals_finite_check check (
    positive::text not in (''NaN'', ''Infinity'', ''-Infinity'')
    and total::text not in (''NaN'', ''Infinity'', ''-Infinity'')
    and total_hours::text not in (''NaN'', ''Infinity'', ''-Infinity'')
  );

comment on column reco.game_preference_globals.positive is
  ''Exact finite legacy float8 text interpreted as an unconstrained nonnegative numeric; no rounding or JavaScript number conversion.'';
comment on column reco.game_preference_globals.total is
  ''Exact finite legacy float8 text interpreted as an unconstrained numeric not less than positive; no rounding or JavaScript number conversion.'';
comment on column reco.game_preference_globals.total_hours is
  ''Exact finite legacy float8 text interpreted as an unconstrained nonnegative numeric; no rounding, clamping, unit conversion or JavaScript number conversion.'';

commit;
']::text[]);

-- Apply 20260914101424_m3_real_preflight_evidence.sql SHA256 69de20f0c72797ba204ba164c0ec42e44de1575a76057e84aeecec9a7906df34
-- M3 real-preflight durable evidence correction. PREPARED LOCALLY, NOT APPLIED.
-- Keeps six measured legacy records without changing current vault, pin,
-- snooze, activity, family-access, or recommendation authority.

create table app.family_access_legacy_measurements (
  source_library_id uuid primary key,
  account_id integer not null references app.accounts(id) on delete cascade,
  game_id integer references catalog.games(id) on delete set null,
  steam_app_id bigint not null check (steam_app_id between 1 and 4294967295),
  subject_attribution text not null default 'unknown'
    check (subject_attribution = 'unknown'),
  observed_playtime_minutes integer
    check (observed_playtime_minutes is null or observed_playtime_minutes >= 0),
  last_played_at timestamptz,
  last_observed_played_at timestamptz,
  recency_source text check (
    recency_source is null or length(btrim(recency_source)) between 1 and 120
  ),
  recency_evidence_at timestamptz,
  family_owner_steam_id text check (
    family_owner_steam_id is null or length(family_owner_steam_id) <= 200
  ),
  family_verified_at timestamptz,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  check (observed_playtime_minutes is not null
      or last_played_at is not null
      or last_observed_played_at is not null
      or recency_source is not null
      or recency_evidence_at is not null)
);

comment on table app.family_access_legacy_measurements is
  'Exact legacy family-access observation evidence whose human subject is unknown. '
  'It never feeds current access, personal game activity, or recommendation state.';
comment on column app.family_access_legacy_measurements.family_owner_steam_id is
  'Verbatim legacy lender provenance; it does not identify the subject of the measurement.';

create index family_access_legacy_measurements_account_idx
  on app.family_access_legacy_measurements (account_id, steam_app_id);

create table app.legacy_compatibility_settings (
  source_setting_id uuid primary key,
  account_id integer not null references app.accounts(id) on delete cascade,
  source_account_id uuid not null,
  setting_key text not null check (setting_key in (
    'vault_current_pick_id', 'vault_snoozed_ids', 'wishlist_pinned_ids'
  )),
  value text not null,
  source_created_at timestamptz not null,
  source_updated_at timestamptz not null,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  unique (source_account_id, setting_key),
  check (source_updated_at >= source_created_at)
);

comment on table app.legacy_compatibility_settings is
  'Exact one-release rollback compatibility state. Normalized vault, snooze, and pin '
  'relations remain current authority; these values are never runtime preferences.';

create index legacy_compatibility_settings_account_idx
  on app.legacy_compatibility_settings (account_id, setting_key);

alter table app.family_access_legacy_measurements enable row level security;
alter table app.family_access_legacy_measurements force row level security;
alter table app.legacy_compatibility_settings enable row level security;
alter table app.legacy_compatibility_settings force row level security;

-- Owner/operator only. Account export remains behind the established operator
-- boundary; browser and runtime roles receive no direct table capability.
revoke all on app.family_access_legacy_measurements from public, vault_app, vault_worker;
revoke all on app.legacy_compatibility_settings from public, vault_app, vault_worker;

do $$
begin
  if to_regrole('anon') is not null then
    revoke all on app.family_access_legacy_measurements from anon;
    revoke all on app.legacy_compatibility_settings from anon;
  end if;
  if to_regrole('authenticated') is not null then
    revoke all on app.family_access_legacy_measurements from authenticated;
    revoke all on app.legacy_compatibility_settings from authenticated;
  end if;
end $$;

insert into ops.data_retention_registry
  (relation, introduced_in, retention_class, holds_personal_data,
   account_fk_column, account_uuid_columns, deletion_mode, export_scope, rationale)
values
  ('app.family_access_legacy_measurements', 'm3', 'durable-account-lifetime', true,
   'account_id', '{}', 'cascade', 'account_export',
   'Unknown-subject family observation evidence; never active personal playtime or access.'),
  ('app.legacy_compatibility_settings', 'm3', 'durable-account-lifetime', true,
   'account_id', '{source_account_id}', 'cascade', 'account_export',
   'Exact rollback compatibility state; normalized current state remains authoritative.');


insert into supabase_migrations.schema_migrations(version,name,statements) values('20260914101424','m3_real_preflight_evidence',array['-- M3 real-preflight durable evidence correction. PREPARED LOCALLY, NOT APPLIED.
-- Keeps six measured legacy records without changing current vault, pin,
-- snooze, activity, family-access, or recommendation authority.

begin;

create table app.family_access_legacy_measurements (
  source_library_id uuid primary key,
  account_id integer not null references app.accounts(id) on delete cascade,
  game_id integer references catalog.games(id) on delete set null,
  steam_app_id bigint not null check (steam_app_id between 1 and 4294967295),
  subject_attribution text not null default ''unknown''
    check (subject_attribution = ''unknown''),
  observed_playtime_minutes integer
    check (observed_playtime_minutes is null or observed_playtime_minutes >= 0),
  last_played_at timestamptz,
  last_observed_played_at timestamptz,
  recency_source text check (
    recency_source is null or length(btrim(recency_source)) between 1 and 120
  ),
  recency_evidence_at timestamptz,
  family_owner_steam_id text check (
    family_owner_steam_id is null or length(family_owner_steam_id) <= 200
  ),
  family_verified_at timestamptz,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  check (observed_playtime_minutes is not null
      or last_played_at is not null
      or last_observed_played_at is not null
      or recency_source is not null
      or recency_evidence_at is not null)
);

comment on table app.family_access_legacy_measurements is
  ''Exact legacy family-access observation evidence whose human subject is unknown. ''
  ''It never feeds current access, personal game activity, or recommendation state.'';
comment on column app.family_access_legacy_measurements.family_owner_steam_id is
  ''Verbatim legacy lender provenance; it does not identify the subject of the measurement.'';

create index family_access_legacy_measurements_account_idx
  on app.family_access_legacy_measurements (account_id, steam_app_id);

create table app.legacy_compatibility_settings (
  source_setting_id uuid primary key,
  account_id integer not null references app.accounts(id) on delete cascade,
  source_account_id uuid not null,
  setting_key text not null check (setting_key in (
    ''vault_current_pick_id'', ''vault_snoozed_ids'', ''wishlist_pinned_ids''
  )),
  value text not null,
  source_created_at timestamptz not null,
  source_updated_at timestamptz not null,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  unique (source_account_id, setting_key),
  check (source_updated_at >= source_created_at)
);

comment on table app.legacy_compatibility_settings is
  ''Exact one-release rollback compatibility state. Normalized vault, snooze, and pin ''
  ''relations remain current authority; these values are never runtime preferences.'';

create index legacy_compatibility_settings_account_idx
  on app.legacy_compatibility_settings (account_id, setting_key);

alter table app.family_access_legacy_measurements enable row level security;
alter table app.family_access_legacy_measurements force row level security;
alter table app.legacy_compatibility_settings enable row level security;
alter table app.legacy_compatibility_settings force row level security;

-- Owner/operator only. Account export remains behind the established operator
-- boundary; browser and runtime roles receive no direct table capability.
revoke all on app.family_access_legacy_measurements from public, vault_app, vault_worker;
revoke all on app.legacy_compatibility_settings from public, vault_app, vault_worker;

do $$
begin
  if to_regrole(''anon'') is not null then
    revoke all on app.family_access_legacy_measurements from anon;
    revoke all on app.legacy_compatibility_settings from anon;
  end if;
  if to_regrole(''authenticated'') is not null then
    revoke all on app.family_access_legacy_measurements from authenticated;
    revoke all on app.legacy_compatibility_settings from authenticated;
  end if;
end $$;

insert into ops.data_retention_registry
  (relation, introduced_in, retention_class, holds_personal_data,
   account_fk_column, account_uuid_columns, deletion_mode, export_scope, rationale)
values
  (''app.family_access_legacy_measurements'', ''m3'', ''durable-account-lifetime'', true,
   ''account_id'', ''{}'', ''cascade'', ''account_export'',
   ''Unknown-subject family observation evidence; never active personal playtime or access.''),
  (''app.legacy_compatibility_settings'', ''m3'', ''durable-account-lifetime'', true,
   ''account_id'', ''{source_account_id}'', ''cascade'', ''account_export'',
   ''Exact rollback compatibility state; normalized current state remains authoritative.'');

commit;
']::text[]);

-- Apply 20260929200758_m3_wishlist_preservation.sql SHA256 5f79b9c4aca35387b48d9f2bec53014340f93dca688ae6993dc1ffa4fabc9af0
-- Current saved Wishlist: independent of Library lifecycle and catalogue presence.
-- Additive to the five immutable applied migrations; local preparation only.

create table app.wishlist_games (
  account_id integer not null references app.accounts(id) on delete cascade,
  steam_app_id bigint not null check (steam_app_id between 1 and 4294967295),
  source text not null default 'local' check (source in ('local', 'steam')),
  added_at timestamptz not null default now(),
  primary key (account_id, steam_app_id)
);
create index wishlist_games_added_idx
  on app.wishlist_games (account_id, added_at desc, steam_app_id);
comment on table app.wishlist_games is
  'Saved purchase intent. AppID may be absent from catalogue and Library; no ownership/state dependency.';

alter table app.wishlist_games enable row level security;
alter table app.wishlist_games force row level security;
create policy tenant_isolation on app.wishlist_games for all to vault_app
  using (account_id = app.current_account_id())
  with check (account_id = app.current_account_id());
revoke all on app.wishlist_games from public, vault_app, vault_worker;
grant select, insert, delete on app.wishlist_games to vault_app;
-- Save/import uses ON CONFLICT DO NOTHING, so existing source/added_at are immutable
-- through the runtime role. Removal and a later save create a new ordinary entry.
do $$
begin
  if to_regrole('anon') is not null then revoke all on app.wishlist_games from anon; end if;
  if to_regrole('authenticated') is not null then revoke all on app.wishlist_games from authenticated; end if;
end $$;

insert into ops.data_retention_registry
  (relation, introduced_in, retention_class, holds_personal_data,
   account_fk_column, account_uuid_columns, deletion_mode, export_scope, rationale)
values
  ('app.wishlist_games', 'm3', 'durable-account-lifetime', true,
   'account_id', '{}', 'cascade', 'account_export',
   'Current saved Wishlist, including unavailable and unreleased AppIDs; deleted with its account.');


insert into supabase_migrations.schema_migrations(version,name,statements) values('20260929200758','m3_wishlist_preservation',array['-- Current saved Wishlist: independent of Library lifecycle and catalogue presence.
-- Additive to the five immutable applied migrations; local preparation only.
begin;

create table app.wishlist_games (
  account_id integer not null references app.accounts(id) on delete cascade,
  steam_app_id bigint not null check (steam_app_id between 1 and 4294967295),
  source text not null default ''local'' check (source in (''local'', ''steam'')),
  added_at timestamptz not null default now(),
  primary key (account_id, steam_app_id)
);
create index wishlist_games_added_idx
  on app.wishlist_games (account_id, added_at desc, steam_app_id);
comment on table app.wishlist_games is
  ''Saved purchase intent. AppID may be absent from catalogue and Library; no ownership/state dependency.'';

alter table app.wishlist_games enable row level security;
alter table app.wishlist_games force row level security;
create policy tenant_isolation on app.wishlist_games for all to vault_app
  using (account_id = app.current_account_id())
  with check (account_id = app.current_account_id());
revoke all on app.wishlist_games from public, vault_app, vault_worker;
grant select, insert, delete on app.wishlist_games to vault_app;
-- Save/import uses ON CONFLICT DO NOTHING, so existing source/added_at are immutable
-- through the runtime role. Removal and a later save create a new ordinary entry.
do $$
begin
  if to_regrole(''anon'') is not null then revoke all on app.wishlist_games from anon; end if;
  if to_regrole(''authenticated'') is not null then revoke all on app.wishlist_games from authenticated; end if;
end $$;

insert into ops.data_retention_registry
  (relation, introduced_in, retention_class, holds_personal_data,
   account_fk_column, account_uuid_columns, deletion_mode, export_scope, rationale)
values
  (''app.wishlist_games'', ''m3'', ''durable-account-lifetime'', true,
   ''account_id'', ''{}'', ''cascade'', ''account_export'',
   ''Current saved Wishlist, including unavailable and unreleased AppIDs; deleted with its account.'');

commit;
']::text[]);

-- Apply 20260929204123_m3_hltb_only.sql SHA256 34011be01a7a5449d7196f41bb7cc192c982213db6347ac37fb9a585fcdd9a5f
-- HLTB is the only duration provider. No new state or provider archive.
-- Applied migrations remain immutable; this correction is additive.

-- An authored override remains an authored fact even if its old provenance
-- named IGDB. Strip that obsolete identity without relabelling it as HLTB.
update catalog.game_features
set duration_source = case when duration_manual_override then 'manual' else null end,
    duration_source_game_id = null, duration_source_updated_at = null,
    duration_confidence = null, duration_confidence_label = null,
    main_duration_minutes = case when duration_manual_override then main_duration_minutes end,
    extras_duration_minutes = case when duration_manual_override then extras_duration_minutes end,
    completion_duration_minutes = case when duration_manual_override then completion_duration_minutes end,
    duration_kind = case when duration_manual_override then duration_kind else 'unknown' end,
    duration_status = case when duration_manual_override then duration_status else 'unknown' end
where duration_source ~* 'igdb';
update catalog.game_features
set popularity_source = null, popularity_metric = null, popularity_rank = null,
    popularity_low = null, popularity_high = null, popularity_ccu = null,
    popularity_observed_on = null, source_captured_on = null
where popularity_source ~* 'igdb';

-- The legacy duration queue never recorded its provider. Its failures and
-- backoff cannot safely govern HLTB. Rebuild work from the remaining evidence.
delete from catalog.provider_state where provider ~* 'igdb' or (evidence_kind = 'duration' and provider = 'unknown');
delete from catalog.appid_terminal_rejections where provider ~* 'igdb' or (evidence_kind = 'duration' and provider = 'unknown');
delete from migration.legacy_duration_job_archive;
delete from catalog.duration_estimates where provider ~* 'igdb';
delete from catalog.duration_imports where source ~* 'igdb';

alter table catalog.duration_estimates add constraint duration_estimates_hltb_only check (provider = 'hltb');
alter table catalog.duration_imports add constraint duration_imports_no_igdb check (source !~* 'igdb');
alter table catalog.provider_state add constraint provider_state_no_igdb check (provider !~* 'igdb');
alter table catalog.appid_terminal_rejections add constraint terminal_rejections_no_igdb check (provider !~* 'igdb');
alter table catalog.game_features
  add constraint game_features_duration_no_igdb check (duration_source is null or duration_source !~* 'igdb'),
  add constraint game_features_popularity_no_igdb check (popularity_source is null or popularity_source !~* 'igdb');

-- Mirrors the existing reviewed HLTB writeback's finite eligibility rules.
-- Stored but rejected evidence is useful for HLTB review, never a ready value.
create function catalog.hltb_estimate_is_eligible(e catalog.duration_estimates)
returns boolean language sql immutable security invoker
set search_path = pg_catalog, catalog
as $$
  select coalesce(
    e.provider = 'hltb' and e.match_status = 'matched' and e.provider_game_id > 0
    and e.evidence @> '{"identity_validated":true}'::jsonb
    and ((e.evidence->>'verification_method' = 'profile_steam_exact' and e.evidence->>'verification_tier' = 'steam_appid')
      or (e.evidence->>'verification_method' in ('safe_exact_title','safe_exact_alias')
        and e.evidence->>'verification_tier' in ('exact_title','mixed_script_title')))
    and (e.match_confidence in ('medium','high') or (
      e.match_confidence = 'low'
      and e.evidence->>'verification_method' = 'profile_steam_exact'
      and e.evidence->>'verification_tier' = 'steam_appid'
      and e.evidence->>'duration_basis' = 'completion_times'
      and e.evidence->'duration_issues' = '[]'::jsonb
      and (coalesce(e.submission_count,0) >= 2 or
        ((e.main_story_minutes is not null)::int + (e.main_extra_minutes is not null)::int
          + (e.completionist_minutes is not null)::int) >= 2)))
    and (e.main_story_minutes > 0 or e.main_extra_minutes > 0 or e.completionist_minutes > 0)
    and (e.main_story_minutes is null or e.main_story_minutes between 1 and 120000)
    and (e.main_extra_minutes is null or e.main_extra_minutes between 1 and 120000)
    and (e.completionist_minutes is null or e.completionist_minutes between 1 and 120000)
    and (e.main_story_minutes is null or e.main_extra_minutes is null or e.main_extra_minutes >= e.main_story_minutes)
    and (e.completionist_minutes is null or coalesce(e.main_extra_minutes,e.main_story_minutes) is null
      or e.completionist_minutes >= coalesce(e.main_extra_minutes,e.main_story_minutes))
    and (e.main_story_minutes is null or e.completionist_minutes is null
      or e.completionist_minutes::bigint < e.main_story_minutes::bigint * 12), false);
$$;

-- Operator-only, explicit reconciliation after an HLTB writeback, in that
-- same transaction. No definer privileges, hosted worker or automatic timer.
create function catalog.reconcile_hltb_duration(p_game_id integer)
returns void language sql security invoker
set search_path = pg_catalog, catalog
as $$
  with candidate as (
    select e.*, catalog.hltb_estimate_is_eligible(e) as eligible
    from catalog.games g
    left join catalog.duration_estimates e on e.steam_app_id = g.steam_app_id and e.provider = 'hltb'
      and (e.game_id is null or e.game_id = g.id)
    where g.id = p_game_id
  )
  update catalog.game_features f
  set main_duration_minutes = case when c.eligible then c.main_story_minutes end,
      extras_duration_minutes = case when c.eligible then c.main_extra_minutes end,
      completion_duration_minutes = case when c.eligible then c.completionist_minutes end,
      duration_source = case when c.eligible then 'hltb' end,
      duration_source_game_id = case when c.eligible then c.provider_game_id end,
      duration_source_updated_at = case when c.eligible then c.provider_updated_at end,
      duration_confidence = null,
      duration_confidence_label = case when c.eligible then c.match_confidence end,
      duration_status = case when c.eligible then 'ready' when c.provider is not null then 'review_required' else 'unknown' end,
      duration_kind = case when c.eligible then 'finite' else 'unknown' end
  from candidate c
  where f.game_id = p_game_id and not f.duration_manual_override
    and f.duration_kind not in ('endless','not-applicable');
$$;
revoke all on function catalog.hltb_estimate_is_eligible(catalog.duration_estimates) from public, vault_app, vault_worker;
revoke all on function catalog.reconcile_hltb_duration(integer) from public, vault_app, vault_worker;

-- Rebuild existing automatic finite projections; manual and independent
-- nonfinite decisions are intentionally preserved.
select catalog.reconcile_hltb_duration(game_id) from catalog.game_features
where not duration_manual_override and duration_kind not in ('endless','not-applicable');

update ops.data_retention_registry
set rationale = 'HLTB observations only. Rejected HLTB evidence is retained for review; obsolete IGDB payloads are discarded.'
where relation = 'catalog.duration_estimates'::regclass;
update ops.data_retention_registry
set rationale = 'Obsolete unattributed duration retry queue is rebuilt; no legacy rows are loaded or retained.'
where relation = 'migration.legacy_duration_job_archive'::regclass;


insert into supabase_migrations.schema_migrations(version,name,statements) values('20260929204123','m3_hltb_only',array['-- HLTB is the only duration provider. No new state or provider archive.
-- Applied migrations remain immutable; this correction is additive.
begin;

-- An authored override remains an authored fact even if its old provenance
-- named IGDB. Strip that obsolete identity without relabelling it as HLTB.
update catalog.game_features
set duration_source = case when duration_manual_override then ''manual'' else null end,
    duration_source_game_id = null, duration_source_updated_at = null,
    duration_confidence = null, duration_confidence_label = null,
    main_duration_minutes = case when duration_manual_override then main_duration_minutes end,
    extras_duration_minutes = case when duration_manual_override then extras_duration_minutes end,
    completion_duration_minutes = case when duration_manual_override then completion_duration_minutes end,
    duration_kind = case when duration_manual_override then duration_kind else ''unknown'' end,
    duration_status = case when duration_manual_override then duration_status else ''unknown'' end
where duration_source ~* ''igdb'';
update catalog.game_features
set popularity_source = null, popularity_metric = null, popularity_rank = null,
    popularity_low = null, popularity_high = null, popularity_ccu = null,
    popularity_observed_on = null, source_captured_on = null
where popularity_source ~* ''igdb'';

-- The legacy duration queue never recorded its provider. Its failures and
-- backoff cannot safely govern HLTB. Rebuild work from the remaining evidence.
delete from catalog.provider_state where provider ~* ''igdb'' or (evidence_kind = ''duration'' and provider = ''unknown'');
delete from catalog.appid_terminal_rejections where provider ~* ''igdb'' or (evidence_kind = ''duration'' and provider = ''unknown'');
delete from migration.legacy_duration_job_archive;
delete from catalog.duration_estimates where provider ~* ''igdb'';
delete from catalog.duration_imports where source ~* ''igdb'';

alter table catalog.duration_estimates add constraint duration_estimates_hltb_only check (provider = ''hltb'');
alter table catalog.duration_imports add constraint duration_imports_no_igdb check (source !~* ''igdb'');
alter table catalog.provider_state add constraint provider_state_no_igdb check (provider !~* ''igdb'');
alter table catalog.appid_terminal_rejections add constraint terminal_rejections_no_igdb check (provider !~* ''igdb'');
alter table catalog.game_features
  add constraint game_features_duration_no_igdb check (duration_source is null or duration_source !~* ''igdb''),
  add constraint game_features_popularity_no_igdb check (popularity_source is null or popularity_source !~* ''igdb'');

-- Mirrors the existing reviewed HLTB writeback''s finite eligibility rules.
-- Stored but rejected evidence is useful for HLTB review, never a ready value.
create function catalog.hltb_estimate_is_eligible(e catalog.duration_estimates)
returns boolean language sql immutable security invoker
set search_path = pg_catalog, catalog
as $$
  select coalesce(
    e.provider = ''hltb'' and e.match_status = ''matched'' and e.provider_game_id > 0
    and e.evidence @> ''{"identity_validated":true}''::jsonb
    and ((e.evidence->>''verification_method'' = ''profile_steam_exact'' and e.evidence->>''verification_tier'' = ''steam_appid'')
      or (e.evidence->>''verification_method'' in (''safe_exact_title'',''safe_exact_alias'')
        and e.evidence->>''verification_tier'' in (''exact_title'',''mixed_script_title'')))
    and (e.match_confidence in (''medium'',''high'') or (
      e.match_confidence = ''low''
      and e.evidence->>''verification_method'' = ''profile_steam_exact''
      and e.evidence->>''verification_tier'' = ''steam_appid''
      and e.evidence->>''duration_basis'' = ''completion_times''
      and e.evidence->''duration_issues'' = ''[]''::jsonb
      and (coalesce(e.submission_count,0) >= 2 or
        ((e.main_story_minutes is not null)::int + (e.main_extra_minutes is not null)::int
          + (e.completionist_minutes is not null)::int) >= 2)))
    and (e.main_story_minutes > 0 or e.main_extra_minutes > 0 or e.completionist_minutes > 0)
    and (e.main_story_minutes is null or e.main_story_minutes between 1 and 120000)
    and (e.main_extra_minutes is null or e.main_extra_minutes between 1 and 120000)
    and (e.completionist_minutes is null or e.completionist_minutes between 1 and 120000)
    and (e.main_story_minutes is null or e.main_extra_minutes is null or e.main_extra_minutes >= e.main_story_minutes)
    and (e.completionist_minutes is null or coalesce(e.main_extra_minutes,e.main_story_minutes) is null
      or e.completionist_minutes >= coalesce(e.main_extra_minutes,e.main_story_minutes))
    and (e.main_story_minutes is null or e.completionist_minutes is null
      or e.completionist_minutes::bigint < e.main_story_minutes::bigint * 12), false);
$$;

-- Operator-only, explicit reconciliation after an HLTB writeback, in that
-- same transaction. No definer privileges, hosted worker or automatic timer.
create function catalog.reconcile_hltb_duration(p_game_id integer)
returns void language sql security invoker
set search_path = pg_catalog, catalog
as $$
  with candidate as (
    select e.*, catalog.hltb_estimate_is_eligible(e) as eligible
    from catalog.games g
    left join catalog.duration_estimates e on e.steam_app_id = g.steam_app_id and e.provider = ''hltb''
      and (e.game_id is null or e.game_id = g.id)
    where g.id = p_game_id
  )
  update catalog.game_features f
  set main_duration_minutes = case when c.eligible then c.main_story_minutes end,
      extras_duration_minutes = case when c.eligible then c.main_extra_minutes end,
      completion_duration_minutes = case when c.eligible then c.completionist_minutes end,
      duration_source = case when c.eligible then ''hltb'' end,
      duration_source_game_id = case when c.eligible then c.provider_game_id end,
      duration_source_updated_at = case when c.eligible then c.provider_updated_at end,
      duration_confidence = null,
      duration_confidence_label = case when c.eligible then c.match_confidence end,
      duration_status = case when c.eligible then ''ready'' when c.provider is not null then ''review_required'' else ''unknown'' end,
      duration_kind = case when c.eligible then ''finite'' else ''unknown'' end
  from candidate c
  where f.game_id = p_game_id and not f.duration_manual_override
    and f.duration_kind not in (''endless'',''not-applicable'');
$$;
revoke all on function catalog.hltb_estimate_is_eligible(catalog.duration_estimates) from public, vault_app, vault_worker;
revoke all on function catalog.reconcile_hltb_duration(integer) from public, vault_app, vault_worker;

-- Rebuild existing automatic finite projections; manual and independent
-- nonfinite decisions are intentionally preserved.
select catalog.reconcile_hltb_duration(game_id) from catalog.game_features
where not duration_manual_override and duration_kind not in (''endless'',''not-applicable'');

update ops.data_retention_registry
set rationale = ''HLTB observations only. Rejected HLTB evidence is retained for review; obsolete IGDB payloads are discarded.''
where relation = ''catalog.duration_estimates''::regclass;
update ops.data_retention_registry
set rationale = ''Obsolete unattributed duration retry queue is rebuilt; no legacy rows are loaded or retained.''
where relation = ''migration.legacy_duration_job_archive''::regclass;
commit;
']::text[]);

-- Apply 20260929210421_m3_current_catalogue_fields.sql SHA256 e913a0fa00bf60e28294a4824e4314b17e001118735d4fcda24bb94a91235450
-- Current source catalogue fields; no additional feature/state system.

alter table catalog.game_features
  add column player_mode text check (player_mode is null or player_mode in ('single','coop','multi')),
  add column store_tags_checked_at timestamptz,
  add column store_tags_state text check (store_tags_state is null or length(store_tags_state) <= 120);
comment on column catalog.game_features.player_mode is 'Existing Steam signal classification; NULL remains unclassified.';
comment on column catalog.game_features.store_tags_checked_at is 'Exact last Steam Store tag check instant, separate from generic tag fetch state.';
comment on column catalog.game_features.store_tags_state is 'Existing Store check verdict preserved independently from generic tag lifecycle.';
-- Vault events already store bounded text: play_now_intent needs no new state,
-- table or enum migration. The current transform preserves it verbatim.


insert into supabase_migrations.schema_migrations(version,name,statements) values('20260929210421','m3_current_catalogue_fields',array['-- Current source catalogue fields; no additional feature/state system.
begin;
alter table catalog.game_features
  add column player_mode text check (player_mode is null or player_mode in (''single'',''coop'',''multi'')),
  add column store_tags_checked_at timestamptz,
  add column store_tags_state text check (store_tags_state is null or length(store_tags_state) <= 120);
comment on column catalog.game_features.player_mode is ''Existing Steam signal classification; NULL remains unclassified.'';
comment on column catalog.game_features.store_tags_checked_at is ''Exact last Steam Store tag check instant, separate from generic tag fetch state.'';
comment on column catalog.game_features.store_tags_state is ''Existing Store check verdict preserved independently from generic tag lifecycle.'';
-- Vault events already store bounded text: play_now_intent needs no new state,
-- table or enum migration. The current transform preserves it verbatim.
commit;
']::text[]);

do $verify$ declare actual text; begin select schema_fingerprint into actual from (with requested(name) as (values ('app.account_capabilities'),('app.account_capability_evidence'),('app.account_preferences'),('app.accounts'),('app.collection_games'),('app.collections'),('app.completion_event_registry'),('app.completion_events'),('app.family_access_legacy_measurements'),('app.family_access_orphans'),('app.family_game_access'),('app.family_members'),('app.game_activity'),('app.game_state'),('app.game_state_legacy_measurements'),('app.legacy_compatibility_settings'),('app.library_games'),('app.library_legacy_measurements'),('app.pins'),('app.playtime_daily'),('app.purge_review_history'),('app.retired_library_games'),('app.sessions'),('app.snoozes'),('app.steam_profiles'),('app.unknown_completion_history'),('app.vault_draw_events'),('app.vault_draws'),('app.vault_events'),('app.vault_state'),('app.wishlist_games'),('catalog.appid_terminal_rejections'),('catalog.duration_aliases'),('catalog.duration_estimates'),('catalog.duration_imports'),('catalog.game_features'),('catalog.game_metadata'),('catalog.game_sightings'),('catalog.games'),('catalog.offer_prices'),('catalog.offers'),('catalog.provider_state'),('catalog.review_decisions'),('catalog.seed_runs'),('migration.account_map'),('migration.collection_map'),('migration.legacy_account_merge_audit'),('migration.legacy_account_preferences_evidence'),('migration.legacy_auth_intent_audit'),('migration.legacy_collection_membership_evidence'),('migration.legacy_duration_job_archive'),('migration.legacy_family_access_orphans'),('migration.legacy_family_member_evidence'),('migration.legacy_import_freeze_report'),('migration.legacy_ingest_queue_archive'),('migration.legacy_library_evidence'),('migration.legacy_purge_review_archive'),('migration.legacy_user_game_state_audit'),('migration.library_row_map'),('migration.session_map'),('ops.abuse_cooldowns'),('ops.account_aliases'),('ops.account_merges'),('ops.legacy_worker_runs'),('reco.game_preference_globals'),('reco.genre_preference_globals'),('reco.operator_weight_versions'),('reco.user_genre_preferences'),('reco.warm_start_snapshots'),('support.contact_messages'),('support.feedback_submissions'),('support.retention_policy_decisions')), signatures as (select r.name,coalesce(string_agg(case when c.column_name is not null then format('%s.%s|%s|%s|%s',c.table_schema,c.table_name,c.column_name,c.data_type,c.is_nullable) end,E'\n' order by c.column_name collate "C"),r.name||'|<missing>') as signature from requested r left join information_schema.columns c on c.table_schema||'.'||c.table_name=r.name group by r.name) select encode(sha256(convert_to(string_agg(signature,E'\n' order by name collate "C"),'UTF8')),'hex') as schema_fingerprint from signatures) q; if actual<>'34ea7355f8d2ee4881e6907b310bae88f9d2ab198d99463acfb7a72f0c65e8bc' then raise exception 'Post-migration fingerprint mismatch'; end if; if (select count(*) from supabase_migrations.schema_migrations)<>11 then raise exception 'Migration ledger mismatch'; end if; end $verify$;
commit;
select version,name from supabase_migrations.schema_migrations order by version;
