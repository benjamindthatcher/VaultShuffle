-- REVIEW PROPOSAL ONLY. NOT A MIGRATION. NOT APPLIED.
-- Minimal durable homes for two real-preflight evidence populations that do
-- not fit an existing durable destination without changing their meaning.

begin;

create table app.family_access_legacy_measurements (
  account_id integer not null references app.accounts(id) on delete cascade,
  game_id integer references catalog.games(id) on delete set null,
  steam_app_id bigint not null check (steam_app_id > 0),
  source_library_id uuid not null,
  subject_attribution text not null default 'unknown'
    check (subject_attribution = 'unknown'),
  observed_playtime_minutes integer
    check (observed_playtime_minutes is null or observed_playtime_minutes >= 0),
  last_played_at timestamptz,
  last_observed_played_at timestamptz,
  recency_source text,
  recency_evidence_at timestamptz,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  recorded_at timestamptz not null default now(),
  primary key (account_id, steam_app_id, source_library_id),
  check (observed_playtime_minutes is not null
      or last_played_at is not null
      or last_observed_played_at is not null
      or recency_source is not null
      or recency_evidence_at is not null)
);

comment on table app.family_access_legacy_measurements is
  'Legacy family-access measurements whose human subject is unknown. They do not '
  'feed app.game_activity, personal playtime, recommendation state or access.';

create table app.legacy_compatibility_settings (
  account_id integer not null references app.accounts(id) on delete cascade,
  source_account_id uuid not null,
  setting_key text not null check (length(btrim(setting_key)) between 1 and 200),
  value jsonb not null check (jsonb_typeof(value) = 'string' and pg_column_size(value) <= 32768),
  source_created_at timestamptz,
  source_updated_at timestamptz,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  primary key (source_account_id, setting_key)
);

comment on table app.legacy_compatibility_settings is
  'Verbatim legacy app_settings compatibility state that differs from normalized '
  'vault, snooze or pin state. It is evidence only and is not a runtime preference.';

alter table app.family_access_legacy_measurements enable row level security;
alter table app.family_access_legacy_measurements force row level security;
create policy family_access_legacy_measurements_read
  on app.family_access_legacy_measurements for select to authenticated
  using (account_id = app.current_account_id());

alter table app.legacy_compatibility_settings enable row level security;
alter table app.legacy_compatibility_settings force row level security;
create policy legacy_compatibility_settings_read
  on app.legacy_compatibility_settings for select to authenticated
  using (account_id = app.current_account_id());

grant select on app.family_access_legacy_measurements, app.legacy_compatibility_settings to authenticated;
grant select, insert, update, delete on app.family_access_legacy_measurements, app.legacy_compatibility_settings to vault_worker;

insert into ops.data_retention_registry
  (relation_name, milestone, retention_class, holds_personal_data,
   account_fk_column, account_uuid_columns, deletion_mode, export_scope, rationale)
values
  ('app.family_access_legacy_measurements', 'm3', 'durable-account-lifetime', true,
   'account_id', '{}', 'cascade', 'account_export',
   'Unknown-subject family measurement evidence; never active personal playtime.'),
  ('app.legacy_compatibility_settings', 'm3', 'durable-account-lifetime', true,
   'account_id', '{source_account_id}', 'cascade', 'account_export',
   'Legacy compatibility state that differs from normalized current state.');

rollback;
