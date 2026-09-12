-- Disposable PG17 fixture for 20260912193000_blacklist_semantics.sql.
-- Run only after M1 + M2 + M3 + preservation follow-up + Blacklist migration.
\set ON_ERROR_STOP on

begin;

insert into app.accounts (id, public_id, account_kind, lifecycle_status, display_name)
overriding system value values
  (1, '10000000-0000-4000-8000-000000000001', 'manual', 'active', 'One'),
  (2, '10000000-0000-4000-8000-000000000002', 'manual', 'active', 'Two');

insert into catalog.games (id, steam_app_id, title, normalized_sort_title)
overriding system value values
  (10, 10, 'Ten', 'ten'),
  (20, 20, 'Twenty', 'twenty'),
  (30, 30, 'Thirty', 'thirty');

insert into app.library_games (account_id, game_id, playtime_minutes) values
  (1, 10, 123), (1, 20, 45), (2, 30, 999);

insert into app.game_state (
  account_id, game_id, completed_at, previous_active_status, notes,
  blacklisted, revision
) values (
  1, 10, '2026-01-01 00:00:00+00', 'In Progress', 'keep this note', false, 7
);

insert into app.snoozes (account_id, game_id, snoozed_at, until_at, reason, source)
values (1, 10, '2026-02-01 00:00:00+00', '2026-10-01 00:00:00+00', 'later', 'user');

set local role vault_app;
select set_config('app.account_id', '1', true);
select app.set_game_blacklisted(10, true);
select app.set_game_blacklisted(10, true);
select app.set_game_blacklisted(20, true);

do $$
begin
  if (select revision from app.game_state where game_id = 10) <> 8 then
    raise exception 'repeat Blacklist changed revision';
  end if;
  if not (select blacklisted from app.game_state where game_id = 10) then
    raise exception 'Blacklist membership missing';
  end if;
  if (select completed_at from app.game_state where game_id = 10) is not null then
    raise exception 'Blacklist did not replace completion terminal state';
  end if;
  if (select notes from app.game_state where game_id = 10) <> 'keep this note' then
    raise exception 'Blacklist changed notes';
  end if;
  if (select playtime_minutes from app.library_games where game_id = 10) <> 123 then
    raise exception 'Blacklist changed playtime';
  end if;

  begin
    perform app.set_game_blacklisted(30, true);
    raise exception 'cross-tenant Blacklist unexpectedly succeeded';
  exception when others then
    if sqlerrm <> 'GAME_NOT_FOUND' then raise; end if;
  end;
end
$$;

select app.set_game_blacklisted(10, false);
select app.set_game_blacklisted(10, false);
select app.set_game_blacklisted(20, false);

reset role;

do $$
begin
  if (select blacklisted from app.game_state where account_id = 1 and game_id = 10) then
    raise exception 'Reactivate left game Blacklisted';
  end if;
  if (select revision from app.game_state where account_id = 1 and game_id = 10) <> 9 then
    raise exception 'repeat Reactivate changed revision';
  end if;
  if (select notes from app.game_state where account_id = 1 and game_id = 10) <> 'keep this note' then
    raise exception 'Reactivate changed notes';
  end if;
  if exists (select 1 from app.game_state where account_id = 1 and game_id = 20) then
    raise exception 'Reactivate retained an empty sparse row';
  end if;
  if (select count(*) from app.snoozes where account_id = 1 and game_id = 10) <> 1 then
    raise exception 'Library Blacklist changed separate Vault snooze';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'app' and table_name = 'game_state'
      and column_name in ('slept_at','restored_at','restored_from_slept_at','restored_from_previous_active_status')
  ) then
    raise exception 'obsolete Sleep columns remain';
  end if;
  if not (select relrowsecurity and relforcerowsecurity from pg_class where oid='app.game_state'::regclass) then
    raise exception 'game_state RLS/force boundary changed';
  end if;
  if not has_function_privilege('vault_app','app.set_game_blacklisted(integer,boolean)','EXECUTE')
     or exists (
       select 1
       from pg_proc p,
         aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
       where p.oid='app.set_game_blacklisted(integer,boolean)'::regprocedure
         and acl.grantee=0 and acl.privilege_type='EXECUTE'
     ) then
    raise exception 'Blacklist function execute ACL is not narrow';
  end if;
  if has_column_privilege('vault_app','app.game_state','blacklisted','UPDATE')
     or has_column_privilege('vault_app','app.game_state','blacklisted','INSERT') then
    raise exception 'Blacklist column is directly writable outside the guarded function';
  end if;
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app'
      and p.prokind = 'f'
      and pg_get_functiondef(p.oid) ~* '(slept_at|90[[:space:]]+days|automatic[[:space:]_-]*restore)'
  ) then
    raise exception 'automatic/timed Sleep behavior remains in app functions';
  end if;
end
$$;

rollback;
