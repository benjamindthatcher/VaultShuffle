\set ON_ERROR_STOP on
\echo M3 follow-up target behavioral rollback fixture
--
-- Synthetic-only verification for the already-applied 20260911234500 follow-up.
-- It is one transaction, uses explicit identity values with OVERRIDING SYSTEM
-- VALUE (so it never advances target sequences), and always ROLLBACKs. Run only
-- against the named empty rehearsal target after root approval; this file never
-- changes schema or migration history.

begin;

DO $$
declare
  fixture_account constant integer := 2147000101;
  fixture_game constant integer := 2147000201;
  cascade_account constant integer := 2147000102;
  cascade_game constant integer := 2147000301;
  n bigint;
  default_loss timestamptz;
begin
  if not exists (
    select 1 from ops.project_marker
    where marker and expected_project_ref = 'vbjtbwelnhbbdfrqczyf'
      and schema_version = 'm1'
  ) then
    raise exception 'wrong target marker or schema version';
  end if;

  if to_regclass('supabase_migrations.schema_migrations') is null
     or not exists (
       select 1 from supabase_migrations.schema_migrations
       where version = '20260911234500'
     ) then
    raise exception 'required migration 20260911234500 is not recorded';
  end if;

  -- This is a target-rehearsal fixture, not a general destructive cleanup tool.
  -- Refuse if the zero-row prerequisites reported in the apply validation have
  -- changed, rather than mixing synthetic rows with unknown target state.
  select count(*) into n from app.accounts;
  if n <> 0 then raise exception 'fixture prerequisite app.accounts is nonempty'; end if;
  select count(*) into n from catalog.games;
  if n <> 0 then raise exception 'fixture prerequisite catalog.games is nonempty'; end if;
  select count(*) into n from migration.runs;
  if n <> 0 then raise exception 'fixture prerequisite migration.runs is nonempty'; end if;
  select count(*) into n from app.retired_library_games;
  if n <> 0 then raise exception 'fixture prerequisite app.retired_library_games is nonempty'; end if;
  select count(*) into n from app.game_activity;
  if n <> 0 then raise exception 'fixture prerequisite app.game_activity is nonempty'; end if;
  select count(*) into n from app.family_access_orphans;
  if n <> 0 then raise exception 'fixture prerequisite app.family_access_orphans is nonempty'; end if;
  select count(*) into n from migration.legacy_family_access_orphans;
  if n <> 0 then raise exception 'fixture prerequisite migration.legacy_family_access_orphans is nonempty'; end if;

  insert into app.accounts (id, account_kind, display_name)
    overriding system value values (fixture_account, 'manual', 'M3 followup fixture');
  insert into catalog.games (id, steam_app_id, title, normalized_sort_title)
    overriding system value values (fixture_game, 4294900101, 'M3 followup fixture game', 'm3 followup fixture game');

  -- The one authorised NULL loss instant: verbatim Wishlist plus unknown reason.
  insert into app.retired_library_games
    (account_id, game_id, access_lost_at, loss_reason, legacy_ownership)
  values (fixture_account, fixture_game, null, 'unknown', 'Wishlist');
  if not exists (
    select 1 from app.retired_library_games
    where account_id = fixture_account and game_id = fixture_game
      and access_lost_at is null and loss_reason = 'unknown'
      and legacy_ownership = 'Wishlist'
  ) then raise exception 'authorised legacy Wishlist exception was not preserved'; end if;

end $$;

-- Continue outside the exception block so every rejection is independently
-- observable, while the enclosing transaction stays rollback-only.
DO $$
declare
  fixture_account constant integer := 2147000101;
  fixture_game constant integer := 2147000201;
  cascade_account constant integer := 2147000102;
  cascade_game constant integer := 2147000301;
  default_loss timestamptz;
