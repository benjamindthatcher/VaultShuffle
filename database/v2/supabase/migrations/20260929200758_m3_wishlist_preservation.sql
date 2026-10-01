-- Current saved Wishlist: independent of Library lifecycle and catalogue presence.
-- Additive to the five immutable applied migrations; local preparation only.
begin;

create table app.wishlist_games (
  account_id integer not null references app.accounts(id) on delete cascade,
  steam_app_id bigint not null check (steam_app_id between 1 and 4294967295),
  source text not null default 'local' check (source in ('local', 'steam')),
  added_at timestamptz not null default now(),
  primary key (account_id, steam_app_id)
);
create index wishlist_games_added_idx
  on app.wishlist_games (account_id, added_at desc, steam_app_id);
comment on table app.wishlist_games is
  'Saved purchase intent. AppID may be absent from catalogue and Library; no ownership/state dependency.';

alter table app.wishlist_games enable row level security;
alter table app.wishlist_games force row level security;
create policy tenant_isolation on app.wishlist_games for all to vault_app
  using (account_id = app.current_account_id())
  with check (account_id = app.current_account_id());
revoke all on app.wishlist_games from public, vault_app, vault_worker;
grant select, insert, delete on app.wishlist_games to vault_app;
-- Save/import uses ON CONFLICT DO NOTHING, so existing source/added_at are immutable
-- through the runtime role. Removal and a later save create a new ordinary entry.
do $$
begin
  if to_regrole('anon') is not null then revoke all on app.wishlist_games from anon; end if;
  if to_regrole('authenticated') is not null then revoke all on app.wishlist_games from authenticated; end if;
end $$;

insert into ops.data_retention_registry
  (relation, introduced_in, retention_class, holds_personal_data,
   account_fk_column, account_uuid_columns, deletion_mode, export_scope, rationale)
values
  ('app.wishlist_games', 'm3', 'durable-account-lifetime', true,
   'account_id', '{}', 'cascade', 'account_export',
   'Current saved Wishlist, including unavailable and unreleased AppIDs; deleted with its account.');

commit;
