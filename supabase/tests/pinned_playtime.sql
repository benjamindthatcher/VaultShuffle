-- Transactional regression tests: no real account changes survive this file.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '20s';
set local role service_role;
do $test$
declare
  account_a uuid := gen_random_uuid();
  account_b uuid := gen_random_uuid();
  apps bigint[];
  pin_id uuid;
  unpinned_id uuid;
  other_id uuid;
  original_pin jsonb;
  original_unpinned jsonb;
  result jsonb;
begin
  select array_agg(steam_appid) into apps from (select steam_appid from public.catalog_games order by steam_appid limit 2) s;
  insert into public.app_accounts(id,account_type) values(account_a,'manual'),(account_b,'manual');
  select id into strict pin_id from public.upsert_user_steam_games(account_a,
    jsonb_build_array(jsonb_build_object('steam_appid',apps[1]::text,'hours_played',10)), 'Owned');
  select id into strict unpinned_id from public.upsert_user_steam_games(account_a,
    jsonb_build_array(jsonb_build_object('steam_appid',apps[2]::text,'hours_played',4)), 'Owned');
  select id into strict other_id from public.upsert_user_steam_games(account_b,
    jsonb_build_array(jsonb_build_object('steam_appid',apps[1]::text,'hours_played',7)), 'Owned');
  update public.user_games set status='Slept',notes='Preserve player state',rating=9,priority='High',completion_percentage=42 where id=pin_id;
  insert into public.user_game_pins(user_id,game_id,slot,scope,hours_at_pin) values(account_a,pin_id,1,'library',10);
  select to_jsonb(p) into original_pin from public.user_game_pins p where game_id=pin_id;
  select to_jsonb(g) into original_unpinned from public.user_games g where id=unpinned_id;

  -- A supplied non-pin and another account's matching AppID must not be updated.
  result := public.refresh_pinned_steam_playtime(account_a,jsonb_build_array(
    jsonb_build_object('steam_appid',apps[1]::text,'minutes',750),
    jsonb_build_object('steam_appid',apps[2]::text,'minutes',6000)));
  if result->>'pinned_games_updated'<>'1' or result->>'pinned_games_matched'<>'1' then raise exception 'Incorrect pin update counts'; end if;
  if not exists(select 1 from public.user_games where id=pin_id and hours_played=12.5 and observed_playtime_minutes=750
    and status='Slept' and notes='Preserve player state' and rating=9 and priority='High' and completion_percentage=42
    and recency_source='observed_playtime_change') then raise exception 'Pin playtime/state incorrect'; end if;
  if original_pin is distinct from (select to_jsonb(p) from public.user_game_pins p where game_id=pin_id) then raise exception 'Pin baseline modified'; end if;
  if original_unpinned is distinct from (select to_jsonb(g) from public.user_games g where id=unpinned_id) then raise exception 'Unpinned game modified'; end if;
  if (select hours_played from public.user_games where id=other_id)<>7 then raise exception 'Cross-account write'; end if;
  if exists(select 1 from public.user_playtime_snapshots where user_id=account_a) then raise exception 'Pin-only refresh manufactured full-library snapshot'; end if;

  -- True zero or a stale snapshot cannot erase accumulated playtime or rebase pins.
  result := public.refresh_pinned_steam_playtime(account_a,jsonb_build_array(jsonb_build_object('steam_appid',apps[1]::text,'minutes',0)));
  if result->>'pinned_games_updated'<>'0' then raise exception 'Stale playtime was written'; end if;
  -- Full imports rounded 751 minutes to 12.5h / 750 observed minutes. Reading
  -- those same 751 minutes via the pin worker must not fabricate more play.
  result := public.refresh_pinned_steam_playtime(account_a,jsonb_build_array(jsonb_build_object('steam_appid',apps[1]::text,'minutes',751)));
  if result->>'pinned_games_updated'<>'0' then raise exception 'Precision change manufactured recency'; end if;
  begin
    perform public.refresh_pinned_steam_playtime(account_a,jsonb_build_array(jsonb_build_object('steam_appid',apps[1]::text)));
    raise exception 'Missing playtime accepted';
  exception when others then if sqlerrm<>'INVALID_PLAYTIME_GAME' then raise; end if; end;

  -- The real full-library import RPC updates existing games, retains identity and pin baseline.
  perform public.upsert_user_steam_games(account_a,jsonb_build_array(
    jsonb_build_object('steam_appid',apps[1]::text,'hours_played',15),
    jsonb_build_object('steam_appid',apps[2]::text,'hours_played',8)), 'Owned');
  if not exists(select 1 from public.user_games where id=pin_id and hours_played=15 and notes='Preserve player state' and status='Slept') then raise exception 'Full refresh did not update pin playtime'; end if;
  if not exists(select 1 from public.user_games where id=unpinned_id and hours_played=8) then raise exception 'Full refresh did not update unpinned playtime'; end if;
  if original_pin is distinct from (select to_jsonb(p) from public.user_game_pins p where game_id=pin_id) then raise exception 'Full import reset pin baseline'; end if;
  perform public.upsert_user_steam_games(account_a,jsonb_build_array(jsonb_build_object('steam_appid',apps[1]::text,'hours_played',0)), 'Owned');
  if (select hours_played from public.user_games where id=pin_id)<>15 then raise exception 'Hidden/stale full refresh lost playtime'; end if;
  perform public.capture_steam_playtime_snapshot(account_a);
  if not exists(select 1 from public.user_playtime_snapshots where user_id=account_a and total_minutes=1380) then raise exception 'Snapshot does not reflect saved full-library hours'; end if;

  update public.user_game_pins set scope='test_other_scope' where game_id=pin_id;
  result := public.refresh_pinned_steam_playtime(account_a,jsonb_build_array(jsonb_build_object('steam_appid',apps[1]::text,'minutes',1800)));
  if result->>'pinned_games_updated'<>'0' then raise exception 'Non-library pin was updated'; end if;
  delete from public.user_game_pins where game_id=pin_id;
  result := public.refresh_pinned_steam_playtime(account_a,jsonb_build_array(jsonb_build_object('steam_appid',apps[1]::text,'minutes',1800)));
  if result->>'pinned_games_updated'<>'0' or (select hours_played from public.user_games where id=pin_id)<>15 then raise exception 'Unpinned-in-flight game modified'; end if;
  if has_function_privilege('anon','public.refresh_pinned_steam_playtime(uuid,jsonb)','execute')
    or has_function_privilege('authenticated','public.refresh_pinned_steam_playtime(uuid,jsonb)','execute') then raise exception 'Pin RPC exposed to browser clients'; end if;
end;
$test$;
select 'PASS: pins only, account isolation, unpin race, baseline/player-state preservation, zero/stale protection, full-refresh playtime, snapshots, grants' as verification;
rollback;