begin
  insert into catalog.games (id, steam_app_id, title, normalized_sort_title)
    overriding system value values (fixture_game + 1, 4294900103, 'M3 followup default game', 'm3 followup default game'),
      (fixture_game + 2, 4294900104, 'M3 followup rejection game one', 'm3 followup rejection game one'),
      (fixture_game + 3, 4294900105, 'M3 followup rejection game two', 'm3 followup rejection game two'),
      (fixture_game + 4, 4294900106, 'M3 followup rejection game three', 'm3 followup rejection game three');
  insert into app.retired_library_games (account_id, game_id, loss_reason, legacy_ownership)
    values (fixture_account, fixture_game + 1, 'manual', 'Owned')
    returning access_lost_at into default_loss;
  if default_loss is null or default_loss < statement_timestamp() - interval '1 minute'
     or default_loss > statement_timestamp() + interval '1 minute' then
    raise exception 'access_lost_at no longer receives normal now() default';
  end if;

  begin
    insert into app.retired_library_games (account_id, game_id, access_lost_at, loss_reason, legacy_ownership)
      values (fixture_account, fixture_game + 2, null, 'unknown', null);
    raise exception 'unlabelled null access_lost_at was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into app.retired_library_games (account_id, game_id, access_lost_at, loss_reason, legacy_ownership)
      values (fixture_account, fixture_game + 3, null, 'unknown', 'Owned');
    raise exception 'Owned null access_lost_at was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into app.retired_library_games (account_id, game_id, access_lost_at, loss_reason, legacy_ownership)
      values (fixture_account, fixture_game + 4, null, 'manual', 'Wishlist');
    raise exception 'non-unknown Wishlist null access_lost_at was accepted';
  exception when check_violation then null;
  end;

  insert into app.game_activity
    (account_id, game_id, last_played_at, legacy_last_played_at, evidence_source)
  values (fixture_account, fixture_game,
    timestamptz '2024-01-02 03:04:05+00', timestamptz '2023-12-31 23:59:59+00', 'user');
  if not exists (
    select 1 from app.game_activity where account_id = fixture_account and game_id = fixture_game
      and last_played_at = timestamptz '2024-01-02 03:04:05+00'
      and legacy_last_played_at = timestamptz '2023-12-31 23:59:59+00'
  ) then raise exception 'distinct legacy play timestamps were collapsed'; end if;

  insert into app.family_access_orphans
    (id, account_id, game_id, steam_app_id, lender_steam_id, disposition)
  overriding system value
  values (2147000401, fixture_account, fixture_game, 4294900101, 76561198000000101, 'retired');
  insert into migration.legacy_family_access_orphans
    (id, account_id, source_user_id, source_member_id, steam_appid, disposition)
  overriding system value
  values (2147000501, fixture_account, '00000000-0000-4000-8000-000000000101',
    '00000000-0000-4000-8000-000000000102', 4294900101, 'retired');

  insert into app.accounts (id, account_kind, display_name)
    overriding system value values (cascade_account, 'manual', 'M3 followup cascade fixture');
  insert into catalog.games (id, steam_app_id, title, normalized_sort_title)
    overriding system value values (cascade_game, 4294900102, 'M3 followup cascade game', 'm3 followup cascade game');
  insert into app.retired_library_games
    (account_id, game_id, access_lost_at, loss_reason, legacy_ownership)
    values (cascade_account, cascade_game, null, 'unknown', 'Wishlist');
  insert into app.game_activity
    (account_id, game_id, last_played_at, legacy_last_played_at, evidence_source)
    values (cascade_account, cascade_game, timestamptz '2024-02-01 00:00:00+00',
      timestamptz '2024-01-01 00:00:00+00', 'user');
  insert into app.family_access_orphans (id, account_id, game_id, steam_app_id, disposition)
    overriding system value
    values (2147000402, cascade_account, cascade_game, 4294900102, 'retired');
  insert into migration.legacy_family_access_orphans
    (id, account_id, source_user_id, steam_appid, disposition)
  overriding system value
  values (2147000502, cascade_account, '00000000-0000-4000-8000-000000000103', 4294900102, 'retired');
  delete from app.accounts where id = cascade_account;
  if exists (select 1 from app.retired_library_games where account_id = cascade_account)
     or exists (select 1 from app.game_activity where account_id = cascade_account)
     or exists (select 1 from app.family_access_orphans where account_id = cascade_account)
     or exists (select 1 from migration.legacy_family_access_orphans where account_id = cascade_account) then
    raise exception 'account cascade left followup evidence behind';
  end if;
end $$;

rollback;

-- Metadata-only cleanup check: fixture identities must not survive the rollback.
DO $$
begin
  if exists (select 1 from app.accounts where id in (2147000101, 2147000102))
     or exists (select 1 from catalog.games where id between 2147000201 and 2147000301)
     or exists (select 1 from app.retired_library_games where account_id in (2147000101, 2147000102))
     or exists (select 1 from app.game_activity where account_id in (2147000101, 2147000102))
     or exists (select 1 from app.family_access_orphans where account_id in (2147000101, 2147000102))
     or exists (select 1 from migration.legacy_family_access_orphans where account_id in (2147000101, 2147000102)) then
    raise exception 'rollback leaked followup fixture identifiers';
  end if;
end $$;
\echo M3 follow-up target behavioral rollback fixture passed
