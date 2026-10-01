-- Removing legacy columns leaves dropped attribute slots in PostgreSQL tuples.
-- Rebuild the same three-column date relation to eliminate that padding. No
-- runtime name, value, policy, key or grant changes; no date parsing/deduplication.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '60s';
lock table app.library_legacy_measurements in access exclusive mode;

do $$
begin
  if (select array_agg(attname::text order by attnum) from pg_attribute
      where attrelid='app.library_legacy_measurements'::regclass
        and attnum>0 and not attisdropped)
      is distinct from array['account_id','steam_app_id','legacy_date_added_raw'] then
    raise exception 'Expected date-only relation before heap rebuild';
  end if;
  if exists(select 1 from pg_trigger
      where tgrelid='app.library_legacy_measurements'::regclass and not tgisinternal)
      or (select count(*) from pg_policy
        where polrelid='app.library_legacy_measurements'::regclass) <> 1 then
    raise exception 'Unexpected date relation trigger or policy';
  end if;
end $$;

create temporary table library_date_view_definition on commit drop as
  select pg_get_viewdef('migration.unpreserved_evidence'::regclass, true) as definition;

create table app.library_added_compact (
  account_id integer not null references app.accounts(id) on delete cascade,
  steam_app_id bigint not null check (steam_app_id > 0),
  legacy_date_added_raw text check (length(legacy_date_added_raw) <= 128),
  primary key (account_id, steam_app_id)
);
alter table app.library_added_compact enable row level security;
alter table app.library_added_compact force row level security;
create policy current_library_added_read on app.library_added_compact
  for select to vault_app using (account_id = app.current_account_id());
revoke all on app.library_added_compact from public, vault_app, vault_worker;
grant select (account_id, steam_app_id, legacy_date_added_raw)
  on app.library_added_compact to vault_app;
do $$
declare role_name text;
begin
  foreach role_name in array array['anon','authenticated'] loop
    if to_regrole(role_name) is not null then
      execute format('revoke all on app.library_added_compact from %I',role_name);
    end if;
  end loop;
end $$;

insert into app.library_added_compact
  select account_id, steam_app_id, legacy_date_added_raw
  from app.library_legacy_measurements order by account_id, steam_app_id;

do $$
begin
  if exists (
    (select account_id,steam_app_id,legacy_date_added_raw from app.library_legacy_measurements
      except select account_id,steam_app_id,legacy_date_added_raw from app.library_added_compact)
    union all
    (select account_id,steam_app_id,legacy_date_added_raw from app.library_added_compact
      except select account_id,steam_app_id,legacy_date_added_raw from app.library_legacy_measurements)
  ) then raise exception 'Library date copy differs; heap rebuild refused'; end if;
end $$;

-- Rebind only the known, owner-only migration preservation view to the new
-- relation. CREATE OR REPLACE preserves its existing ACL and column identity.
-- Any other dependency makes DROP RESTRICT fail and rolls everything back.
update ops.data_retention_registry
  set relation='app.library_added_compact'::regclass
  where relation='app.library_legacy_measurements'::regclass;
alter table app.library_legacy_measurements rename to library_added_retired;
alter table app.library_added_compact rename to library_legacy_measurements;
do $$
declare definition text;
begin
  select d.definition into strict definition from library_date_view_definition d;
  execute 'create or replace view migration.unpreserved_evidence as ' || definition;
end $$;
drop table app.library_added_retired restrict;
alter table app.library_legacy_measurements
  rename constraint library_added_compact_pkey to library_legacy_measurements_pkey;
comment on table app.library_legacy_measurements is
  'Compact original Library Added strings only. Historical runtime name retained; unused legacy evidence archived locally on 1 October 2026.';
analyze app.library_legacy_measurements;
commit;
