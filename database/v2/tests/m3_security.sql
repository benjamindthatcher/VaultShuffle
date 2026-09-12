\set ON_ERROR_STOP on
\echo M3 runtime role and tenant privacy checks

DO $$
declare
  v_role text;
  v_login boolean;
  v_super boolean;
  v_bypass boolean;
  v_create_role boolean;
begin
  if not exists (
    select 1 from pg_catalog.pg_roles
     where rolname = current_user and rolsuper
  ) then
    raise exception 'm3_security.sql must run as the disposable setup administrator';
  end if;
  foreach v_role in array array['vault_app', 'vault_worker'] loop
    select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole
      into v_login, v_super, v_bypass, v_create_role
      from pg_roles where rolname = v_role;
    if v_login or v_super or v_bypass or v_create_role then
      raise exception 'runtime role % has excessive attributes', v_role;
    end if;
  end loop;
  if not has_table_privilege('vault_app', 'app.vault_draws', 'select,insert,update,delete') then
    raise exception 'vault_app lacks tenant draw history DML grant';
  end if;
  if not has_table_privilege('vault_app', 'catalog.duration_estimates', 'select') then
    raise exception 'vault_app lacks catalogue observation read grant';
  end if;
  if not has_column_privilege('vault_app', 'app.accounts', 'last_login_at', 'UPDATE') then
    raise exception 'vault_app lacks the named last-login column grant';
  end if;
  if not has_column_privilege('vault_app', 'app.accounts', 'last_seen_at', 'UPDATE') then
    raise exception 'M1 last_seen_at update privilege was lost';
  end if;
  if has_column_privilege('vault_worker', 'app.accounts', 'last_login_at', 'UPDATE') then
    raise exception 'vault_worker received the last-login writer grant';
  end if;
  if has_schema_privilege('vault_app', 'reco', 'CREATE')
     or has_schema_privilege('vault_worker', 'reco', 'CREATE') then
    raise exception 'M3 warm-start schema grant includes CREATE';
  end if;
  if not has_sequence_privilege('vault_app', 'app.vault_draws_id_seq', 'USAGE')
     or not has_sequence_privilege('vault_app', 'app.vault_draw_events_id_seq', 'USAGE')
     or not has_sequence_privilege('vault_app', 'app.vault_events_id_seq', 'USAGE') then
    raise exception 'vault_app lacks a named new draw/event sequence grant';
  end if;
  if has_sequence_privilege('vault_app', 'app.accounts_id_seq', 'USAGE')
     or has_sequence_privilege('vault_app', 'app.family_members_id_seq', 'USAGE')
     or not has_sequence_privilege('vault_app', 'app.collections_id_seq', 'USAGE') then
    raise exception 'existing app sequence ACLs changed by M3';
  end if;
  if has_table_privilege('vault_app', 'migration.runs', 'select')
     or has_table_privilege('vault_worker', 'migration.runs', 'select')
     or has_table_privilege('vault_app', 'support.contact_messages', 'select')
     or has_table_privilege('vault_worker', 'support.contact_messages', 'select')
     or has_table_privilege('vault_app', 'app.game_state_legacy_measurements', 'select')
     or has_table_privilege('vault_worker', 'app.game_state_legacy_measurements', 'select') then
    raise exception 'private M3 table has a runtime/public grant';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
     and has_table_privilege('anon', 'support.contact_messages', 'select') then
    raise exception 'private M3 table has a runtime/public grant';
  end if;
end
$$;

begin;

-- Run this fixture as the disposable cluster setup administrator. A superuser
-- may SET LOCAL ROLE without a persistent membership grant, so the test keeps
-- the cluster role graph unchanged while all DML below executes as the
-- NOLOGIN/NOBYPASSRLS vault_app role. Production membership is provisioned out
-- of band and is never created by a migration or this fixture.

DO $$
declare
  aid integer;
  other_aid integer;
  gid integer;
  own_count bigint;
  other_count bigint;
begin
  insert into app.accounts (account_kind, display_name)
    values ('manual', 'M3 RLS owner') returning id into aid;
  insert into app.accounts (account_kind, display_name)
    values ('manual', 'M3 RLS other') returning id into other_aid;
  insert into catalog.games (steam_app_id, title, normalized_sort_title)
    values (3999999997, 'M3 RLS game', 'm3 rls game') returning id into gid;
  insert into app.vault_draws (
    public_id, account_id, game_id, steam_app_id, drawn_at,
    eligible_pool_count, reroll_index, finalist_app_ids
  ) values
    (gen_random_uuid(), aid, gid, 3999999997, now(), 1, 0, '[3999999997]'::jsonb),
    (gen_random_uuid(), other_aid, gid, 3999999997, now(), 1, 0, '[3999999997]'::jsonb);

  execute 'set local role vault_app';
  perform set_config('app.account_id', aid::text, true);
  select count(*) into own_count from app.vault_draws;
  select count(*) into other_count from app.vault_draws where account_id = other_aid;
  if own_count <> 1 or other_count <> 0 then
    raise exception 'tenant policy leaked draw rows: own %, other %', own_count, other_count;
  end if;
  update app.accounts
     set last_login_at = timestamptz '2026-09-10 02:00:00+00'
   where id = aid;
  if not exists (
    select 1 from app.accounts
     where id = aid and last_login_at = timestamptz '2026-09-10 02:00:00+00'
  ) then
    raise exception 'vault_app cannot write the separate last_login_at instant';
  end if;

  begin
    perform count(*) from migration.runs;
    raise exception 'vault_app read migration.runs';
  exception when insufficient_privilege then null;
  end;
  begin
    perform count(*) from support.contact_messages;
    raise exception 'vault_app read support.contact_messages';
  exception when insufficient_privilege then null;
  end;
  begin
    perform count(*) from app.unknown_completion_history;
    raise exception 'vault_app read unknown completion archive';
  exception when insufficient_privilege then null;
  end;
end
$$;

rollback;
\echo M3 runtime privacy transaction passed
