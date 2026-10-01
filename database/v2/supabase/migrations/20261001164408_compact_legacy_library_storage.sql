-- Keep the existing Library Added reads and owner-scoped access unchanged.
-- Before applying to populated data, the operator must archive BOTH full
-- legacy relations, actually restore them locally, and supply that archive's
-- fingerprints through transaction-local vaultshuffle.legacy_archive_* settings.
-- Empty installations need no archive. Applied historical SQL stays immutable.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '90s';
set local timezone = 'UTC';
set local datestyle = 'ISO, YMD';

lock table app.library_legacy_measurements,
  app.game_state_legacy_measurements in access exclusive mode;

do $$
declare
  relation_name text;
  actual_count bigint;
  actual_hash text;
  archived jsonb;
  expected jsonb;
begin
  if exists (select 1 from migration.retention_holds
      where released_at is null and expires_at > now()) then
    raise exception 'Active preservation hold; legacy compaction refused';
  end if;
  if exists (select 1 from migration.unpreserved_evidence) then
    raise exception 'Incomplete transfer preservation; legacy compaction refused';
  end if;
  if exists (select 1 from app.library_legacy_measurements)
      or exists (select 1 from app.game_state_legacy_measurements) then
    if coalesce(current_setting('vaultshuffle.legacy_archive_restored', true), '') <> 'accepted'
        or coalesce(current_setting('vaultshuffle.legacy_archive_sha256', true), '') !~ '^[0-9a-f]{64}$' then
      raise exception 'Restore-verified local archive required for populated legacy data';
    end if;
    archived := current_setting('vaultshuffle.legacy_archive_fingerprints', true)::jsonb;
    if jsonb_typeof(archived) <> 'array' or jsonb_array_length(archived) <> 2 then
      raise exception 'Two exact legacy archive fingerprints required';
    end if;
    foreach relation_name in array array[
      'app.game_state_legacy_measurements', 'app.library_legacy_measurements'
    ] loop
      select value into strict expected from jsonb_array_elements(archived)
        where value->>'relation' = relation_name;
      execute format($q$
        with hashes as (
          select encode(sha256(convert_to(row_to_json(t)::text, 'UTF8')), 'hex') h
          from %s t
        ) select count(*), encode(sha256(convert_to(
          coalesce(string_agg(h, '' order by h collate "C"), ''), 'UTF8')), 'hex')
        from hashes$q$, relation_name)
        into actual_count, actual_hash;
      if actual_count is distinct from (expected->>'rows')::bigint
          or actual_hash is distinct from expected->>'sha256' then
        raise exception 'Legacy archive drift for %; no data changed', relation_name;
      end if;
    end loop;
  end if;
end
$$;

-- Dates remain byte-for-byte text, keyed by the same account/AppID. Do not
-- reinterpret date-only values or shift timestamps between Ireland and Virginia.
create temporary table legacy_date_check on commit drop as
  select count(*) as rows, encode(sha256(convert_to(coalesce(string_agg(
    encode(sha256(convert_to(jsonb_build_array(account_id, steam_app_id,
      legacy_date_added_raw)::text, 'UTF8')), 'hex')
    , '' order by account_id, steam_app_id), ''), 'UTF8')), 'hex') as sha256
  from app.library_legacy_measurements;

alter table app.library_legacy_measurements
  drop column game_id,
  drop column ownership_kind,
  drop column observed_minutes_at_freeze,
  drop column legacy_hours_played,
  drop column legacy_hours_played_raw,
  drop column legacy_completion_percentage,
  drop column legacy_completion_percentage_raw,
  drop column discrepancy_kind,
  drop column conversion_formula,
  drop column authorship,
  drop column authorship_evidence,
  drop column source_snapshot_hash,
  drop column recorded_at;

-- The stale source-state copy has no runtime reader. Its full values remain in
-- the verified local archive; current state/activity/history are separate tables.
-- RESTRICT is deliberate: any unexpected incoming FK aborts, never cascades.
truncate table app.game_state_legacy_measurements continue identity restrict;

do $$
begin
  if not exists (
    select 1 from legacy_date_check expected
    join (
      select count(*) as rows, encode(sha256(convert_to(coalesce(string_agg(
        encode(sha256(convert_to(jsonb_build_array(account_id, steam_app_id,
          legacy_date_added_raw)::text, 'UTF8')), 'hex')
        , '' order by account_id, steam_app_id), ''), 'UTF8')), 'hex') as sha256
      from app.library_legacy_measurements
    ) actual using (rows, sha256)
  ) then
    raise exception 'Library date preservation failed';
  end if;
end
$$;

comment on table app.library_legacy_measurements is
  'Original Library Added strings only. Historical name retained for runtime compatibility; unused legacy measurements were archived locally on 1 October 2026.';
update ops.data_retention_registry set rationale =
  'Original Library Added text, retained exactly with owner-only reads and account-deletion cascade. Other legacy measurements archived locally on 1 October 2026.'
  where relation = 'app.library_legacy_measurements'::regclass;
update ops.data_retention_registry set rationale =
  'Retired source-state preservation relation, emptied after verified local archival on 1 October 2026. Not runtime state/activity authority.'
  where relation = 'app.game_state_legacy_measurements'::regclass;

commit;
-- Physical reclamation is a separate, bounded VACUUM FULL of this one relation.
-- DROP COLUMN alone leaves the removed payload in existing heap tuples.
