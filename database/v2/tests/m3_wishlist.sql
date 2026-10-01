\set ON_ERROR_STOP on
begin;

do $$
declare
  aid integer;
  other_aid integer;
  actor text;
  n integer;
begin
  if not exists (select 1 from pg_class where oid='app.wishlist_games'::regclass
                 and relrowsecurity and relforcerowsecurity) then
    raise exception 'Wishlist must force RLS';
  end if;
  if not exists (select 1 from ops.data_retention_registry
                 where relation='app.wishlist_games'::regclass
                   and deletion_mode='cascade' and export_scope='account_export') then
    raise exception 'Wishlist export/deletion mapping missing';
  end if;
  foreach actor in array array['vault_worker', 'anon', 'authenticated'] loop
    if to_regrole(actor) is not null and
       (has_table_privilege(actor,'app.wishlist_games','SELECT')
        or has_table_privilege(actor,'app.wishlist_games','INSERT')
        or has_table_privilege(actor,'app.wishlist_games','UPDATE')
        or has_table_privilege(actor,'app.wishlist_games','DELETE')) then
      raise exception 'non-app role can access Wishlist';
    end if;
  end loop;
  if has_table_privilege('vault_app','app.wishlist_games','UPDATE') then
    raise exception 'Wishlist save can overwrite provenance or ownership';
  end if;
  insert into app.accounts (account_kind,display_name) values ('manual','Wishlist owner') returning id into aid;
  insert into app.accounts (account_kind,display_name) values ('steam','Wishlist other') returning id into other_aid;
  insert into app.wishlist_games (account_id,steam_app_id,source,added_at) values
    (aid,4294967295,'local','2026-09-19 15:44:42.123456+01'),
    (other_aid,4294967295,'steam','2026-09-20 00:00:00+00');
  if exists (select 1 from catalog.games where steam_app_id=4294967295) then
    raise exception 'Wishlist fixture requires an absent catalogue AppID';
  end if;

  execute 'set local role vault_app';
  perform set_config('app.account_id','',true);
  select count(*) into n from app.wishlist_games;
  if n<>0 then raise exception 'missing tenant context can read Wishlist'; end if;
  begin
    insert into app.wishlist_games(account_id,steam_app_id) values(aid,123);
    raise exception 'missing context inserted a Wishlist game';
  exception when insufficient_privilege then null;
  end;
  perform set_config('app.account_id',aid::text,true);
  select count(*) into n from app.wishlist_games;
  if n<>1 then raise exception 'tenant can read another Wishlist'; end if;
  begin
    insert into app.wishlist_games(account_id,steam_app_id) values(other_aid,123);
    raise exception 'tenant wrote another Wishlist';
  exception when insufficient_privilege then null;
  end;
  begin
    update app.wishlist_games set account_id=other_aid where account_id=aid;
    raise exception 'Wishlist owner can be reassigned';
  exception when insufficient_privilege then null;
  end;
  delete from app.wishlist_games where account_id=other_aid;
  get diagnostics n=row_count;
  if n<>0 then raise exception 'tenant deleted another Wishlist'; end if;

  -- Atomic additive import: existing source/time stay intact, same saved entry
  -- is not treated as Library ownership or catalogue identity.
  insert into app.wishlist_games (account_id,steam_app_id,source,added_at) values
    (aid,4294967295,'steam',now()), (aid,4000000000,'steam',now())
    on conflict (account_id,steam_app_id) do nothing;
  if not exists(select 1 from app.wishlist_games where account_id=aid
                and steam_app_id=4294967295 and source='local'
                and added_at='2026-09-19 14:44:42.123456+00'::timestamptz) then
    raise exception 'duplicate import overwrote original save';
  end if;
  begin
    insert into app.wishlist_games(account_id,steam_app_id) values(aid,321),(aid,0);
    raise exception 'invalid import accepted';
  exception when check_violation then null;
  end;
  select count(*) into n from app.wishlist_games;
  if n<>2 or exists(select 1 from app.wishlist_games where steam_app_id=321) then
    raise exception 'failed import partially wrote or erased saves';
  end if;
  delete from app.wishlist_games where steam_app_id=4000000000;
  get diagnostics n=row_count;
  if n<>1 then raise exception 'own removal failed'; end if;
  perform set_config('app.account_id',other_aid::text,true);
  select count(*) into n from app.wishlist_games;
  if n<>1 then raise exception 'switching tenant lost other save'; end if;
  perform set_config('app.account_id','',true);
  select count(*) into n from app.wishlist_games;
  if n<>0 then raise exception 'cleared context still exposes rows'; end if;
  execute 'reset role';
  if exists(select 1 from app.library_games where account_id in(aid,other_aid))
     or exists(select 1 from app.game_state where account_id in(aid,other_aid)) then
    raise exception 'saved Wishlist fabricated Library/state';
  end if;
  delete from app.accounts where id=aid;
  if exists(select 1 from app.wishlist_games where account_id=aid)
     or not exists(select 1 from app.wishlist_games where account_id=other_aid) then
    raise exception 'account deletion did not isolate Wishlist cascade';
  end if;
end $$;
rollback;
