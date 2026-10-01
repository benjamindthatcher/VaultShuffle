-- One-off physical maintenance after the bulk catalogue refresh.
-- Run as the existing V2 operator, outside a transaction. No schema migration,
-- content rewrite, deletion, compression change or runtime grant change.
-- VACUUM FULL briefly locks this table; abort rather than waiting on busy work.
\set ON_ERROR_STOP on
set lock_timeout = '3s';
set statement_timeout = '45s';
set timezone = 'UTC';
set datestyle = 'ISO, YMD';

do $$
begin
  if (select expected_project_ref from ops.project_marker where marker)
      is distinct from 'vbjtbwelnhbbdfrqczyf'
      or not exists (select 1 from supabase_migrations.schema_migrations
        where version = '20261001173003') then
    raise exception 'Expected production V2 with restored quarantine';
  end if;
  if pg_total_relation_size('catalog.game_metadata') > 134217728 then
    raise exception 'Metadata has grown beyond the measured maintenance scope';
  end if;
end $$;

-- Session-local proof only. Neither this helper nor its receipt is persisted
-- in the database. Normal concurrent writes may change the data fingerprint;
-- report that honestly rather than treating them as a compaction mutation.
create function pg_temp.metadata_compaction_snapshot()
returns jsonb language sql stable set search_path = pg_catalog as $$
  select jsonb_build_object(
    'database_bytes', pg_database_size(current_database()),
    'table_bytes', pg_total_relation_size('catalog.game_metadata'),
    'rows', (select count(*) from catalog.game_metadata),
    'sha256', (select encode(sha256(convert_to(
      coalesce(string_agg(h, '' order by h collate "C"), ''), 'UTF8')), 'hex')
      from (select encode(sha256(convert_to(row_to_json(m)::text, 'UTF8')), 'hex') h
        from catalog.game_metadata m) hashes),
    'security', (select jsonb_build_object('oid', oid, 'owner', relowner,
      'acl', relacl::text, 'rls', relrowsecurity, 'forced_rls', relforcerowsecurity,
      'options', reloptions) from pg_class where oid='catalog.game_metadata'::regclass),
    'columns', (select jsonb_agg(jsonb_build_object('name',attname,
      'type',atttypid,'modifier',atttypmod,'storage',attstorage,
      'compression',attcompression,'not_null',attnotnull) order by attnum)
      from pg_attribute where attrelid='catalog.game_metadata'::regclass
        and attnum>0 and not attisdropped),
    'constraints', (select jsonb_agg(jsonb_build_object('name',conname,
      'definition',pg_get_constraintdef(oid),'validated',convalidated) order by conname)
      from pg_constraint where conrelid='catalog.game_metadata'::regclass),
    'policies', (select jsonb_agg(to_jsonb(p) order by policyname)
      from pg_policies p where schemaname='catalog' and tablename='game_metadata'),
    'recorded_at', clock_timestamp()
  )
$$;
create temporary table metadata_compaction_before as
  select pg_temp.metadata_compaction_snapshot() snapshot;
select jsonb_build_object('kind','metadata_before','snapshot',snapshot)
  from metadata_compaction_before;

vacuum (full, analyze) catalog.game_metadata;

create temporary table metadata_compaction_after as
  select pg_temp.metadata_compaction_snapshot() snapshot;
do $$
declare v_before jsonb; v_after jsonb;
begin
  select snapshot into v_before from pg_temp.metadata_compaction_before;
  select snapshot into v_after from pg_temp.metadata_compaction_after;
  if (v_before - array['database_bytes','table_bytes','rows','sha256','recorded_at'])
      is distinct from
      (v_after - array['database_bytes','table_bytes','rows','sha256','recorded_at']) then
    raise exception 'Metadata schema/access proof differs; investigate';
  end if;
end $$;
select jsonb_build_object('kind','metadata_compaction',
  'before',b.snapshot,'after',a.snapshot,
  'values_exact',b.snapshot->'rows'=a.snapshot->'rows'
    and b.snapshot->'sha256'=a.snapshot->'sha256',
  'table_reclaimed_bytes',(b.snapshot->>'table_bytes')::bigint-(a.snapshot->>'table_bytes')::bigint,
  'database_reclaimed_bytes',(b.snapshot->>'database_bytes')::bigint-(a.snapshot->>'database_bytes')::bigint,
  'schema_and_access_unchanged',true)
from metadata_compaction_before b cross join metadata_compaction_after a;
