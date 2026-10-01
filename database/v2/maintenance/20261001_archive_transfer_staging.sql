-- One-off operator maintenance: archive verified locally before early removal.
-- Never apply as a schema migration. Applied migrations remain immutable.
-- Required psql inputs: archive_sha256 and archive_fingerprints (JSON array of
-- relation/rows/sha256 from the verified, restored local archive).
-- No CASCADE, no identity reset, no live-domain table deletion.
\set ON_ERROR_STOP on
begin;
set local lock_timeout = '3s';
set local statement_timeout = '90s';
set local timezone = 'UTC';
set local datestyle = 'ISO, YMD';
create temporary table cleanup_archive on commit drop as
  select * from jsonb_to_recordset(:'archive_fingerprints'::jsonb)
    as x(relation text, rows bigint, sha256 text);
create temporary table cleanup_archive_identity on commit drop as
  select :'archive_sha256'::text as sha256;

-- Lock only the explicitly retired transfer tables. Unexpected live references
-- or a changed source snapshot cause rollback rather than widening the scope.
lock table
  migration.account_map,
  migration.collection_map,
  migration.game_map,
  migration.legacy_account_merge_audit,
  migration.legacy_account_preferences_evidence,
  migration.legacy_auth_intent_audit,
  migration.legacy_collection_membership_evidence,
  migration.legacy_duration_job_archive,
  migration.legacy_family_access_orphans,
  migration.legacy_family_member_evidence,
  migration.legacy_import_freeze_report,
  migration.legacy_ingest_queue_archive,
  migration.legacy_library_evidence,
  migration.legacy_manual_session_audit,
  migration.legacy_purge_review_archive,
  migration.legacy_user_game_state_audit,
  migration.library_row_map,
  migration.session_map
in access exclusive mode;

do $cleanup$
declare
  expected text[] := array[
    'migration.account_map',
    'migration.collection_map',
    'migration.game_map',
    'migration.legacy_account_merge_audit',
    'migration.legacy_account_preferences_evidence',
    'migration.legacy_auth_intent_audit',
    'migration.legacy_collection_membership_evidence',
    'migration.legacy_duration_job_archive',
    'migration.legacy_family_access_orphans',
    'migration.legacy_family_member_evidence',
    'migration.legacy_import_freeze_report',
    'migration.legacy_ingest_queue_archive',
    'migration.legacy_library_evidence',
    'migration.legacy_manual_session_audit',
    'migration.legacy_purge_review_archive',
    'migration.legacy_user_game_state_audit',
    'migration.library_row_map',
    'migration.session_map'
  ];
  actual text[];
  archived record;
  actual_rows bigint;
  actual_hash text;
begin
  if (select expected_project_ref from ops.project_marker where marker)
       is distinct from 'vbjtbwelnhbbdfrqczyf'
     or not exists (select 1 from migration.cutover_state
                    where singleton and validated_cutover_at is not null)
     or not exists (select 1 from supabase_migrations.schema_migrations
                    where version = '20261001103901') then
    raise exception 'Refusing cleanup outside accepted production V2';
  end if;
  if (select sha256 from cleanup_archive_identity) !~ '^[0-9a-f]{64}$'
     or (select count(*) from cleanup_archive) <> 18
     or exists (select 1 from cleanup_archive
                where rows is null or rows < 0 or sha256 is null
                   or sha256 !~ '^[0-9a-f]{64}$') then
    raise exception 'Verified archive identity/fingerprints are required';
  end if;
  select array_agg(relation order by relation) into actual from cleanup_archive;
  if actual is distinct from expected then
    raise exception 'Archive must cover the exact retired transfer allowlist';
  end if;
  select array_agg(r.relation::text order by r.relation::text) into actual
    from ops.data_retention_registry r
    join ops.retention_classes c using (retention_class)
   where c.scope = 'migration_staging';
  if actual is distinct from expected then
    raise exception 'Staging registry changed; review before cleanup';
  end if;
  if exists (select 1 from migration.retention_holds
              where released_at is null and expires_at > clock_timestamp()
                and relation::text = any(expected)) then
    raise exception 'Active recovery hold prevents staging cleanup';
  end if;
  if exists (select 1 from pg_constraint
              where contype = 'f' and confrelid::regclass::text = any(expected)
                and not conrelid::regclass::text = any(expected)) then
    raise exception 'A retained table references staging; refusing cascade';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname in ('app','catalog','ops','reco','support')
                and p.prosrc ~* 'migration[.]') then
    raise exception 'Live function references migration data; review required';
  end if;
  if exists (select 1 from pg_depend d
              join pg_rewrite rw on rw.oid = d.objid
              join pg_class v on v.oid = rw.ev_class
              join pg_namespace n on n.oid = v.relnamespace
              where d.classid = 'pg_rewrite'::regclass
                and d.refclassid = 'pg_class'::regclass
                and d.refobjid::regclass::text = any(expected)
                and n.nspname <> 'migration') then
    raise exception 'A retained view depends on staging; review required';
  end if;
  if exists (select 1 from pg_trigger
              where not tgisinternal and tgrelid::regclass::text = any(expected)) then
    raise exception 'Unexpected staging trigger; review required';
  end if;
  for archived in select * from cleanup_archive order by relation loop
    execute format(
      $fingerprint$with hashes as (
        select encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') h from %s t
      ) select count(*), encode(sha256(convert_to(
          coalesce(string_agg(h,'' order by h collate "C"),''),'UTF8')),'hex') from hashes$fingerprint$,
      archived.relation)
      into actual_rows, actual_hash;
    if actual_rows <> archived.rows or actual_hash <> archived.sha256 then
      raise exception 'Staging changed after archive: %', archived.relation;
    end if;
  end loop;
end
$cleanup$;

truncate table
  migration.account_map,
  migration.collection_map,
  migration.game_map,
  migration.legacy_account_merge_audit,
  migration.legacy_account_preferences_evidence,
  migration.legacy_auth_intent_audit,
  migration.legacy_collection_membership_evidence,
  migration.legacy_duration_job_archive,
  migration.legacy_family_access_orphans,
  migration.legacy_family_member_evidence,
  migration.legacy_import_freeze_report,
  migration.legacy_ingest_queue_archive,
  migration.legacy_library_evidence,
  migration.legacy_manual_session_audit,
  migration.legacy_purge_review_archive,
  migration.legacy_user_game_state_audit,
  migration.library_row_map,
  migration.session_map
continue identity;

-- Use the existing cutover note; no new event/history/state machinery.
update migration.cutover_state
   set notes = coalesce(notes, '') || E'\nUser-approved early staging archive and purge on '
               || clock_timestamp()::text || '; local restore-verified archive SHA256 '
               || (select sha256 from cleanup_archive_identity)
               || '; 18 transfer relations; no live-domain data removed.',
       updated_at = clock_timestamp()
 where singleton;

select jsonb_build_object('status','archived-and-cleared',
  'archive_sha256',(select sha256 from cleanup_archive_identity),
  'relations',18,'archived_rows',(select sum(rows) from cleanup_archive),
  'completed_at',clock_timestamp());
commit;

select jsonb_build_object('database_bytes',pg_database_size(current_database()),
  'staging_bytes',(select sum(pg_total_relation_size(relation))
                    from ops.data_retention_registry r
                    join ops.retention_classes c using(retention_class)
                   where c.scope='migration_staging'));
