\set ON_ERROR_STOP on
begin;

-- The evidence correction keeps private raw facts separate from runtime state.
do $$
declare
  aid integer;
  gid integer;
  rel regclass;
  actor text;
  sid uuid := '80000000-0000-4000-8000-000000000001';
  uid uuid := '80000000-0000-4000-8000-000000000002';
begin
  foreach rel in array array['app.family_access_legacy_measurements'::regclass,
                            'app.legacy_compatibility_settings'::regclass] loop
    if not exists (select 1 from pg_class where oid=rel and relrowsecurity and relforcerowsecurity) then
      raise exception 'evidence relation must force RLS';
    end if;
    if not exists (select 1 from ops.data_retention_registry
                   where relation=rel and introduced_in='m3'
                     and deletion_mode='cascade' and account_fk_column='account_id'
                     and export_scope='account_export') then
      raise exception 'evidence retention/deletion mapping is missing';
    end if;
    foreach actor in array array['vault_app', 'vault_worker', 'anon', 'authenticated'] loop
      if to_regrole(actor) is not null and
        (has_table_privilege(actor,rel,'SELECT') or has_table_privilege(actor,rel,'INSERT')
         or has_table_privilege(actor,rel,'UPDATE') or has_table_privilege(actor,rel,'DELETE')) then
        raise exception 'runtime/browser role can access private evidence';
      end if;
    end loop;
  end loop;

  insert into app.accounts (public_id,account_kind,display_name)
    values(uid,'manual','Synthetic evidence owner') returning id into aid;
  insert into catalog.games(steam_app_id,title,normalized_sort_title)
    values(3999999995,'Synthetic evidence game','synthetic evidence game') returning id into gid;
  insert into app.family_access_legacy_measurements
    (source_library_id,account_id,game_id,steam_app_id,observed_playtime_minutes,
     last_played_at,recency_source,recency_evidence_at,family_owner_steam_id,source_snapshot_hash)
    values(sid,aid,gid,3999999995,90,'2026-02-04 00:00:00+00','steam_exact',
           '2026-02-05 00:00:00+00','76561198000000042',decode(repeat('ab',32),'hex'));
  if not exists (select 1 from app.family_access_legacy_measurements
                 where source_library_id=sid and subject_attribution='unknown'
                   and observed_playtime_minutes=90
                   and last_played_at='2026-02-04 00:00:00+00'::timestamptz) then
    raise exception 'exact unknown-subject evidence did not survive';
  end if;
  if exists (select 1 from app.game_activity where account_id=aid)
     or exists (select 1 from app.library_games where account_id=aid)
     or exists (select 1 from app.family_game_access where account_id=aid) then
    raise exception 'evidence fabricated active personal activity or access';
  end if;
  begin
    update app.family_access_legacy_measurements set subject_attribution='borrower'
      where source_library_id=sid;
    raise exception 'unknown human subject was relabelled';
  exception when check_violation then null;
  end;
  insert into app.legacy_compatibility_settings
    (source_setting_id,account_id,source_account_id,setting_key,value,source_created_at,source_updated_at)
    values(sid,aid,uid,'vault_current_pick_id','legacy-only','2026-02-01 00:00:00+00','2026-02-02 00:00:00+00');
  if exists (select 1 from app.vault_state where account_id=aid) then
    raise exception 'compatibility setting became current runtime authority';
  end if;
  delete from app.accounts where id=aid;
  if exists (select 1 from app.family_access_legacy_measurements where source_library_id=sid)
     or exists (select 1 from app.legacy_compatibility_settings where source_setting_id=sid) then
    raise exception 'account deletion retained private evidence';
  end if;
end $$;
rollback;
\echo M3 preflight evidence privacy, authority and deletion checks passed
