-- M3 real-preflight durable evidence correction. PREPARED LOCALLY, NOT APPLIED.
-- Keeps six measured legacy records without changing current vault, pin,
-- snooze, activity, family-access, or recommendation authority.

begin;

create table app.family_access_legacy_measurements (
  source_library_id uuid primary key,
  account_id integer not null references app.accounts(id) on delete cascade,
  game_id integer references catalog.games(id) on delete set null,
  steam_app_id bigint not null check (steam_app_id between 1 and 4294967295),
  subject_attribution text not null default 'unknown'
    check (subject_attribution = 'unknown'),
  observed_playtime_minutes integer
    check (observed_playtime_minutes is null or observed_playtime_minutes >= 0),
  last_played_at timestamptz,
  last_observed_played_at timestamptz,
  recency_source text check (
    recency_source is null or length(btrim(recency_source)) between 1 and 120
  ),
  recency_evidence_at timestamptz,
  family_owner_steam_id text check (
    family_owner_steam_id is null or length(family_owner_steam_id) <= 200
  ),
  family_verified_at timestamptz,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  check (observed_playtime_minutes is not null
      or last_played_at is not null
      or last_observed_played_at is not null
      or recency_source is not null
      or recency_evidence_at is not null)
);

comment on table app.family_access_legacy_measurements is
  'Exact legacy family-access observation evidence whose human subject is unknown. '
  'It never feeds current access, personal game activity, or recommendation state.';
comment on column app.family_access_legacy_measurements.family_owner_steam_id is
  'Verbatim legacy lender provenance; it does not identify the subject of the measurement.';

create index family_access_legacy_measurements_account_idx
  on app.family_access_legacy_measurements (account_id, steam_app_id);

create table app.legacy_compatibility_settings (
  source_setting_id uuid primary key,
  account_id integer not null references app.accounts(id) on delete cascade,
  source_account_id uuid not null,
  setting_key text not null check (setting_key in (
    'vault_current_pick_id', 'vault_snoozed_ids', 'wishlist_pinned_ids'
  )),
  value text not null,
  source_created_at timestamptz not null,
  source_updated_at timestamptz not null,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  unique (source_account_id, setting_key),
  check (source_updated_at >= source_created_at)
);

comment on table app.legacy_compatibility_settings is
  'Exact one-release rollback compatibility state. Normalized vault, snooze, and pin '
  'relations remain current authority; these values are never runtime preferences.';

create index legacy_compatibility_settings_account_idx
  on app.legacy_compatibility_settings (account_id, setting_key);

alter table app.family_access_legacy_measurements enable row level security;
alter table app.family_access_legacy_measurements force row level security;
alter table app.legacy_compatibility_settings enable row level security;
alter table app.legacy_compatibility_settings force row level security;

-- Owner/operator only. Account export remains behind the established operator
-- boundary; browser and runtime roles receive no direct table capability.
revoke all on app.family_access_legacy_measurements from public, vault_app, vault_worker;
revoke all on app.legacy_compatibility_settings from public, vault_app, vault_worker;

do $$
begin
  if to_regrole('anon') is not null then
    revoke all on app.family_access_legacy_measurements from anon;
    revoke all on app.legacy_compatibility_settings from anon;
  end if;
  if to_regrole('authenticated') is not null then
    revoke all on app.family_access_legacy_measurements from authenticated;
    revoke all on app.legacy_compatibility_settings from authenticated;
  end if;
end $$;

insert into ops.data_retention_registry
  (relation, introduced_in, retention_class, holds_personal_data,
   account_fk_column, account_uuid_columns, deletion_mode, export_scope, rationale)
values
  ('app.family_access_legacy_measurements', 'm3', 'durable-account-lifetime', true,
   'account_id', '{}', 'cascade', 'account_export',
   'Unknown-subject family observation evidence; never active personal playtime or access.'),
  ('app.legacy_compatibility_settings', 'm3', 'durable-account-lifetime', true,
   'account_id', '{source_account_id}', 'cascade', 'account_export',
   'Exact rollback compatibility state; normalized current state remains authoritative.');

commit;
