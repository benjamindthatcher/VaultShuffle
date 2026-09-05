-- Standalone SQL verification; run as the database owner after
-- backfill_user_game_state and harden_user_game_state_rls (not a pgTAP test).
-- All probes affect zero rows; the transaction is rolled back.
begin;
set local statement_timeout = '10s';

do $test$
declare
  client_role text;
  probe text;
  denied boolean;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.user_game_state'::regclass) then
    raise exception 'user_game_state must have RLS enabled';
  end if;
  if exists (select 1 from pg_policy where polrelid = 'public.user_game_state'::regclass) then
    raise exception 'Staging data must not have client access policies';
  end if;
  foreach client_role in array array['anon', 'authenticated'] loop
    execute format('set local role %I', client_role);
    foreach probe in array array[
      'select user_id from public.user_game_state where false',
      'insert into public.user_game_state (user_id, appid) select null::uuid, null::bigint where false',
      'update public.user_game_state set appid = appid where false',
      'delete from public.user_game_state where false'
    ] loop
      denied := false;
      begin
        execute probe;
      exception when insufficient_privilege then
        denied := true;
      end;
      if not denied then
        raise exception 'Unexpected table access for %: %', client_role, probe;
      end if;
    end loop;
    execute 'reset role';
  end loop;

  -- Owner access to the staging table remains available for the future migration.
  perform user_id from public.user_game_state limit 1;
  -- Current application paths still use user_games via the server role.
  execute 'set local role service_role';
  perform user_id from public.user_games limit 1;
  if not has_table_privilege(current_user, 'public.user_games', 'UPDATE') then
    raise exception 'Current application write permission changed';
  end if;
  execute 'reset role';
end
$test$;

select 'PASS: RLS enabled; all 8 client read/write probes denied; owner and current app access preserved' as result;
rollback;
