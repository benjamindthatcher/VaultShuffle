-- VaultShuffle v2 M3: private preservation schema.
--
-- This migration is additive to the immutable M1/M2 files.  It creates
-- durable destinations for source facts that the compact runtime model cannot
-- hold, plus content-addressed migration maps and bounded archives.  It does
-- not read the source, load data, create credentials, enable providers, or
-- grant a runtime role access to migration/support evidence.
--
-- Every source-value decision that cannot be proven from the final export is
-- represented as nullable evidence or a conflict row.  The loader must not
-- coerce a value merely to satisfy a target check.

create schema if not exists support;

-- ---------------------------------------------------------------------------
-- Retention and deletion vocabulary
-- ---------------------------------------------------------------------------
--
-- Plan 13 bounds raw migration staging and exports to 30 days after a
-- validated cutover, and requires account deletion/export to reach every
-- private derivative.  M3-B rule 12 adds that "permanent while the feature
-- exists" and "review at M7" are not bounded staging policies, and that
-- lasting authored/provenance facts must move into durable domain relations
-- with deletion semantics instead of being renamed.
--
-- The vocabulary below is enforced, not descriptive: every retention-bearing
-- relation's `retention_class` is a foreign key into this table, so a relation
-- cannot invent an open-ended label, and the staging scope carries a hard
-- 30-day bound that no row can widen.
create table ops.retention_classes (
  retention_class text primary key
    check (length(btrim(retention_class)) between 1 and 60),
  scope text not null check (scope in (
    'migration_staging', 'account_domain', 'shared_catalogue',
    'operational', 'support', 'bookkeeping'
  )),
  max_days_after_cutover integer
    check (max_days_after_cutover is null or max_days_after_cutover between 1 and 30),
  personal_data_allowed boolean not null,
  description text not null check (length(btrim(description)) between 1 and 1000),
  -- Only the staging scope may carry a post-cutover expiry, and the staging
  -- scope must carry one.  This is the physical form of plan 13's bound.
  check ((scope = 'migration_staging') = (max_days_after_cutover is not null))
);

insert into ops.retention_classes
  (retention_class, scope, max_days_after_cutover, personal_data_allowed, description)
values
  ('staging-30d-post-cutover', 'migration_staging', 30, true,
   'Raw migration staging and export evidence. Purged within 30 days of a validated cutover unless an explicit recorded recovery-incident hold applies. Never the only home of a lasting fact.'),
  ('durable-account-lifetime', 'account_domain', null, true,
   'Lasting private fact about one account. Lives while the account exists, is removed by account deletion through a cascading key, and is included in that account export.'),
  ('durable-catalogue-evidence', 'shared_catalogue', null, false,
   'Shared catalogue or provider evidence with no account key. Current useful evidence retained with bounded revisions; obsolete raw payloads expire on their own relation rule.'),
  ('shared-evidence-de-identifiable', 'shared_catalogue', null, true,
   'Shared catalogue evidence that carries an operator or reviewer account link and must survive that account. Account deletion de-identifies the row rather than removing it, which is only honest because the relation holds no account UUID.'),
  ('bounded-operational', 'operational', null, true,
   'Operational history bounded by its own expiry, lease or retention column rather than by the cutover window. Deleted with the account wherever an account key exists.'),
  ('ui-history-90d', 'operational', null, true,
   'Plan 13 UI draw, impression and action history. The cleanup candidate view keeps at most the latest 100 draws per account and removes rows older than 90 days; completion history is a separate durable domain.'),
  ('operational-config', 'operational', null, false,
   'Operator configuration, quota and provider control state. No account key and no user content, so neither deletion nor export applies.'),
  ('support-pending-decision', 'support', null, true,
   'Support content whose deletion deadline is deliberately unresolved until M6 or M7. The pending decision does not waive account deletion or account export.'),
  ('migration-bookkeeping-permanent', 'bookkeeping', null, false,
   'Run metadata, counts, conflict classes and the schema ledger. Contains no source rows and no personal data, so plan 13 staging bound does not apply.')
on conflict (retention_class) do nothing;

-- Every relation in the private model is registered here with the account key
-- it holds and what account deletion and account export do to it.  The
-- registry is what makes deletion coverage provable rather than asserted: a
-- row that keeps an original account UUID cannot claim `de_identify`, because
-- nulling an integer foreign key would leave that UUID in place.
create table ops.data_retention_registry (
  relation regclass primary key,
  introduced_in text not null check (introduced_in in ('m1', 'm2', 'm3')),
  retention_class text not null references ops.retention_classes(retention_class),
  holds_personal_data boolean not null,
  account_fk_column text
    check (account_fk_column is null or length(btrim(account_fk_column)) between 1 and 63),
  account_uuid_columns text[] not null default '{}'::text[],
  deletion_mode text not null check (deletion_mode in (
    'account_row', 'cascade', 'cascade_via_parent', 'de_identify', 'no_account_link'
  )),
  export_scope text not null check (export_scope in (
    'account_export', 'operator_only', 'no_personal_data'
  )),
  rationale text not null check (length(btrim(rationale)) between 1 and 1000),
  -- A relation holding personal data must name how deletion reaches it.
  check (not holds_personal_data or deletion_mode <> 'no_account_link'),
  check (holds_personal_data or (deletion_mode = 'no_account_link'
                                 and export_scope = 'no_personal_data'
                                 and account_uuid_columns = '{}'::text[])),
  -- De-identification is only honest when there is no surviving account UUID:
  -- ON DELETE SET NULL clears the integer key and nothing else.
  check (deletion_mode <> 'de_identify' or account_uuid_columns = '{}'::text[]),
  -- A cascading relation must actually name the cascading column.
  check (deletion_mode not in ('cascade', 'account_row') or account_fk_column is not null),
  check (export_scope <> 'account_export' or holds_personal_data)
);
create index data_retention_registry_class_idx
  on ops.data_retention_registry (retention_class, introduced_in);

-- The stable project marker belongs to the M1 foundation and intentionally
-- remains schema_version = 'm1'.  Supabase migration history and the durable
-- migration.legacy_schema_migration_ledger record M3 advancement; changing
-- this marker would break the foundation contract and its callers.

-- The active model stays compact.  These columns hold provenance or evidence
-- required by the preservation contract and are intentionally nullable where
-- the old source cannot supply a defensible value.

-- D-IDN-4.  Legacy `app_users.last_login_at` is the interactive-login instant.
-- It is a different fact from `app.accounts.last_seen_at`, which carries
-- `app_accounts.last_visited_at`: `lib/auth.ts` records a visit on any resolved
-- session, explicitly because a month-long session means a returning visitor
-- never touches the sign-in path.  Neither instant may be derived from the
-- other and neither may be shifted by a store/locale offset.  NULL means the
-- source recorded no interactive login and stays NULL.  No ordering check ties
-- the two columns together: the source writes them from separate code paths
-- and they are measured to disagree, so a check would force a coerced value.
alter table app.accounts
  add column last_login_at timestamptz;
comment on column app.accounts.last_login_at is
  'Legacy app_users.last_login_at: last interactive login instant. Distinct from last_seen_at (app_accounts.last_visited_at, any authenticated visit). Nullable; never derived, never offset. Deleted with the account row and included in account export.';

alter table catalog.games
  add column first_seen_at timestamptz,
  add column first_seen_reason text not null default 'unknown',
  add column last_seen_at timestamptz;
alter table catalog.games
  add constraint games_first_seen_reason_chk
    check (first_seen_reason in ('seed', 'user_import', 'manual', 'unknown')),
  add constraint games_seen_order_chk
    check (last_seen_at is null or first_seen_at is null or last_seen_at >= first_seen_at);

alter table catalog.game_metadata
  add column developer text
    check (developer is null or length(developer) <= 1000),
  add column publisher text
    check (publisher is null or length(publisher) <= 1000),
  add column release_date date;

alter table catalog.game_features
  add column extras_duration_minutes integer
    check (extras_duration_minutes is null or extras_duration_minutes >= 0),
  add column duration_source text
    check (duration_source is null or length(btrim(duration_source)) between 1 and 120),
  add column duration_source_game_id bigint
    check (duration_source_game_id is null or duration_source_game_id > 0),
  add column duration_source_updated_at timestamptz,
  add column duration_confidence_label text
    check (duration_confidence_label is null or duration_confidence_label in ('none', 'low', 'medium', 'high')),
  add column duration_status text not null default 'unknown'
    check (duration_status in ('pending', 'processing', 'ready', 'failed', 'no_match', 'review_required', 'unknown')),
  add column duration_kind text not null default 'unknown'
    check (duration_kind in ('finite', 'endless', 'not-applicable', 'unknown')),
  add column duration_manual_override boolean not null default false,
  add column windows_compatibility text not null default 'unknown'
    check (windows_compatibility in ('unknown', 'supported', 'unsupported')),
  add column mac_compatibility text not null default 'unknown'
    check (mac_compatibility in ('unknown', 'supported', 'unsupported')),
  add column deck_compatibility_detail smallint
    check (deck_compatibility_detail is null or deck_compatibility_detail between 0 and 3),
  add column deck_checked_at timestamptz,
  add column review_positive bigint
    check (review_positive is null or review_positive >= 0),
  add column review_negative bigint
    check (review_negative is null or review_negative >= 0),
  add column review_total bigint
    check (review_total is null or review_total >= 0),
  add column popularity_source text
    check (popularity_source is null or length(btrim(popularity_source)) between 1 and 120),
  add column popularity_metric text
    check (popularity_metric is null or length(btrim(popularity_metric)) between 1 and 120),
  add column popularity_low bigint
    check (popularity_low is null or popularity_low >= 0),
  add column popularity_high bigint
    check (popularity_high is null or popularity_high >= 0),
  add column popularity_ccu bigint
    check (popularity_ccu is null or popularity_ccu >= 0),
  add column popularity_observed_on date,
  add column source_captured_on date,
  add column tags_source text
    check (tags_source is null or length(btrim(tags_source)) between 1 and 120),
  add column tags_status text not null default 'unknown'
    check (tags_status in ('pending', 'processing', 'ready', 'failed', 'unknown')),
  add column tags_fetched_at timestamptz,
  add column tags_failure_count integer not null default 0
    check (tags_failure_count >= 0),
  add column tags_last_error text
    check (tags_last_error is null or length(tags_last_error) <= 2000);

alter table app.playtime_daily
  add column observed_minutes_semantic text not null default 'cumulative_total'
    check (observed_minutes_semantic = 'cumulative_total'),
  add column games_with_playtime integer not null default 0
    check (games_with_playtime >= 0);

alter table app.game_activity
  add column recency_evidence_kind text not null default 'unknown'
    check (recency_evidence_kind in (
      'steam_exact', 'observed_playtime_change', 'steam_recent_window', 'unknown'
    ));

alter table app.family_members
  add column legacy_member_id uuid unique,
  add column display_name text
    check (display_name is null or length(btrim(display_name)) between 1 and 200),
  add column avatar_url text
    check (avatar_url is null or length(avatar_url) <= 2048),
  add column profile_url text
    check (profile_url is null or length(profile_url) <= 2048),
  add column legacy_library_seen integer
    check (legacy_library_seen is null or legacy_library_seen >= 0),
  add column legacy_games_imported integer
    check (legacy_games_imported is null or legacy_games_imported >= 0),
  add column last_synced_at timestamptz,
  add column last_error text
    check (last_error is null or length(last_error) <= 2000);

alter table app.collection_games
  add column legacy_position integer
    check (legacy_position is null or legacy_position >= 0),
  add column legacy_created_at timestamptz,
  add column legacy_order bigint
    check (legacy_order is null or legacy_order >= 0),
  add column position_resolution text not null default 'source'
    check (position_resolution in ('source', 'stable_reorder', 'conflict'));

alter table app.pins
  add column legacy_hours_at_pin numeric(30, 12),
  add column legacy_hours_at_pin_raw text
    check (legacy_hours_at_pin_raw is null or length(legacy_hours_at_pin_raw) <= 128),
  add column baseline_conversion_status text not null default 'unknown'
    check (baseline_conversion_status in ('exact_minutes', 'rounded_checked', 'unknown', 'conflict'));

alter table app.completion_events
  add column legacy_event_id uuid unique,
  add column origin_surface text
    check (origin_surface is null or origin_surface in (
      'sweep', 'sweep_bulk', 'library', 'vault', 'purge', 'details'
    )),
  add column legacy_game_id uuid,
  add column legacy_steam_appid bigint
    check (legacy_steam_appid is null or legacy_steam_appid > 0),
  add column legacy_hours_played numeric(30, 12),
  add column legacy_hours_played_raw text
    check (legacy_hours_played_raw is null or length(legacy_hours_played_raw) <= 128),
  add column legacy_estimate_minutes integer
    check (legacy_estimate_minutes is null or legacy_estimate_minutes >= 0),
  add column legacy_price_cents integer
    check (legacy_price_cents is null or legacy_price_cents >= 0),
  add column metric_provenance jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metric_provenance) = 'object' and pg_column_size(metric_provenance) <= 8192);

alter table ops.account_merges
  add column legacy_merge_id uuid unique,
  add column legacy_merge_mode text
    check (legacy_merge_mode is null or length(btrim(legacy_merge_mode)) between 1 and 80),
  add column source_public_id uuid,
  add column target_public_id uuid,
  add column analytics_delivered_at timestamptz;

-- Shared catalogue evidence.  These relations keep provider observations and
-- operator decisions separate from the hot catalogue rows.  The source AppID
-- remains present even when a final game mapping is unresolved.
create table catalog.duration_estimates (
  id bigint generated always as identity primary key,
  game_id integer references catalog.games(id) on delete set null,
  steam_app_id bigint not null check (steam_app_id > 0),
  provider text not null check (length(btrim(provider)) between 1 and 120),
  provider_game_id bigint check (provider_game_id is null or provider_game_id > 0),
  main_story_minutes integer
    check (main_story_minutes is null or main_story_minutes >= 0),
  main_extra_minutes integer
    check (main_extra_minutes is null or main_extra_minutes >= 0),
  completionist_minutes integer
    check (completionist_minutes is null or completionist_minutes >= 0),
  submission_count integer
    check (submission_count is null or submission_count >= 0),
  match_status text not null
    check (match_status in ('matched', 'no_duration', 'not_found', 'ambiguous', 'needs_review')),
  match_confidence text
    check (match_confidence is null or match_confidence in ('none', 'low', 'medium', 'high')),
  provider_updated_at timestamptz,
  checked_at timestamptz not null,
  next_refresh_at timestamptz,
  last_error_code text
    check (last_error_code is null or length(btrim(last_error_code)) between 1 and 120),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  evidence jsonb not null default '{}'::jsonb
    check (jsonb_typeof(evidence) = 'object' and pg_column_size(evidence) <= 262144),
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  unique (steam_app_id, provider)
);
create index duration_estimates_game_idx on catalog.duration_estimates (game_id, provider);

create table catalog.duration_aliases (
  steam_app_id bigint primary key check (steam_app_id > 0),
  game_id integer references catalog.games(id) on delete set null,
  search_title text not null check (length(btrim(search_title)) between 1 and 1000),
  release_year integer check (release_year is null or release_year between 1 and 9999),
  review_status text not null
    check (review_status in ('approved', 'needs_review', 'rejected')),
  notes text check (notes is null or length(notes) <= 10000),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32)
);
create index duration_aliases_game_idx on catalog.duration_aliases (game_id);

-- A review row is evidence, not an implicit rewrite of catalog.games.game_type.
-- `precedence_rank` is explicit so a future resolver can prove manual >
-- automatic > legacy precedence instead of relying on row order.
create table catalog.review_decisions (
  id bigint generated always as identity primary key,
  game_id integer references catalog.games(id) on delete set null,
  steam_app_id bigint not null check (steam_app_id > 0),
  decision_kind text not null
    check (decision_kind in ('quarantine', 'duration', 'catalogue_type', 'manual_override')),
  source_relation text not null
    check (source_relation in ('catalog_game_quarantine', 'catalog_duration_reviews', 'catalog_games')),
  source_record_key text not null check (length(btrim(source_record_key)) between 1 and 200),
  source text not null check (length(btrim(source)) between 1 and 80),
  precedence_rank smallint not null check (precedence_rank between 1 and 100),
  decision_status text not null
    check (decision_status in (
      'pending', 'excluded', 'allowed', 'approved', 'rejected',
      'needs_review', 'retained', 'unresolved'
    )),
  name text check (name is null or length(name) <= 1000),
  steam_type text check (steam_type is null or length(steam_type) between 1 and 120),
  matched_rule text check (matched_rule is null or length(matched_rule) <= 500),
  reason text check (reason is null or length(reason) <= 5000),
  genres jsonb check (genres is null or (jsonb_typeof(genres) = 'array' and pg_column_size(genres) <= 32768)),
  categories jsonb check (categories is null or (jsonb_typeof(categories) = 'array' and pg_column_size(categories) <= 32768)),
  response_text text check (response_text is null or length(response_text) <= 2000),
  response_kind text check (response_kind is null or response_kind in ('hltb_url', 'note')),
  source_url text check (source_url is null or length(source_url) <= 2048),
  -- Reviewer attribution is an integer FK only.  A durable shared catalogue
  -- decision must survive the reviewer's account deletion, so the row is
  -- de-identified rather than deleted; keeping the source reviewer UUID here
  -- would leave personal data behind after ON DELETE SET NULL fired.  The
  -- source reviewer UUID lives only in bounded migration staging.
  reviewer_account_id integer references app.accounts(id) on delete set null,
  reviewed_at timestamptz,
  review_notes text check (review_notes is null or length(review_notes) <= 10000),
  duration_manual_override boolean not null default false,
  source_payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(source_payload) = 'object' and pg_column_size(source_payload) <= 262144),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  unique (source_relation, source_record_key),
  check ((response_kind = 'hltb_url' and source_url is not null)
      or (response_kind = 'note' and source_url is null)
      or response_kind is null)
);
create index review_decisions_game_idx on catalog.review_decisions (game_id, decision_kind, precedence_rank desc);
create index review_decisions_appid_idx on catalog.review_decisions (steam_app_id, updated_at desc);

-- Offers are deliberately US-only in this migration.  A row is an observed
-- provider offer, never an inferred regional price.  Price observations carry
-- bounded retention so this relation cannot become indefinite price history.
create table catalog.offers (
  id bigint generated always as identity primary key,
  game_id integer not null references catalog.games(id) on delete cascade,
  provider text not null check (length(btrim(provider)) between 1 and 120),
  region_code text not null default 'US' check (region_code = 'US'),
  source_offer_id text check (source_offer_id is null or length(source_offer_id) <= 200),
  is_free boolean,
  first_observed_at timestamptz not null,
  last_observed_at timestamptz not null,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  unique (game_id, provider, region_code),
  check (last_observed_at >= first_observed_at)
);

create table catalog.offer_prices (
  id bigint generated always as identity primary key,
  offer_id bigint not null references catalog.offers(id) on delete cascade,
  observed_at timestamptz not null,
  currency text not null default 'USD' check (currency = 'USD'),
  price_initial_cents integer check (price_initial_cents is null or price_initial_cents >= 0),
  price_final_cents integer check (price_final_cents is null or price_final_cents >= 0),
  discount_percent smallint
    check (discount_percent is null or discount_percent between 0 and 100),
  is_free boolean not null,
  is_current boolean not null default true,
  source_observed_at timestamptz,
  retention_until timestamptz not null,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  unique (offer_id, observed_at),
  check (retention_until >= observed_at),
  check (price_final_cents is null or price_initial_cents is null or price_final_cents <= price_initial_cents)
);
create unique index offer_prices_current_uq on catalog.offer_prices (offer_id) where is_current;

create table catalog.provider_state (
  game_id integer not null references catalog.games(id) on delete cascade,
  provider text not null check (length(btrim(provider)) between 1 and 120),
  evidence_kind text not null
    check (evidence_kind in ('metadata', 'tags', 'duration', 'deck', 'offer')),
  status text not null
    check (status in ('pending', 'processing', 'ready', 'failed', 'no_match', 'review_required', 'unknown')),
  failure_count integer not null default 0 check (failure_count >= 0),
  next_attempt_at timestamptz,
  processing_started_at timestamptz,
  fetched_at timestamptz,
  last_error_code text check (last_error_code is null or length(btrim(last_error_code)) between 1 and 120),
  last_error text check (last_error is null or length(last_error) <= 2000),
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  updated_at timestamptz not null,
  primary key (game_id, provider, evidence_kind),
  check (processing_started_at is null or status = 'processing' or status = 'failed'),
  check (next_attempt_at is null or status in ('pending', 'failed', 'review_required'))
);

-- Durable shared catalogue provenance.  These four relations are the domain
-- destinations for facts that the earlier draft parked in `migration` under
-- open-ended labels such as "until v2 derives equivalent history".  They hold
-- no personal data: a sighting count, a seed/import run, and the terminal
-- provider verdict for an AppID.  Migration staging keeps only the raw source
-- rows they were derived from, for the bounded post-cutover window.

create table catalog.game_sightings (
  steam_app_id bigint primary key check (steam_app_id > 0),
  game_id integer references catalog.games(id) on delete set null,
  import_count bigint not null check (import_count >= 0),
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  updated_at timestamptz not null default now(),
  check (last_seen_at is null or first_seen_at is null or last_seen_at >= first_seen_at)
);
create index game_sightings_game_idx on catalog.game_sightings (game_id);

create table catalog.seed_runs (
  legacy_id uuid primary key,
  source text not null check (length(btrim(source)) between 1 and 200),
  metric text not null check (length(btrim(metric)) between 1 and 200),
  captured_on date not null,
  requested_count integer not null check (requested_count >= 0),
  accepted_count integer not null check (accepted_count >= 0 and accepted_count <= requested_count),
  source_url text check (source_url is null or length(source_url) <= 2048),
  source_sha256 text check (source_sha256 is null or source_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32)
);

create table catalog.duration_imports (
  legacy_id uuid primary key,
  source text not null check (length(btrim(source)) between 1 and 200),
  imported_count integer not null check (imported_count >= 0),
  skipped_count integer not null check (skipped_count >= 0),
  expected_app_count integer check (expected_app_count is null or expected_app_count >= 0),
  staged_row_count integer check (staged_row_count is null or staged_row_count >= 0),
  status text not null
    check (status in ('planned', 'running', 'succeeded', 'partial', 'failed', 'abandoned')),
  source_sha256 text check (source_sha256 is null or source_sha256 ~ '^[0-9a-f]{64}$'),
  source_updated_at timestamptz,
  created_at timestamptz not null,
  completed_at timestamptz,
  manifest jsonb not null default '{}'::jsonb
    check (jsonb_typeof(manifest) = 'object' and pg_column_size(manifest) <= 262144),
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  check (completed_at is null or completed_at >= created_at)
);

-- Plan 14.2 requires terminal rejection/backoff state to survive so a failed
-- identity is not retried forever.  This is keyed by AppID rather than by a
-- catalogue row, because the rejected identities are exactly the ones with no
-- `catalog.games` row.  Only terminal verdicts are durable; the transient
-- queue/job rows stay in bounded staging.
create table catalog.appid_terminal_rejections (
  steam_app_id bigint not null check (steam_app_id > 0),
  evidence_kind text not null
    check (evidence_kind in ('ingest', 'duration', 'metadata', 'tags', 'deck')),
  provider text not null default 'unknown'
    check (length(btrim(provider)) between 1 and 120),
  terminal_status text not null
    check (terminal_status in ('rejected', 'not_found', 'no_match', 'permanently_failed')),
  reason text not null check (length(reason) between 1 and 5000),
  attempts integer not null check (attempts >= 0),
  last_error_code text
    check (last_error_code is null or length(btrim(last_error_code)) between 1 and 160),
  first_requested_at timestamptz,
  last_attempt_at timestamptz not null,
  source_relation text not null
    check (source_relation in ('catalog_ingest_queue', 'game_duration_jobs', 'catalog_games')),
  retry_allowed_after timestamptz,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  recorded_at timestamptz not null default now(),
  primary key (steam_app_id, evidence_kind, provider),
  check (first_requested_at is null or last_attempt_at >= first_requested_at)
);

-- Draw history is bounded UI history, separate from the current app.vault_state
-- pick. Source UUIDs are retained as public_id so the M1 current_draw_ref can
-- be made referentially valid without exposing a raw source table or
-- manufacturing a fresh identity.
create table app.vault_draws (
  id bigint generated always as identity primary key,
  public_id uuid not null unique,
  account_id integer not null references app.accounts(id) on delete cascade,
  game_id integer references catalog.games(id) on delete set null,
  steam_app_id bigint not null check (steam_app_id > 0),
  drawn_at timestamptz not null,
  session text check (session is null or length(btrim(session)) between 1 and 80),
  mood text check (mood is null or length(btrim(mood)) between 1 and 80),
  goal text check (goal is null or length(btrim(goal)) between 1 and 80),
  source_collection_id uuid,
  collection_id bigint,
  selected_genres jsonb not null default '[]'::jsonb
    check (jsonb_typeof(selected_genres) = 'array' and pg_column_size(selected_genres) <= 32768),
  eligible_pool_count integer not null check (eligible_pool_count >= 0),
  reroll_index integer not null check (reroll_index >= 0),
  finalist_app_ids jsonb
    check (jsonb_typeof(finalist_app_ids) = 'array'
      and jsonb_array_length(finalist_app_ids) <= 10000
      and pg_column_size(finalist_app_ids) <= 262144),
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  created_at timestamptz not null default now(),
  unique (account_id, id),
  unique (account_id, public_id),
  -- Column-specific SET NULL detaches the collection while preserving the
  -- required tenant key when the collection is deleted.
  foreign key (account_id, collection_id)
    references app.collections(account_id, id) on delete set null (collection_id)
);
create index vault_draws_account_time_idx
  on app.vault_draws (account_id, drawn_at desc, id desc);

create table app.vault_draw_events (
  id bigint generated always as identity primary key,
  public_id uuid not null unique,
  account_id integer not null references app.accounts(id) on delete cascade,
  draw_id bigint not null,
  event_type text not null check (length(btrim(event_type)) between 1 and 100),
  occurred_at timestamptz not null,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  unique (account_id, id),
  foreign key (account_id, draw_id)
    references app.vault_draws(account_id, id) on delete cascade
);
create index vault_draw_events_account_time_idx
  on app.vault_draw_events (account_id, occurred_at desc, id desc);

create table app.vault_events (
  id bigint generated always as identity primary key,
  public_id uuid not null unique,
  account_id integer not null references app.accounts(id) on delete cascade,
  game_id integer references catalog.games(id) on delete set null,
  legacy_game_id uuid,
  action text not null check (length(btrim(action)) between 1 and 100),
  context jsonb not null default '{}'::jsonb
    check (jsonb_typeof(context) = 'object' and pg_column_size(context) <= 65536),
  occurred_at timestamptz not null,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  unique (account_id, id)
);
create index vault_events_account_time_idx
  on app.vault_events (account_id, occurred_at desc, id desc);

-- Plan 13 UI history is bounded by both age and count.  The M6 cleanup runner
-- consumes this owner-only candidate view in small account-scoped batches:
-- draws older than 90 days, draws beyond the latest 100 per account, their
-- draw events, and action events older than 90 days. The existing account/time
-- indexes support the account-scoped age scans and deterministic latest-100
-- ranking when the runner binds an account; this migration never executes a
-- purge.
create view app.ui_history_retention_candidates as
with ranked_draws as not materialized (
  select d.id,
         d.account_id,
         d.drawn_at,
         row_number() over (
           partition by d.account_id
           order by d.drawn_at desc, d.id desc
         ) as draw_rank
    from app.vault_draws d
)
select 'app.vault_draws'::text as relation_name,
       d.account_id,
       d.id as row_id,
       d.drawn_at + interval '90 days' as expires_at,
       case when d.drawn_at + interval '90 days' <= now()
            then 'age-90d' else 'draw-cap' end as reason
  from ranked_draws d
 where d.drawn_at + interval '90 days' <= now()
    or d.draw_rank > 100
union all
select 'app.vault_draw_events'::text,
       e.account_id,
       e.id,
       e.occurred_at + interval '90 days',
       case when e.occurred_at + interval '90 days' <= now()
            then 'age-90d' else 'parent-draw-cap' end
  from app.vault_draw_events e
  join ranked_draws d
    on d.account_id = e.account_id and d.id = e.draw_id
 where e.occurred_at + interval '90 days' <= now()
    or d.draw_rank > 100
union all
select 'app.vault_events'::text,
       e.account_id,
       e.id,
       e.occurred_at + interval '90 days',
       'age-90d'::text
  from app.vault_events e
 where e.occurred_at + interval '90 days' <= now();

-- Completion history keeps the M1 resolved-event invariant while retaining
-- source events that cannot resolve to a catalogue/library identity.  The
-- registry is the cross-table uniqueness gate for legacy event IDs.
create table app.unknown_completion_history (
  id bigint generated always as identity primary key,
  legacy_event_id uuid not null unique,
  account_id integer not null references app.accounts(id) on delete cascade,
  source_game_id uuid,
  source_steam_appid bigint check (source_steam_appid is null or source_steam_appid > 0),
  actor text not null check (length(btrim(actor)) between 1 and 80),
  origin_surface text not null check (origin_surface in (
    'sweep', 'sweep_bulk', 'library', 'vault', 'purge', 'details'
  )),
  occurred_at timestamptz not null,
  undone_at timestamptz,
  state text not null check (state in ('occurred', 'undone')),
  legacy_hours_played numeric(30, 12),
  legacy_hours_played_raw text
    check (legacy_hours_played_raw is null or length(legacy_hours_played_raw) <= 128),
  legacy_estimate_minutes integer
    check (legacy_estimate_minutes is null or legacy_estimate_minutes >= 0),
  legacy_price_cents integer
    check (legacy_price_cents is null or legacy_price_cents >= 0),
  metric_provenance jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metric_provenance) = 'object' and pg_column_size(metric_provenance) <= 8192),
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  created_at timestamptz not null default now(),
  check ((state = 'occurred' and undone_at is null)
      or (state = 'undone' and undone_at is not null and undone_at >= occurred_at))
);
create index unknown_completion_history_account_time_idx
  on app.unknown_completion_history (account_id, occurred_at desc);

create table app.completion_event_registry (
  legacy_event_id uuid primary key,
  account_id integer not null references app.accounts(id) on delete cascade,
  record_kind text not null check (record_kind in ('resolved', 'unknown')),
  resolved_event_id bigint,
  unknown_history_id bigint,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  created_at timestamptz not null default now(),
  check ((record_kind = 'resolved' and resolved_event_id is not null and unknown_history_id is null)
      or (record_kind = 'unknown' and resolved_event_id is null and unknown_history_id is not null)),
  foreign key (resolved_event_id) references app.completion_events(id) on delete cascade,
  foreign key (unknown_history_id) references app.unknown_completion_history(id) on delete cascade
);
create unique index completion_registry_resolved_uq
  on app.completion_event_registry (resolved_event_id) where resolved_event_id is not null;
create unique index completion_registry_unknown_uq
  on app.completion_event_registry (unknown_history_id) where unknown_history_id is not null;

-- Sparse durable library evidence.
--
-- The measured source population has exact observed minutes on all 365,610
-- owned rows and, at that observation, none disagreed with the reviewed
-- decimal-hours formula.  A legacy hours value that the formula reproduces
-- from the preserved exact minutes is therefore not independent evidence and
-- does not need a durable row; the raw staging copy covers the bounded
-- reconciliation window.  A value the formula does NOT reproduce is
-- unreproducible evidence with no other home, so it gets a durable row here.
--
-- An hours discrepancy is a disagreement, not proof that a user typed the
-- number.  `authorship` therefore defaults to `unknown` and only a separate,
-- documented decision may move it; nothing in the source proves authorship.
-- The compact app.library_games row is not widened for these exceptions, and
-- family rows with unknown minutes stay unknown rather than becoming zero.
create table app.library_legacy_measurements (
  account_id integer not null references app.accounts(id) on delete cascade,
  game_id integer references catalog.games(id) on delete set null,
  steam_app_id bigint not null check (steam_app_id > 0),
  ownership_kind text not null default 'unknown'
    check (ownership_kind in ('personal', 'family', 'unknown')),
  observed_minutes_at_freeze integer
    check (observed_minutes_at_freeze is null or observed_minutes_at_freeze >= 0),
  legacy_hours_played numeric(30, 12)
    check (legacy_hours_played is null or legacy_hours_played >= 0),
  legacy_hours_played_raw text
    check (legacy_hours_played_raw is null or length(legacy_hours_played_raw) <= 128),
  legacy_completion_percentage numeric(30, 12),
  legacy_completion_percentage_raw text
    check (legacy_completion_percentage_raw is null or length(legacy_completion_percentage_raw) <= 128),
  legacy_date_added_raw text
    check (legacy_date_added_raw is null or length(legacy_date_added_raw) <= 128),
  discrepancy_kind text not null
    check (discrepancy_kind in (
      'hours_not_reproducible', 'completion_percentage_only',
      'date_added_text_only', 'unknown_minutes_with_hours', 'multiple'
    )),
  conversion_formula text
    check (conversion_formula is null or length(btrim(conversion_formula)) between 1 and 200),
  authorship text not null default 'unknown'
    check (authorship in ('unknown', 'user_authored', 'provider_derived')),
  authorship_evidence text
    check (authorship_evidence is null or length(authorship_evidence) <= 2000),
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  recorded_at timestamptz not null default now(),
  primary key (account_id, steam_app_id),
  -- A durable row must carry at least one value that the compact model cannot
  -- reproduce; an empty exception row is not evidence.
  check (legacy_hours_played is not null
      or legacy_hours_played_raw is not null
      or legacy_completion_percentage is not null
      or legacy_completion_percentage_raw is not null
      or legacy_date_added_raw is not null),
  -- Authorship may only be asserted with recorded evidence for it.
  check (authorship = 'unknown' or authorship_evidence is not null)
);

-- Sparse durable evidence for the stale user_game_state child.  The complete
-- child remains bounded reconciliation staging below; only rows whose raw
-- code, timestamp or authored value is the sole surviving evidence are
-- promoted here by an explicit loader disposition.  Keeping this destination
-- free of a target game FK makes the archive incapable of becoming runtime
-- state/activity authority by accident.
create table app.game_state_legacy_measurements (
  account_id integer not null references app.accounts(id) on delete cascade,
  steam_app_id bigint not null check (steam_app_id > 0),
  source_user_id uuid not null,
  raw_completed_at timestamptz,
  raw_slept_at timestamptz,
  raw_prev_active_status smallint,
  raw_dismissed_at timestamptz,
  raw_dismissed_playtime numeric,
  raw_review_requested_at timestamptz,
  raw_last_played_at timestamptz,
  raw_last_observed_at timestamptz,
  raw_recency_code smallint,
  raw_recency_evidence_at timestamptz,
  raw_family_owner_steam_id text
    check (raw_family_owner_steam_id is null or length(raw_family_owner_steam_id) <= 200),
  raw_family_verified_at timestamptz,
  evidence_reason text not null
    check (evidence_reason in (
      'stale_conflict', 'unresolved_codebook', 'non_integral_dismissed_playtime',
      'source_provenance', 'multiple'
    )),
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  recorded_at timestamptz not null default now(),
  primary key (account_id, steam_app_id),
  check (raw_completed_at is not null
      or raw_slept_at is not null
      or raw_prev_active_status is not null
      or raw_dismissed_at is not null
      or raw_dismissed_playtime is not null
      or raw_review_requested_at is not null
      or raw_last_played_at is not null
      or raw_last_observed_at is not null
      or raw_recency_code is not null
      or raw_recency_evidence_at is not null
      or raw_family_owner_steam_id is not null
      or raw_family_verified_at is not null)
);
create index game_state_legacy_measurements_account_idx
  on app.game_state_legacy_measurements (account_id, recorded_at desc);

-- Purge reviews are authored decisions about the account's own library, so
-- they are durable account history rather than staging.  The source game UUID
-- stays in staging; the durable row carries the resolved catalogue identity
-- and the AppID, and is deleted with the account.
create table app.purge_review_history (
  id bigint generated always as identity primary key,
  account_id integer not null references app.accounts(id) on delete cascade,
  game_id integer references catalog.games(id) on delete set null,
  steam_app_id bigint check (steam_app_id is null or steam_app_id > 0),
  action text not null check (action in ('keep', 'pin', 'sleep', 'complete')),
  reviewed_at timestamptz not null,
  playtime_minutes_at_review integer not null check (playtime_minutes_at_review >= 0),
  progress_at_review integer
    check (progress_at_review is null or progress_at_review between 0 and 100),
  last_played_at_review timestamptz,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  unique (account_id, id)
);
create index purge_review_history_account_idx
  on app.purge_review_history (account_id, reviewed_at desc);

-- Orphan family access is the account's own access evidence with no surviving
-- lender row.  It is retained because it is the sole record of that access; it
-- confers nothing, manufactures no app.family_members row, and grants no
-- verification.  It is personal data, so it lives in the account domain and is
-- deleted with the account.
create table app.family_access_orphans (
  id bigint generated always as identity primary key,
  account_id integer not null references app.accounts(id) on delete cascade,
  game_id integer references catalog.games(id) on delete set null,
  steam_app_id bigint not null check (steam_app_id > 0),
  lender_steam_id bigint check (lender_steam_id is null or lender_steam_id > 0),
  observed_at timestamptz,
  disposition text not null default 'quarantine'
    check (disposition in ('quarantine', 'manual_review', 'resolved')),
  confers_access boolean not null default false check (confers_access = false),
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  recorded_at timestamptz not null default now(),
  unique (account_id, steam_app_id, lender_steam_id)
);

-- The source capability tuple is a lasting private fact about the account: it
-- is the only record of what the provider actually showed, and the v2
-- projection deliberately reduces false/NULL to `unknown`.  It therefore lives
-- in the account domain, not in bounded migration staging, and is deleted with
-- the account.  A false legacy flag means that no positive hours/last-played
-- value was observed; it is not evidence that the account is private.
--
-- Both sides of a disagreement are retained as separate rows distinguished by
-- `evidence_precedence`, so the account-side writer tuple can be authoritative
-- without erasing the profile-side observation.  It stays out of the compact
-- app.account_capabilities row and out of the compact library.
create table app.account_capability_evidence (
  id bigint generated always as identity primary key,
  account_id integer not null references app.accounts(id) on delete cascade,
  source_account_kind text not null
    check (source_account_kind in ('steam', 'manual', 'unknown')),
  evidence_precedence text not null
    check (evidence_precedence in ('account_writer', 'profile_reader', 'manual_review', 'unknown')),
  raw_library_visible boolean,
  raw_playtime_visible boolean,
  raw_last_played_visible boolean,
  raw_checked_at timestamptz,
  raw_games_count integer check (raw_games_count is null or raw_games_count >= 0),
  raw_visibility_status text
    check (raw_visibility_status is null or length(raw_visibility_status) <= 120),
  -- true may establish visible; false and NULL project to unknown unless
  -- separate validated privacy evidence exists.  `hidden` is not reachable
  -- from these booleans alone, so it is not an accepted projection value here.
  projection_status text not null default 'unresolved'
    check (projection_status in ('visible', 'unknown', 'conflict', 'unresolved')),
  conflict_code text
    check (conflict_code is null or length(btrim(conflict_code)) between 1 and 120),
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  captured_at timestamptz not null default now(),
  evidence jsonb not null default '{}'::jsonb
    check (jsonb_typeof(evidence) = 'object' and pg_column_size(evidence) <= 32768),
  unique (account_id, evidence_precedence, captured_at),
  -- A positive projection needs a positive raw observation on the tuple.
  check (projection_status <> 'visible'
      or raw_library_visible is true
      or raw_playtime_visible is true
      or raw_last_played_visible is true)
);
create index account_capability_evidence_account_idx
  on app.account_capability_evidence (account_id, captured_at desc);

-- A frozen warm-start snapshot is a separate relation from live learned
-- preferences.  Replacing a snapshot creates a new version; it never mutates
-- the values used to explain an earlier recommendation.
create table reco.warm_start_snapshots (
  id bigint generated always as identity primary key,
  snapshot_key text not null check (length(btrim(snapshot_key)) between 1 and 200),
  source_project_ref text check (source_project_ref is null or length(btrim(source_project_ref)) <= 200),
  source_captured_at timestamptz,
  source_manifest_hash bytea
    check (source_manifest_hash is null or octet_length(source_manifest_hash) = 32),
  snapshot_version integer not null check (snapshot_version > 0),
  status text not null check (status in ('frozen', 'replaced')),
  frozen_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (snapshot_key, snapshot_version),
  check (status = 'frozen' or status = 'replaced')
);

-- A per-account warm-start aggregate is personal data even though it is a
-- derived aggregate, so it is keyed by the target account and cascades on
-- account deletion.  The source user UUID is retained as provenance inside the
-- same row, which is what makes the cascade sufficient: deleting the account
-- removes the source identifier with it.
create table reco.user_genre_preferences (
  snapshot_id bigint not null references reco.warm_start_snapshots(id) on delete cascade,
  account_id integer not null references app.accounts(id) on delete cascade,
  source_user_id uuid not null,
  genre text not null check (length(btrim(genre)) between 1 and 200),
  mood text not null default 'any'
    check (mood in ('any', 'brain-off', 'chill', 'intense')),
  positive numeric(30, 12) not null check (positive >= 0),
  total numeric(30, 12) not null check (total >= positive),
  source_updated_at timestamptz,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  primary key (snapshot_id, account_id, genre, mood),
  unique (snapshot_id, source_user_id, genre, mood)
);

create table reco.genre_preference_globals (
  snapshot_id bigint not null references reco.warm_start_snapshots(id) on delete cascade,
  genre text not null check (length(btrim(genre)) between 1 and 200),
  mood text not null default 'any'
    check (mood in ('any', 'brain-off', 'chill', 'intense')),
  positive numeric(30, 12) not null check (positive >= 0),
  total numeric(30, 12) not null check (total >= positive),
  source_updated_at timestamptz,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  primary key (snapshot_id, genre, mood)
);

create table reco.game_preference_globals (
  snapshot_id bigint not null references reco.warm_start_snapshots(id) on delete cascade,
  steam_app_id bigint not null check (steam_app_id > 0),
  game_id integer references catalog.games(id) on delete set null,
  positive numeric(30, 12) not null check (positive >= 0),
  total numeric(30, 12) not null check (total >= positive),
  total_hours numeric(30, 12) not null check (total_hours >= 0),
  source_updated_at timestamptz,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  primary key (snapshot_id, steam_app_id)
);
create index game_preference_globals_game_idx
  on reco.game_preference_globals (game_id, snapshot_id);

create table reco.operator_weight_versions (
  id bigint generated always as identity primary key,
  config_version text not null check (length(btrim(config_version)) between 1 and 200),
  weight_key text not null check (length(btrim(weight_key)) between 1 and 200),
  positive numeric(30, 12) not null check (positive >= 0),
  total numeric(30, 12) not null check (total >= positive),
  note text check (note is null or length(note) <= 10000),
  source_updated_at timestamptz,
  effective_at timestamptz,
  supersedes_id bigint references reco.operator_weight_versions(id) on delete set null,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  created_at timestamptz not null default now(),
  unique (config_version, weight_key)
);

-- Cooldown evidence is private operations history.  Only the digest and the
-- observed window are retained; the source key is never copied to this table.
create table ops.abuse_cooldowns (
  id bigint generated always as identity primary key,
  bucket text not null check (bucket ~ '^[a-z0-9_]{1,80}$'),
  key_digest bytea not null check (octet_length(key_digest) = 32),
  -- A digest is pseudonymous, not anonymous.  When the source bucket is keyed
  -- by an account the mapped account is recorded so deletion reaches the row;
  -- an IP/anonymous bucket leaves this NULL and expires on its own window.
  account_id integer references app.accounts(id) on delete cascade,
  window_started_at timestamptz not null,
  source_window_seconds integer check (source_window_seconds is null or source_window_seconds > 0),
  request_count integer not null check (request_count > 0),
  source_updated_at timestamptz,
  observed_at timestamptz not null,
  expires_at timestamptz,
  algorithm_version text not null check (length(btrim(algorithm_version)) between 1 and 120),
  status text not null check (status in ('active', 'expired', 'conflict', 'unknown')),
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  unique (bucket, key_digest),
  check (expires_at is null or expires_at >= window_started_at),
  check (source_updated_at is null or source_updated_at >= window_started_at)
);
create index abuse_cooldowns_expiry_idx on ops.abuse_cooldowns (expires_at) where status = 'active';

-- No retention deadline is invented here.  A concrete policy must be chosen
-- at the stated milestone before support rows can be purged.
create table support.retention_policy_decisions (
  policy_key text primary key check (length(btrim(policy_key)) between 1 and 160),
  review_milestone text not null check (review_milestone in ('M6', 'M7', 'M6-or-M7')),
  decision_status text not null check (decision_status in ('pending', 'accepted', 'rejected')),
  rationale text not null check (length(btrim(rationale)) between 1 and 5000),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  check ((decision_status = 'pending' and decided_at is null)
      or (decision_status in ('accepted', 'rejected') and decided_at is not null))
);
insert into support.retention_policy_decisions
  (policy_key, review_milestone, decision_status, rationale)
values
  ('support-content-retention', 'M6-or-M7', 'pending',
   'Retention deadline is intentionally unresolved; decide at M6 or M7 before purge.')
on conflict (policy_key) do nothing;

-- The support content-retention deadline is deliberately unresolved, but that
-- pending decision does not waive account deletion or export.  A support row
-- that names a source account cascades with that account; the source public
-- UUID and the mapped integer key are required to appear together, so an
-- ON DELETE SET NULL could not leave the UUID behind even in principle.  A row
-- with neither is an unauthenticated contact and has no account to delete.
create table support.contact_messages (
  source_record_id uuid primary key,
  source_account_public_id uuid,
  account_id integer references app.accounts(id) on delete cascade,
  check ((account_id is null) = (source_account_public_id is null)),
  enquiry_type smallint not null,
  email text not null check (length(email) <= 320),
  subject text not null check (length(btrim(subject)) between 3 and 150),
  message text not null check (length(btrim(message)) between 10 and 5000),
  dedupe_hash text check (dedupe_hash is null or dedupe_hash ~ '^[0-9a-f]{64}$'),
  status_code smallint not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  retention_policy_key text not null default 'support-content-retention'
    references support.retention_policy_decisions(policy_key),
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32)
);

create table support.feedback_submissions (
  source_record_id uuid primary key,
  source_account_public_id uuid,
  account_id integer references app.accounts(id) on delete cascade,
  check ((account_id is null) = (source_account_public_id is null)),
  feedback_type smallint not null check (feedback_type in (0, 1)),
  message text not null check (length(btrim(message)) between 10 and 2000),
  contact_allowed boolean not null default false,
  contact_email text check (contact_email is null or length(contact_email) <= 320),
  route text check (route is null or length(route) <= 300),
  app_area text check (app_area is null or length(app_area) <= 80),
  client_context jsonb not null default '{}'::jsonb
    check (jsonb_typeof(client_context) = 'object' and pg_column_size(client_context) <= 4096),
  dedupe_hash text check (dedupe_hash is null or dedupe_hash ~ '^[0-9a-f]{64}$'),
  status_code smallint not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  retention_policy_key text not null default 'support-content-retention'
    references support.retention_policy_decisions(policy_key),
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  check (contact_allowed or contact_email is null)
);

-- Identity maps are the only place where source identifiers are assigned
-- target surrogate keys.  Both directions are unique so a retry cannot make
-- a second target identity for the same source row.
-- Identity maps hold a legacy account UUID, so an account deletion must take
-- the map row with it.  RESTRICT would have made a v2 account deletion fail
-- outright and left the legacy identifier in place.
create table migration.account_map (
  legacy_id uuid primary key,
  account_id integer not null unique references app.accounts(id) on delete cascade,
  source_kind text not null check (source_kind in ('app_users', 'app_accounts', 'manual_profile', 'unknown')),
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  mapped_at timestamptz not null default now()
);

create table migration.game_map (
  steam_appid bigint primary key check (steam_appid > 0),
  game_id integer not null unique references catalog.games(id) on delete restrict,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  mapped_at timestamptz not null default now()
);

create table migration.library_row_map (
  legacy_id uuid primary key,
  account_id integer not null references app.accounts(id) on delete cascade,
  game_id integer not null references catalog.games(id) on delete restrict,
  steam_appid bigint not null check (steam_appid > 0),
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  mapped_at timestamptz not null default now(),
  unique (account_id, game_id),
  unique (account_id, steam_appid)
);

create table migration.collection_map (
  legacy_id uuid primary key,
  account_id integer not null references app.accounts(id) on delete cascade,
  collection_id bigint not null unique,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  mapped_at timestamptz not null default now(),
  foreign key (account_id, collection_id)
    references app.collections(account_id, id) on delete cascade
);

create table migration.session_map (
  legacy_id uuid primary key,
  account_id integer not null references app.accounts(id) on delete cascade,
  session_id bigint not null unique,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  mapped_at timestamptz not null default now(),
  foreign key (account_id, session_id)
    references app.sessions(account_id, id) on delete cascade
);

create table migration.runs (
  run_id uuid primary key default gen_random_uuid(),
  snapshot_key text not null check (length(btrim(snapshot_key)) between 1 and 200),
  source_project_ref text check (source_project_ref is null or length(btrim(source_project_ref)) <= 200),
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  started_at timestamptz not null,
  finished_at timestamptz,
  status text not null check (status in ('planned', 'running', 'succeeded', 'failed', 'blocked')),
  current_phase text check (current_phase is null or length(btrim(current_phase)) between 1 and 120),
  operator_role text not null default 'postgres'
    check (length(btrim(operator_role)) between 1 and 120),
  check (finished_at is null or finished_at >= started_at),
  check ((status in ('planned', 'running') and finished_at is null)
      or (status in ('succeeded', 'failed', 'blocked') and finished_at is not null))
);

create table migration.applied_steps (
  run_id uuid not null references migration.runs(run_id) on delete cascade,
  phase text not null check (length(btrim(phase)) between 1 and 120),
  status text not null check (status in ('started', 'complete', 'failed', 'blocked')),
  restart_watermark text,
  started_at timestamptz not null,
  finished_at timestamptz,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  details jsonb not null default '{}'::jsonb
    check (jsonb_typeof(details) = 'object' and pg_column_size(details) <= 32768),
  primary key (run_id, phase),
  check (finished_at is null or finished_at >= started_at),
  check ((status = 'started' and finished_at is null)
      or (status <> 'started' and finished_at is not null))
);

create table migration.relation_counts (
  run_id uuid not null references migration.runs(run_id) on delete cascade,
  relation_name text not null check (length(btrim(relation_name)) between 1 and 200),
  source_rows bigint not null check (source_rows >= 0),
  loaded_rows bigint not null check (loaded_rows >= 0),
  archived_rows bigint not null default 0 check (archived_rows >= 0),
  conflict_rows bigint not null default 0 check (conflict_rows >= 0),
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  counted_at timestamptz not null default now(),
  primary key (run_id, relation_name)
);

-- Conflict reports intentionally contain counts and decisions only.  Raw
-- source values belong in a named evidence/archive relation, never in this
-- per-class ledger.
create table migration.conflict_report (
  run_id uuid not null references migration.runs(run_id) on delete cascade,
  conflict_class text not null check (length(btrim(conflict_class)) between 1 and 160),
  source_relation text not null check (length(btrim(source_relation)) between 1 and 200),
  source_column text not null check (length(btrim(source_column)) between 1 and 200),
  conflict_count bigint not null check (conflict_count >= 0),
  decision text not null check (length(btrim(decision)) between 1 and 5000),
  details jsonb not null default '{}'::jsonb
    check (jsonb_typeof(details) = 'object' and pg_column_size(details) <= 32768),
  reported_at timestamptz not null default now(),
  primary key (run_id, conflict_class, source_relation, source_column)
);

-- The 30-day staging window is anchored to one recorded instant: the validated
-- cutover.  Until that instant exists the window has not started, and no
-- staging row is due for deletion; once it exists, every staging relation is
-- due at exactly the same computed time unless a recorded recovery-incident
-- hold covers it.  The window itself cannot be widened past 30 days.
create table migration.cutover_state (
  singleton boolean primary key default true check (singleton),
  validated_cutover_at timestamptz,
  validated_by text
    check (validated_by is null or length(btrim(validated_by)) between 1 and 200),
  staging_retention_days integer not null default 30
    check (staging_retention_days between 1 and 30),
  parity_report_ref text
    check (parity_report_ref is null or length(btrim(parity_report_ref)) between 1 and 400),
  notes text check (notes is null or length(notes) <= 5000),
  updated_at timestamptz not null default now(),
  check ((validated_cutover_at is null) = (validated_by is null))
);
insert into migration.cutover_state (singleton, validated_cutover_at, validated_by, notes)
values (true, null, null,
        'No cutover has been validated. The staging retention window has not started and no purge is authorized.')
on conflict (singleton) do nothing;

-- Plan 13 allows staging to outlive the window only for an explicit recovery
-- incident.  A hold is therefore a row with a named incident, an approver, a
-- rationale and its own expiry: it is bounded, auditable, and per relation.
create table migration.retention_holds (
  id bigint generated always as identity primary key,
  relation regclass not null references ops.data_retention_registry(relation),
  incident_ref text not null check (length(btrim(incident_ref)) between 1 and 200),
  approved_by text not null check (length(btrim(approved_by)) between 1 and 200),
  rationale text not null check (length(btrim(rationale)) between 1 and 2000),
  opened_at timestamptz not null default now(),
  expires_at timestamptz not null,
  released_at timestamptz,
  check (expires_at > opened_at),
  check (released_at is null or released_at >= opened_at)
);
create index retention_holds_active_idx
  on migration.retention_holds (relation, expires_at) where released_at is null;

-- Operator view of the bound.  `due_at` is null while no cutover is validated;
-- `purge_due` is true only for a staging relation past its window with no live
-- hold.  A test can assert directly that no staging relation can report a
-- due_at later than cutover + 30 days.
create view migration.staging_retention_status as
select
  r.relation,
  n.nspname as schema_name,
  c.relname as relation_name,
  r.retention_class,
  cs.validated_cutover_at,
  cs.staging_retention_days,
  case when cs.validated_cutover_at is null then null
       else cs.validated_cutover_at + make_interval(days => cs.staging_retention_days)
  end as due_at,
  exists (
    select 1 from migration.retention_holds h
     where h.relation = r.relation
       and h.released_at is null
       and h.expires_at > now()
  ) as hold_active,
  case
    when cs.validated_cutover_at is null then false
    when exists (
      select 1 from migration.retention_holds h
       where h.relation = r.relation
         and h.released_at is null
         and h.expires_at > now()
    ) then false
    else now() >= cs.validated_cutover_at + make_interval(days => cs.staging_retention_days)
  end as purge_due
from ops.data_retention_registry r
join ops.retention_classes rc on rc.retention_class = r.retention_class
join pg_catalog.pg_class c on c.oid = r.relation
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
cross join migration.cutover_state cs
where rc.scope = 'migration_staging' and cs.singleton;

create table migration.legacy_user_game_state_audit (
  account_id integer not null references app.accounts(id) on delete cascade,
  source_user_id uuid not null,
  steam_appid bigint not null check (steam_appid > 0),
  raw_completed_at timestamptz,
  raw_slept_at timestamptz,
  raw_prev_active_status smallint,
  raw_dismissed_at timestamptz,
  raw_dismissed_playtime numeric,
  raw_review_requested_at timestamptz,
  raw_last_played_at timestamptz,
  raw_last_observed_at timestamptz,
  raw_recency_code smallint,
  raw_recency_evidence_at timestamptz,
  raw_family_owner_steam_id text,
  raw_family_verified_at timestamptz,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  captured_at timestamptz not null default now(),
  -- The complete stale child is bounded reconciliation staging.  A loader must
  -- explicitly mark a row before its sole evidence is promoted to the sparse
  -- durable app.game_state_legacy_measurements relation.
  retention_class text not null default 'staging-30d-post-cutover'
    references ops.retention_classes(retention_class)
    check (retention_class = 'staging-30d-post-cutover'),
  evidence_disposition text not null default 'reconcile_only'
    check (evidence_disposition in (
      'reconcile_only', 'durable_sparse_required', 'durable_sparse_written'
    )),
  primary key (account_id, steam_appid)
);

create table migration.legacy_library_evidence (
  legacy_id uuid primary key,
  account_id integer not null references app.accounts(id) on delete cascade,
  steam_appid bigint not null check (steam_appid > 0),
  legacy_hours_played numeric(30, 12)
    check (legacy_hours_played is null or legacy_hours_played >= 0),
  legacy_hours_played_raw text
    check (legacy_hours_played_raw is null or length(legacy_hours_played_raw) <= 128),
  completion_percentage numeric(30, 12),
  completion_percentage_raw text check (completion_percentage_raw is null or length(completion_percentage_raw) <= 128),
  -- The source column is nullable; NULL means no date was recorded and must
  -- stay NULL rather than being replaced with a cutover or epoch date.
  date_added_raw text check (date_added_raw is null or length(date_added_raw) <= 128),
  created_at timestamptz not null,
  source_updated_at timestamptz,
  -- Set by the loader from a recorded, reviewed conversion.  True means the
  -- legacy hours value is derivable from the exact observed minutes that the
  -- compact model already preserves, so this staging row is not the sole
  -- evidence of anything and may expire with the staging window.  False or
  -- NULL means it is unreproducible and needs the durable sparse row in
  -- app.library_legacy_measurements before the window can close.  An hours
  -- disagreement is never by itself proof that a user authored the number.
  reproducible_from_observed boolean,
  conversion_formula text
    check (conversion_formula is null or length(btrim(conversion_formula)) between 1 and 200),
  check (reproducible_from_observed is not true or conversion_formula is not null),
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  retention_class text not null default 'staging-30d-post-cutover'
    references ops.retention_classes(retention_class)
    check (retention_class = 'staging-30d-post-cutover'),
  evidence jsonb not null default '{}'::jsonb
    check (jsonb_typeof(evidence) = 'object' and pg_column_size(evidence) <= 32768)
);

create table migration.legacy_family_member_evidence (
  legacy_member_id uuid primary key,
  account_id integer not null references app.accounts(id) on delete cascade,
  steam_id bigint not null check (steam_id > 0),
  created_at timestamptz not null,
  raw_last_error text check (raw_last_error is null or length(raw_last_error) <= 20000),
  raw_library_seen integer check (raw_library_seen is null or raw_library_seen >= 0),
  raw_games_imported integer check (raw_games_imported is null or raw_games_imported >= 0),
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  retention_class text not null default 'staging-30d-post-cutover'
    references ops.retention_classes(retention_class)
    check (retention_class = 'staging-30d-post-cutover'),
  retention_review_at timestamptz,
  evidence jsonb not null default '{}'::jsonb
    check (jsonb_typeof(evidence) = 'object' and pg_column_size(evidence) <= 32768)
);

create table migration.legacy_family_access_orphans (
  id bigint generated always as identity primary key,
  account_id integer not null references app.accounts(id) on delete cascade,
  source_user_id uuid not null,
  source_member_id uuid,
  source_steam_id bigint check (source_steam_id is null or source_steam_id > 0),
  steam_appid bigint not null check (steam_appid > 0),
  observed_at timestamptz,
  raw_games_imported integer check (raw_games_imported is null or raw_games_imported >= 0),
  disposition text not null default 'quarantine'
    check (disposition in ('quarantine', 'manual_review', 'resolved')),
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  created_at timestamptz not null default now(),
  evidence jsonb not null default '{}'::jsonb
    check (jsonb_typeof(evidence) = 'object' and pg_column_size(evidence) <= 32768)
);
create index legacy_family_access_orphans_account_idx
  on migration.legacy_family_access_orphans (account_id, steam_appid);

create table migration.legacy_account_preferences_evidence (
  id bigint generated always as identity primary key,
  account_id integer not null references app.accounts(id) on delete cascade,
  source_account_id uuid not null,
  preference_key text not null check (length(btrim(preference_key)) between 1 and 200),
  value jsonb not null check (pg_column_size(value) <= 32768),
  source_created_at timestamptz,
  source_updated_at timestamptz,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  retention_class text not null default 'staging-30d-post-cutover'
    references ops.retention_classes(retention_class)
    check (retention_class = 'staging-30d-post-cutover'),
  unique (source_account_id, preference_key)
);

-- Session and intent archives contain identifiers and lifecycle timestamps
-- only.  Token digests, nonces, and other credential-adjacent values are
-- deliberately absent from these definitions.
create table migration.legacy_manual_session_audit (
  legacy_session_id uuid primary key,
  account_id integer not null references app.accounts(id) on delete cascade,
  created_at timestamptz not null,
  last_seen_at timestamptz not null,
  expires_at timestamptz not null,
  expired_at_freeze boolean not null,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  retention_class text not null default 'staging-30d-post-cutover'
    references ops.retention_classes(retention_class)
    check (retention_class = 'staging-30d-post-cutover'),
  check (expires_at >= created_at),
  check (last_seen_at >= created_at)
);

-- An intent audit row names both the initiating and the target account, and
-- both source UUIDs sit in the row.  Both mapped keys therefore cascade: a
-- deletion on either side removes the row rather than nulling one integer and
-- leaving two legacy UUIDs and a verified Steam ID behind.
create table migration.legacy_auth_intent_audit (
  legacy_intent_id uuid primary key,
  account_id integer not null references app.accounts(id) on delete cascade,
  source_account_id uuid not null,
  legacy_session_id uuid,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  target_account_id uuid,
  target_mapped_account_id integer references app.accounts(id) on delete cascade,
  check ((target_account_id is null) = (target_mapped_account_id is null)),
  verified_steam_id text check (verified_steam_id is null or verified_steam_id ~ '^[0-9]{17}$'),
  outcome text,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  retention_class text not null default 'staging-30d-post-cutover'
    references ops.retention_classes(retention_class)
    check (retention_class = 'staging-30d-post-cutover'),
  check (expires_at >= created_at),
  check (consumed_at is null or consumed_at >= created_at)
);

-- ops.account_merges is the durable domain destination for a merge.  This is
-- the bounded staging copy of the source row; both mapped accounts cascade so
-- the source UUID pair and verified Steam ID cannot outlive either account.
create table migration.legacy_account_merge_audit (
  legacy_merge_id uuid primary key,
  mapped_source_account_id integer not null references app.accounts(id) on delete cascade,
  mapped_target_account_id integer not null references app.accounts(id) on delete cascade,
  source_account_id uuid not null,
  target_account_id uuid not null,
  verified_steam_id text not null check (verified_steam_id ~ '^[0-9]{17}$'),
  merge_mode text not null check (merge_mode in ('promoted', 'merged_existing')),
  created_at timestamptz not null,
  analytics_delivered_at timestamptz,
  source_tombstone_present boolean not null default false,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  retention_class text not null default 'staging-30d-post-cutover'
    references ops.retention_classes(retention_class)
    check (retention_class = 'staging-30d-post-cutover')
);

create table migration.legacy_purge_review_archive (
  legacy_id uuid primary key,
  account_id integer not null references app.accounts(id) on delete cascade,
  source_game_id uuid not null,
  action text not null check (action in ('keep', 'pin', 'sleep', 'complete')),
  reviewed_at timestamptz not null,
  playtime_minutes_at_review integer not null check (playtime_minutes_at_review >= 0),
  progress_at_review integer check (progress_at_review is null or progress_at_review between 0 and 100),
  last_played_at_review timestamptz,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  retention_class text not null default 'staging-30d-post-cutover'
    references ops.retention_classes(retention_class)
    check (retention_class = 'staging-30d-post-cutover')
);

create table migration.legacy_collection_membership_evidence (
  id bigint generated always as identity primary key,
  account_id integer not null references app.accounts(id) on delete cascade,
  source_collection_id uuid not null,
  source_game_id uuid not null,
  collection_id bigint references app.collections(id) on delete set null,
  source_position integer not null check (source_position >= 0),
  source_created_at timestamptz not null,
  source_notes text,
  position_resolution text not null check (position_resolution in ('source', 'stable_reorder', 'conflict')),
  conflict_group text,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  retention_class text not null default 'staging-30d-post-cutover'
    references ops.retention_classes(retention_class)
    check (retention_class = 'staging-30d-post-cutover'),
  unique (source_collection_id, source_game_id)
);

-- The durable homes for legacy catalogue sightings, seed runs and duration
-- imports are catalog.game_sightings, catalog.seed_runs and
-- catalog.duration_imports above.  They carry no personal data and no
-- post-cutover expiry, so they are not staged twice here; the earlier
-- "until v2 derives equivalent history" and "permanent while seeded rows
-- remain" migration archives are removed rather than relabelled.

create table migration.legacy_ingest_queue_archive (
  id bigint generated always as identity primary key,
  steam_appid bigint not null check (steam_appid > 0),
  status text not null check (length(btrim(status)) between 1 and 80),
  reason text not null check (length(reason) <= 5000),
  requested_count integer not null check (requested_count >= 0),
  source_rank integer check (source_rank is null or source_rank >= 0),
  attempts integer not null check (attempts >= 0),
  last_error text check (last_error is null or length(last_error) <= 20000),
  rejection_reason text check (rejection_reason is null or length(rejection_reason) <= 5000),
  first_requested_at timestamptz not null,
  last_requested_at timestamptz not null,
  processed_at timestamptz,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  retention_class text not null default 'staging-30d-post-cutover'
    references ops.retention_classes(retention_class)
    check (retention_class = 'staging-30d-post-cutover'),
  check (last_requested_at >= first_requested_at),
  check (processed_at is null or processed_at >= first_requested_at)
);
create index legacy_ingest_queue_archive_app_idx
  on migration.legacy_ingest_queue_archive (steam_appid, status);

create table migration.legacy_duration_job_archive (
  id bigint generated always as identity primary key,
  steam_app_id bigint not null check (steam_app_id > 0),
  status text not null check (length(btrim(status)) between 1 and 80),
  attempts integer not null check (attempts >= 0),
  last_error_code text check (last_error_code is null or length(btrim(last_error_code)) between 1 and 160),
  last_error_message text check (last_error_message is null or length(last_error_message) <= 20000),
  created_at timestamptz not null,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  retention_class text not null default 'staging-30d-post-cutover'
    references ops.retention_classes(retention_class)
    check (retention_class = 'staging-30d-post-cutover')
);
create index legacy_duration_job_archive_app_idx
  on migration.legacy_duration_job_archive (steam_app_id, status);

-- Routine worker history is bounded operational data (plan 13: job summaries
-- 14 days, failure detail 30 days), not migration staging, so it lives in ops
-- with its own row-level `retention_until` and is classified accordingly.
-- The loader must classify routine versus failure rows and record the measured
-- counts of each in migration.relation_counts before any row is discarded.
create table ops.legacy_worker_runs (
  legacy_id uuid primary key,
  worker_name text not null check (length(btrim(worker_name)) between 1 and 200),
  status text not null check (length(btrim(status)) between 1 and 80),
  run_class text not null check (run_class in ('routine', 'failure', 'unknown')),
  started_at timestamptz not null,
  finished_at timestamptz,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  counts jsonb not null check (jsonb_typeof(counts) = 'object' and pg_column_size(counts) <= 65536),
  summary jsonb not null check (jsonb_typeof(summary) = 'object' and pg_column_size(summary) <= 65536),
  error_message text check (error_message is null or length(error_message) <= 20000),
  retention_until timestamptz not null,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  retention_class text not null default 'bounded-operational'
    references ops.retention_classes(retention_class)
    check (retention_class = 'bounded-operational'),
  check (finished_at is null or finished_at >= started_at),
  check (retention_until >= started_at),
  -- 14 days for routine rows, 30 days for failure detail, measured from the
  -- source run start.  An unclassified row gets the shorter routine window.
  check (retention_until <= started_at + interval '30 days'),
  check (run_class = 'failure' or retention_until <= started_at + interval '14 days')
);
create index legacy_worker_runs_retention_idx
  on ops.legacy_worker_runs (retention_until, started_at);

create table migration.legacy_import_freeze_report (
  account_id integer not null references app.accounts(id) on delete cascade,
  source_user_id uuid not null,
  status text not null check (length(btrim(status)) between 1 and 80),
  total_games integer not null check (total_games >= 0),
  imported_games integer not null check (imported_games >= 0 and imported_games <= total_games),
  play_history_missing boolean not null,
  last_error text check (last_error is null or length(last_error) <= 20000),
  started_at timestamptz not null,
  updated_at timestamptz not null,
  completed_at timestamptz,
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  retention_class text not null default 'staging-30d-post-cutover'
    references ops.retention_classes(retention_class)
    check (retention_class = 'staging-30d-post-cutover'),
  primary key (account_id, source_user_id),
  check (updated_at >= started_at),
  check (completed_at is null or completed_at >= started_at)
);

create table migration.legacy_schema_migration_ledger (
  source_migration text primary key check (length(btrim(source_migration)) between 1 and 200),
  source_version text not null check (length(btrim(source_version)) between 1 and 120),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  target_migration text not null check (length(btrim(target_migration)) between 1 and 200),
  target_sha256 text check (target_sha256 is null or target_sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz not null,
  status text not null check (status in ('replayed', 'verified', 'blocked')),
  notes text check (notes is null or length(notes) <= 10000),
  source_snapshot_hash bytea
    check (source_snapshot_hash is null or octet_length(source_snapshot_hash) = 32),
  retention_class text not null default 'migration-bookkeeping-permanent'
    references ops.retention_classes(retention_class)
    check (retention_class = 'migration-bookkeeping-permanent')
);

-- The current-draw pointer is now checked against the preserved draw history.
-- The compound FK prevents an account from pointing at another account's draw;
-- the source public UUID remains available for cross-system references.
alter table app.vault_state
  add constraint vault_state_current_draw_ref_fk
  foreign key (account_id, current_draw_ref)
  references app.vault_draws(account_id, public_id) on delete set null (current_draw_ref);

-- ---------------------------------------------------------------------------
-- Deletion, export and retention registry
-- ---------------------------------------------------------------------------
--
-- Every relation in the private model is registered with the account key it
-- actually holds, how account deletion reaches it, and whether it belongs in
-- an account export.  The registry is seeded here rather than maintained by
-- hand later: `relation` is a regclass, so a row cannot name a relation that
-- does not exist, and the M3 fixtures assert the converse -- that no relation
-- in these schemas is missing from the registry.
--
-- The rule that closes the ON DELETE SET NULL hole is a table check, not a
-- comment: a relation that claims `de_identify` must have no account UUID
-- column, because clearing an integer foreign key does not remove a retained
-- original account UUID.
insert into ops.data_retention_registry
  (relation, introduced_in, retention_class, holds_personal_data,
   account_fk_column, account_uuid_columns, deletion_mode, export_scope, rationale)
values
  -- M1 account domain.
  ('app.accounts', 'm1', 'durable-account-lifetime', true, 'id', '{public_id}', 'account_row', 'account_export',
   'The account row itself. Deleting it drives every cascade below. last_login_at and last_seen_at are two separate legacy instants on this row.'),
  ('app.steam_profiles', 'm1', 'durable-account-lifetime', true, 'account_id', '{}', 'cascade', 'account_export',
   'Provider profile identity for the account.'),
  ('app.sessions', 'm1', 'durable-account-lifetime', true, 'account_id', '{}', 'cascade', 'account_export',
   'Session lifecycle. The exported representation carries kinds and timestamps, never the token digest.'),
  ('app.account_capabilities', 'm1', 'durable-account-lifetime', true, 'account_id', '{}', 'cascade', 'account_export',
   'Compact projected capability row.'),
  ('app.account_preferences', 'm1', 'durable-account-lifetime', true, 'account_id', '{}', 'cascade', 'account_export',
   'Authored preferences, including per-key legacy provenance carried inside the preferences document.'),
  ('app.library_games', 'm1', 'durable-account-lifetime', true, 'account_id', '{}', 'cascade', 'account_export',
   'Compact owned library with exact observed minutes.'),
  ('app.game_state', 'm1', 'durable-account-lifetime', true, 'account_id', '{}', 'cascade', 'account_export',
   'Authored per-game state and notes.'),
  ('app.game_activity', 'm1', 'durable-account-lifetime', true, 'account_id', '{}', 'cascade', 'account_export',
   'Sparse recency evidence.'),
  ('app.retired_library_games', 'm1', 'durable-account-lifetime', true, 'account_id', '{}', 'cascade', 'account_export',
   'Retained measurements for lost access.'),
  ('app.library_sync_state', 'm1', 'durable-account-lifetime', true, 'account_id', '{}', 'cascade', 'account_export',
   'Per-account import fence and generation.'),
  ('app.playtime_daily', 'm1', 'durable-account-lifetime', true, 'account_id', '{}', 'cascade', 'account_export',
   'Cumulative daily observed totals and games-with-playtime coverage.'),
  ('app.family_members', 'm1', 'durable-account-lifetime', true, 'account_id', '{legacy_member_id,public_id}', 'cascade', 'account_export',
   'Lender roster with legacy member identity and display metadata.'),
  ('app.family_game_access', 'm1', 'durable-account-lifetime', true, 'account_id', '{}', 'cascade', 'account_export',
   'Family access edges.'),
  ('app.collections', 'm1', 'durable-account-lifetime', true, 'account_id', '{public_id}', 'cascade', 'account_export',
   'Authored collections retaining their legacy public UUID.'),
  ('app.collection_games', 'm1', 'durable-account-lifetime', true, 'account_id', '{}', 'cascade', 'account_export',
   'Authored membership, ordering and notes up to the M1 note bound.'),
  ('app.pins', 'm1', 'durable-account-lifetime', true, 'account_id', '{}', 'cascade', 'account_export',
   'Authored pins and their baselines.'),
  ('app.snoozes', 'm1', 'durable-account-lifetime', true, 'account_id', '{}', 'cascade', 'account_export',
   'Authored suppression.'),
  ('app.vault_state', 'm1', 'durable-account-lifetime', true, 'account_id', '{current_draw_ref}', 'cascade', 'account_export',
   'Current pick. current_draw_ref is a draw UUID scoped to this account and goes with the cascade.'),
  ('app.completion_events', 'm1', 'durable-account-lifetime', true, 'account_id', '{legacy_event_id,legacy_game_id}', 'cascade', 'account_export',
   'Resolved completion history with legacy event and game UUIDs.'),
  ('catalog.games', 'm1', 'durable-catalogue-evidence', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Shared catalogue identity and first/last seen provenance.'),
  ('catalog.game_metadata', 'm1', 'durable-catalogue-evidence', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Shared catalogue metadata.'),
  ('catalog.game_features', 'm1', 'durable-catalogue-evidence', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Shared catalogue features, durations, reviews, popularity and tag evidence.'),
  ('ops.account_aliases', 'm1', 'durable-account-lifetime', true, 'source_account_id', '{source_public_id}', 'cascade', 'operator_only',
   'Merge alias. Cascades from either account, taking the source public UUID with it.'),
  ('ops.account_merges', 'm1', 'durable-account-lifetime', true, 'source_account_id', '{source_public_id,target_public_id}', 'cascade', 'operator_only',
   'Durable merge audit. Cascades from either account; the source and target public UUIDs cannot outlive them.'),
  ('ops.auth_intents', 'm1', 'bounded-operational', true, 'account_id', '{}', 'cascade_via_parent', 'operator_only',
   'Short-lived promotion intent bound to a session by compound key; the session cascade removes it with the account.'),
  ('ops.project_marker', 'm1', 'operational-config', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Stable project marker. Remains schema_version = m1.'),
  -- M2 jobs, quota and observation fences.
  ('app.library_observation_anomalies', 'm2', 'bounded-operational', true, 'account_id', '{}', 'cascade', 'operator_only',
   'Per-account import anomaly evidence.'),
  ('app.library_observation_fences', 'm2', 'bounded-operational', true, 'account_id', '{}', 'cascade', 'operator_only',
   'Per-account observation fence.'),
  ('ops.jobs', 'm2', 'bounded-operational', true, 'account_id', '{}', 'cascade', 'operator_only',
   'Job records keyed by account; lease and attempt tokens are operational, not exported.'),
  ('ops.job_requests', 'm2', 'bounded-operational', true, 'account_id', '{}', 'cascade', 'operator_only',
   'Idempotent job request keys.'),
  ('ops.provider_call_charges', 'm2', 'bounded-operational', true, 'account_id', '{}', 'cascade', 'operator_only',
   'Per-attempt provider charges.'),
  ('ops.enrichment_outbox', 'm2', 'bounded-operational', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Catalogue enrichment work items keyed by game.'),
  ('ops.provider_controls', 'm2', 'operational-config', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Provider enablement and mode.'),
  ('ops.provider_quota_daily', 'm2', 'operational-config', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Daily provider quota counters.'),
  ('ops.provider_token_buckets', 'm2', 'operational-config', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Provider token buckets.'),
  -- M3 shared catalogue evidence.
  ('catalog.duration_estimates', 'm3', 'durable-catalogue-evidence', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Provider duration observations per AppID and provider.'),
  ('catalog.duration_aliases', 'm3', 'durable-catalogue-evidence', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Reviewed search aliases.'),
  ('catalog.review_decisions', 'm3', 'shared-evidence-de-identifiable', true, 'reviewer_account_id', '{}', 'de_identify', 'operator_only',
   'Shared catalogue decision that must survive the reviewer account. It carries no reviewer UUID, so ON DELETE SET NULL genuinely de-identifies it; the source reviewer UUID lives only in bounded staging.'),
  ('catalog.offers', 'm3', 'durable-catalogue-evidence', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Observed US offers.'),
  ('catalog.offer_prices', 'm3', 'durable-catalogue-evidence', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Observed US price points with a per-row retention_until; no perpetual price history.'),
  ('catalog.provider_state', 'm3', 'durable-catalogue-evidence', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Provider retry state for catalogued games.'),
  ('catalog.game_sightings', 'm3', 'durable-catalogue-evidence', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Durable destination for legacy catalogue sighting counts. Aggregate counts only, no account key.'),
  ('catalog.seed_runs', 'm3', 'durable-catalogue-evidence', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Durable seed provenance for catalogue rows that remain.'),
  ('catalog.duration_imports', 'm3', 'durable-catalogue-evidence', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Durable provenance for imported duration facts that remain.'),
  ('catalog.appid_terminal_rejections', 'm3', 'durable-catalogue-evidence', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Durable terminal rejection and backoff state so a failed identity is not retried forever.'),
  -- M3 account domain.
  ('app.vault_draws', 'm3', 'ui-history-90d', true, 'account_id', '{public_id,source_collection_id}', 'cascade', 'account_export',
   'UI draw history. The M6 cleanup candidate view retains at most the latest 100 draws per account and removes rows older than 90 days using the account/time index; source UUIDs still cascade on account deletion and remain exportable while retained.'),
  ('app.vault_draw_events', 'm3', 'ui-history-90d', true, 'account_id', '{public_id}', 'cascade', 'account_export',
   'UI draw impressions/actions. Events cascade with their draw and the M6 cleanup candidate view removes aged rows or children of draws beyond the latest 100; source UUIDs still cascade and remain exportable while retained.'),
  ('app.vault_events', 'm3', 'ui-history-90d', true, 'account_id', '{public_id,legacy_game_id}', 'cascade', 'account_export',
   'UI product action history. The M6 cleanup candidate view removes rows older than 90 days using the account/time index; completion history remains durable separately.'),
  ('app.unknown_completion_history', 'm3', 'durable-account-lifetime', true, 'account_id', '{legacy_event_id,source_game_id}', 'cascade', 'account_export',
   'Completion events that resolve to no catalogue or library identity.'),
  ('app.completion_event_registry', 'm3', 'durable-account-lifetime', true, 'account_id', '{legacy_event_id}', 'cascade', 'account_export',
   'One row per legacy completion event UUID across both destinations.'),
  ('app.library_legacy_measurements', 'm3', 'durable-account-lifetime', true, 'account_id', '{}', 'cascade', 'account_export',
   'Sparse durable evidence for legacy numeric and raw text that the exact observed minutes cannot reproduce. Authorship defaults to unknown.'),
  ('app.game_state_legacy_measurements', 'm3', 'durable-account-lifetime', true, 'account_id', '{source_user_id}', 'cascade', 'account_export',
   'Sparse durable evidence promoted only for stale state facts that are sole evidence or unresolved; never a runtime state/activity source.'),
  ('app.purge_review_history', 'm3', 'durable-account-lifetime', true, 'account_id', '{}', 'cascade', 'account_export',
   'Authored purge review decisions. Durable account history, not staging.'),
  ('app.family_access_orphans', 'm3', 'durable-account-lifetime', true, 'account_id', '{}', 'cascade', 'account_export',
   'Sole surviving evidence of family access with no lender row. Confers no access and manufactures no member.'),
  ('app.account_capability_evidence', 'm3', 'durable-account-lifetime', true, 'account_id', '{}', 'cascade', 'account_export',
   'Raw legacy capability tuples with provenance. Retained durably because the v2 projection deliberately reduces false and NULL to unknown.'),
  -- M3 recommendation warm start.
  ('reco.warm_start_snapshots', 'm3', 'durable-catalogue-evidence', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Frozen snapshot header. Versioned; replacing one creates a new version.'),
  ('reco.user_genre_preferences', 'm3', 'durable-account-lifetime', true, 'account_id', '{source_user_id}', 'cascade', 'account_export',
   'Per-account warm-start aggregate. A pseudonymous aggregate with an account key is still personal data, so it cascades and takes the source user UUID with it.'),
  ('reco.genre_preference_globals', 'm3', 'durable-catalogue-evidence', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Global genre aggregate with no account key.'),
  ('reco.game_preference_globals', 'm3', 'durable-catalogue-evidence', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Global game aggregate with no account key.'),
  ('reco.operator_weight_versions', 'm3', 'operational-config', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Hand-tuned operator weights, versioned separately from learned values.'),
  -- M3 operations and support.
  ('ops.abuse_cooldowns', 'm3', 'bounded-operational', true, 'account_id', '{}', 'cascade', 'operator_only',
   'Cooldown obligations. Only a key digest is stored; where the source bucket is account keyed, the mapped account cascades.'),
  ('ops.legacy_worker_runs', 'm3', 'bounded-operational', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Legacy worker history bounded by retention_until: 14 days routine, 30 days failure, measured from the source run start.'),
  ('ops.retention_classes', 'm3', 'migration-bookkeeping-permanent', false, null, '{}', 'no_account_link', 'no_personal_data',
   'The retention vocabulary itself.'),
  ('ops.data_retention_registry', 'm3', 'migration-bookkeeping-permanent', false, null, '{}', 'no_account_link', 'no_personal_data',
   'This registry.'),
  ('support.retention_policy_decisions', 'm3', 'migration-bookkeeping-permanent', false, null, '{}', 'no_account_link', 'no_personal_data',
   'The pending support content-retention decision. Deliberately unresolved until M6 or M7.'),
  ('support.contact_messages', 'm3', 'support-pending-decision', true, 'account_id', '{source_account_public_id}', 'cascade', 'account_export',
   'Support contact content. The purge deadline is unresolved; account deletion and export are not.'),
  ('support.feedback_submissions', 'm3', 'support-pending-decision', true, 'account_id', '{source_account_public_id}', 'cascade', 'account_export',
   'Feedback content. The purge deadline is unresolved; account deletion and export are not.'),
  -- M3 migration bookkeeping.
  ('migration.runs', 'm3', 'migration-bookkeeping-permanent', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Run metadata and snapshot identity.'),
  ('migration.applied_steps', 'm3', 'migration-bookkeeping-permanent', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Phase ledger and restart watermarks.'),
  ('migration.relation_counts', 'm3', 'migration-bookkeeping-permanent', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Per-relation source, loaded, archived and conflict counts.'),
  ('migration.conflict_report', 'm3', 'migration-bookkeeping-permanent', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Conflict classes, counts and decisions. Raw values never appear here.'),
  ('migration.cutover_state', 'm3', 'migration-bookkeeping-permanent', false, null, '{}', 'no_account_link', 'no_personal_data',
   'The single validated-cutover instant that starts the staging window.'),
  ('migration.retention_holds', 'm3', 'migration-bookkeeping-permanent', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Recorded recovery-incident holds, each bounded by its own expiry.'),
  ('migration.legacy_schema_migration_ledger', 'm3', 'migration-bookkeeping-permanent', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Legacy migration ledger replay record. Contains no source rows and no personal data.'),
  -- M3 migration staging. Every one of these expires with the 30-day window.
  ('migration.account_map', 'm3', 'staging-30d-post-cutover', true, 'account_id', '{legacy_id}', 'cascade', 'operator_only',
   'Legacy account UUID to target account. Cascades so a deletion cannot leave the legacy identifier behind.'),
  ('migration.game_map', 'm3', 'staging-30d-post-cutover', false, null, '{}', 'no_account_link', 'no_personal_data',
   'AppID to catalogue game.'),
  ('migration.library_row_map', 'm3', 'staging-30d-post-cutover', true, 'account_id', '{legacy_id}', 'cascade', 'operator_only',
   'Legacy per-user library row UUID to account and game.'),
  ('migration.collection_map', 'm3', 'staging-30d-post-cutover', true, 'account_id', '{legacy_id}', 'cascade', 'operator_only',
   'Legacy collection UUID to target collection.'),
  ('migration.session_map', 'm3', 'staging-30d-post-cutover', true, 'account_id', '{legacy_id}', 'cascade', 'operator_only',
   'Legacy session UUID to target session.'),
  ('migration.legacy_user_game_state_audit', 'm3', 'staging-30d-post-cutover', true, 'account_id', '{source_user_id}', 'cascade', 'operator_only',
   'Complete stale user_game_state reconciliation staging. Rows needing lasting sole evidence are explicitly promoted to app.game_state_legacy_measurements before this 30-day window closes; the staging child never becomes transform authority.'),
  ('migration.legacy_library_evidence', 'm3', 'staging-30d-post-cutover', true, 'account_id', '{legacy_id}', 'cascade', 'operator_only',
   'Raw library rows. Anything the exact observed minutes cannot reproduce must reach app.library_legacy_measurements before this expires.'),
  ('migration.legacy_family_member_evidence', 'm3', 'staging-30d-post-cutover', true, 'account_id', '{legacy_member_id}', 'cascade', 'operator_only',
   'Raw lender rows. The durable lender facts live on app.family_members.'),
  ('migration.legacy_family_access_orphans', 'm3', 'staging-30d-post-cutover', true, 'account_id', '{source_user_id,source_member_id}', 'cascade', 'operator_only',
   'Raw orphan access rows. The durable evidence lives in app.family_access_orphans.'),
  ('migration.legacy_account_preferences_evidence', 'm3', 'staging-30d-post-cutover', true, 'account_id', '{source_account_id}', 'cascade', 'operator_only',
   'Raw per-key preferences. The durable values and their per-key provenance live in app.account_preferences.'),
  ('migration.legacy_manual_session_audit', 'm3', 'staging-30d-post-cutover', true, 'account_id', '{legacy_session_id}', 'cascade', 'operator_only',
   'Manual session lifecycle without any token digest.'),
  ('migration.legacy_auth_intent_audit', 'm3', 'staging-30d-post-cutover', true, 'account_id', '{source_account_id,target_account_id,legacy_intent_id,legacy_session_id}', 'cascade', 'operator_only',
   'Promotion intents without token, nonce or digest. Both mapped accounts cascade.'),
  ('migration.legacy_account_merge_audit', 'm3', 'staging-30d-post-cutover', true, 'mapped_source_account_id', '{source_account_id,target_account_id}', 'cascade', 'operator_only',
   'Raw merge rows. The durable merge audit is ops.account_merges.'),
  ('migration.legacy_purge_review_archive', 'm3', 'staging-30d-post-cutover', true, 'account_id', '{legacy_id,source_game_id}', 'cascade', 'operator_only',
   'Raw purge review rows. The durable authored decisions live in app.purge_review_history.'),
  ('migration.legacy_collection_membership_evidence', 'm3', 'staging-30d-post-cutover', true, 'account_id', '{source_collection_id,source_game_id}', 'cascade', 'operator_only',
   'Raw membership rows and ordering conflicts. Durable notes and ordering live on app.collection_games.'),
  ('migration.legacy_ingest_queue_archive', 'm3', 'staging-30d-post-cutover', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Raw ingest queue rows. Terminal verdicts are extracted to catalog.appid_terminal_rejections with measured counts before expiry.'),
  ('migration.legacy_duration_job_archive', 'm3', 'staging-30d-post-cutover', false, null, '{}', 'no_account_link', 'no_personal_data',
   'Raw duration job rows. Terminal verdicts are extracted to catalog.appid_terminal_rejections with measured counts before expiry.'),
  ('migration.legacy_import_freeze_report', 'm3', 'staging-30d-post-cutover', true, 'account_id', '{source_user_id}', 'cascade', 'operator_only',
   'Per-account import state at freeze. The source games payload and processing token are never copied.')
on conflict (relation) do nothing;

-- Preservation gate.  Staging may only expire once the lasting facts it holds
-- have reached their durable destinations.  Each row here is a staging row
-- whose durable counterpart is missing; a validated cutover must not be
-- recorded, and no staging purge may run, while this view returns anything.
create view migration.unpreserved_evidence as
select 'library_legacy_measurement'::text as gate,
       e.account_id,
       e.steam_appid as steam_app_id,
       e.legacy_id::text as source_key
  from migration.legacy_library_evidence e
 where (e.legacy_hours_played is not null
        or e.legacy_hours_played_raw is not null
        or e.completion_percentage is not null
        or e.completion_percentage_raw is not null)
   and e.reproducible_from_observed is not true
   and not exists (
     select 1 from app.library_legacy_measurements m
      where m.account_id = e.account_id and m.steam_app_id = e.steam_appid
   )
union all
select 'purge_review_history', a.account_id, null::bigint, a.legacy_id::text
  from migration.legacy_purge_review_archive a
 where not exists (
   select 1 from app.purge_review_history h
    where h.account_id = a.account_id and h.reviewed_at = a.reviewed_at
 )
union all
select 'family_access_orphan', o.account_id, o.steam_appid, o.id::text
  from migration.legacy_family_access_orphans o
 where not exists (
   select 1 from app.family_access_orphans f
    where f.account_id = o.account_id and f.steam_app_id = o.steam_appid
 )
union all
select 'capability_evidence', m.account_id, null::bigint, m.legacy_id::text
  from migration.account_map m
 where exists (
   select 1 from migration.legacy_library_evidence e where e.account_id = m.account_id
 )
   and not exists (
       select 1 from app.account_capability_evidence ce where ce.account_id = m.account_id
   )
union all
select 'game_state_legacy_measurement', s.account_id, s.steam_appid,
       s.source_user_id::text
  from migration.legacy_user_game_state_audit s
 where s.evidence_disposition in ('durable_sparse_required', 'durable_sparse_written')
   and not exists (
     select 1 from app.game_state_legacy_measurements d
      where d.account_id = s.account_id
        and d.steam_app_id = s.steam_appid
        and d.source_user_id = s.source_user_id
   );

-- This relation is intentionally keyed by (account_id, steam_appid), not a
-- target game key.  It is a reconciliation archive only: no loader may join
-- it into app.game_state or app.game_activity.
-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
--
-- Every M3 relation enables and forces row level security, matching M1/M2.
-- Tenant-facing draw history and warm-start reads get narrow policies; the
-- owner-only migration, support, operations, registry and review relations
-- deliberately have no policy at all, so a role that can connect but is not
-- the RLS-exempt migration owner sees nothing even if a grant were added by
-- mistake.
alter table app.vault_draws enable row level security;
alter table app.vault_draws force row level security;
create policy m3_vault_draws_tenant on app.vault_draws
  for all to vault_app
  using (account_id = app.current_account_id())
  with check (account_id = app.current_account_id());

alter table app.vault_draw_events enable row level security;
alter table app.vault_draw_events force row level security;
create policy m3_vault_draw_events_tenant on app.vault_draw_events
  for all to vault_app
  using (account_id = app.current_account_id())
  with check (account_id = app.current_account_id());

alter table app.vault_events enable row level security;
alter table app.vault_events force row level security;
create policy m3_vault_events_tenant on app.vault_events
  for all to vault_app
  using (account_id = app.current_account_id())
  with check (account_id = app.current_account_id());

alter table app.unknown_completion_history enable row level security;
alter table app.unknown_completion_history force row level security;
alter table app.completion_event_registry enable row level security;
alter table app.completion_event_registry force row level security;
alter table app.library_legacy_measurements enable row level security;
alter table app.library_legacy_measurements force row level security;
alter table app.game_state_legacy_measurements enable row level security;
alter table app.game_state_legacy_measurements force row level security;
alter table app.purge_review_history enable row level security;
alter table app.purge_review_history force row level security;
alter table app.family_access_orphans enable row level security;
alter table app.family_access_orphans force row level security;
alter table app.account_capability_evidence enable row level security;
alter table app.account_capability_evidence force row level security;

alter table reco.warm_start_snapshots enable row level security;
alter table reco.warm_start_snapshots force row level security;
create policy m3_warm_start_read on reco.warm_start_snapshots
  for select to vault_app, vault_worker using (true);

alter table reco.user_genre_preferences enable row level security;
alter table reco.user_genre_preferences force row level security;
create policy m3_user_genre_preferences_tenant on reco.user_genre_preferences
  for select to vault_app
  using (account_id = app.current_account_id());

alter table reco.genre_preference_globals enable row level security;
alter table reco.genre_preference_globals force row level security;
create policy m3_genre_preference_globals_read on reco.genre_preference_globals
  for select to vault_app, vault_worker using (true);

alter table reco.game_preference_globals enable row level security;
alter table reco.game_preference_globals force row level security;
create policy m3_game_preference_globals_read on reco.game_preference_globals
  for select to vault_app, vault_worker using (true);

alter table reco.operator_weight_versions enable row level security;
alter table reco.operator_weight_versions force row level security;

-- Catalogue observations can be read by the product and the enrichment
-- worker. Decisions, aliases, provider retry state and terminal rejections
-- stay operator-only.
alter table catalog.duration_estimates enable row level security;
alter table catalog.duration_estimates force row level security;
create policy m3_duration_estimates_read on catalog.duration_estimates
  for select to vault_app, vault_worker using (true);

alter table catalog.duration_aliases enable row level security;
alter table catalog.duration_aliases force row level security;

alter table catalog.review_decisions enable row level security;
alter table catalog.review_decisions force row level security;

alter table catalog.offers enable row level security;
alter table catalog.offers force row level security;
create policy m3_offers_read on catalog.offers
  for select to vault_app, vault_worker using (true);

alter table catalog.offer_prices enable row level security;
alter table catalog.offer_prices force row level security;
create policy m3_offer_prices_read on catalog.offer_prices
  for select to vault_app, vault_worker using (true);

alter table catalog.provider_state enable row level security;
alter table catalog.provider_state force row level security;

alter table catalog.game_sightings enable row level security;
alter table catalog.game_sightings force row level security;

alter table catalog.seed_runs enable row level security;
alter table catalog.seed_runs force row level security;

alter table catalog.duration_imports enable row level security;
alter table catalog.duration_imports force row level security;

alter table catalog.appid_terminal_rejections enable row level security;
alter table catalog.appid_terminal_rejections force row level security;

alter table ops.abuse_cooldowns enable row level security;
alter table ops.abuse_cooldowns force row level security;
alter table ops.legacy_worker_runs enable row level security;
alter table ops.legacy_worker_runs force row level security;
alter table ops.retention_classes enable row level security;
alter table ops.retention_classes force row level security;
alter table ops.data_retention_registry enable row level security;
alter table ops.data_retention_registry force row level security;

alter table support.retention_policy_decisions enable row level security;
alter table support.retention_policy_decisions force row level security;
alter table support.contact_messages enable row level security;
alter table support.contact_messages force row level security;
alter table support.feedback_submissions enable row level security;
alter table support.feedback_submissions force row level security;

alter table migration.account_map enable row level security;
alter table migration.account_map force row level security;
alter table migration.game_map enable row level security;
alter table migration.game_map force row level security;
alter table migration.library_row_map enable row level security;
alter table migration.library_row_map force row level security;
alter table migration.collection_map enable row level security;
alter table migration.collection_map force row level security;
alter table migration.session_map enable row level security;
alter table migration.session_map force row level security;
alter table migration.runs enable row level security;
alter table migration.runs force row level security;
alter table migration.applied_steps enable row level security;
alter table migration.applied_steps force row level security;
alter table migration.relation_counts enable row level security;
alter table migration.relation_counts force row level security;
alter table migration.conflict_report enable row level security;
alter table migration.conflict_report force row level security;
alter table migration.cutover_state enable row level security;
alter table migration.cutover_state force row level security;
alter table migration.retention_holds enable row level security;
alter table migration.retention_holds force row level security;
alter table migration.legacy_user_game_state_audit enable row level security;
alter table migration.legacy_user_game_state_audit force row level security;
alter table migration.legacy_library_evidence enable row level security;
alter table migration.legacy_library_evidence force row level security;
alter table migration.legacy_family_member_evidence enable row level security;
alter table migration.legacy_family_member_evidence force row level security;
alter table migration.legacy_family_access_orphans enable row level security;
alter table migration.legacy_family_access_orphans force row level security;
alter table migration.legacy_account_preferences_evidence enable row level security;
alter table migration.legacy_account_preferences_evidence force row level security;
alter table migration.legacy_manual_session_audit enable row level security;
alter table migration.legacy_manual_session_audit force row level security;
alter table migration.legacy_auth_intent_audit enable row level security;
alter table migration.legacy_auth_intent_audit force row level security;
alter table migration.legacy_account_merge_audit enable row level security;
alter table migration.legacy_account_merge_audit force row level security;
alter table migration.legacy_purge_review_archive enable row level security;
alter table migration.legacy_purge_review_archive force row level security;
alter table migration.legacy_collection_membership_evidence enable row level security;
alter table migration.legacy_collection_membership_evidence force row level security;
alter table migration.legacy_ingest_queue_archive enable row level security;
alter table migration.legacy_ingest_queue_archive force row level security;
alter table migration.legacy_duration_job_archive enable row level security;
alter table migration.legacy_duration_job_archive force row level security;
alter table migration.legacy_import_freeze_report enable row level security;
alter table migration.legacy_import_freeze_report force row level security;
alter table migration.legacy_schema_migration_ledger enable row level security;
alter table migration.legacy_schema_migration_ledger force row level security;

-- ---------------------------------------------------------------------------
-- Privilege boundary
-- ---------------------------------------------------------------------------
--
-- The new private schema is excluded from every implicit and public surface.
-- The existing M1/M2 revoke covers app, catalog, reco, ops and migration; this
-- extends the same boundary to support and keeps the migration schema
-- ungrantable.  Nothing here re-grants an existing M1/M2 privilege, so the old
-- runtime ACLs are provably unchanged apart from the two named additions
-- below.
revoke all on schema support from public, vault_app, vault_worker;
revoke all on all tables in schema support from public, vault_app, vault_worker;
revoke all on all sequences in schema support from public, vault_app, vault_worker;
revoke all on all functions in schema support from public, vault_app, vault_worker;
revoke all on schema migration from public, vault_app, vault_worker;
alter default privileges in schema support revoke all on tables from public;
alter default privileges in schema support revoke all on sequences from public;
alter default privileges in schema support revoke execute on functions from public;
do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = role_name) then
      execute format('revoke all on schema support from %I', role_name);
      execute format('revoke all on all tables in schema support from %I', role_name);
      execute format('revoke all on all sequences in schema support from %I', role_name);
      execute format('revoke all on all functions in schema support from %I', role_name);
      execute format('alter default privileges in schema support revoke all on tables from %I', role_name);
      execute format('alter default privileges in schema support revoke all on sequences from %I', role_name);
      execute format('alter default privileges in schema support revoke execute on functions from %I', role_name);
    end if;
  end loop;
end
$$;

-- Exactly two pre-existing objects gain a privilege in M3, both named and both
-- least-privilege:
--   * USAGE on schema reco, without CREATE, so the runtime can reach the new
--     warm-start read policies at all; M1 granted app and catalog only.
--   * UPDATE on the single new app.accounts.last_login_at column, so the v2
--     interactive-login path can record that instant.  It is a column grant,
--     not a table grant, and last_seen_at keeps its own separate M1 grant.
-- No other existing grant is restated, widened or replaced.
grant usage on schema reco to vault_app, vault_worker;
grant update (last_login_at) on app.accounts to vault_app;

-- New-object grants are limited to tenant draw history and catalogue reads.
grant select, insert, update, delete on app.vault_draws, app.vault_draw_events, app.vault_events
  to vault_app;
-- Only the three new identity sequences are needed by the new draw/event
-- writes.  Existing M1 sequence ACLs remain untouched.
grant usage, select on sequence
  app.vault_draws_id_seq,
  app.vault_draw_events_id_seq,
  app.vault_events_id_seq
  to vault_app;
grant select on catalog.duration_estimates, catalog.offers, catalog.offer_prices
  to vault_app, vault_worker;
grant select on reco.warm_start_snapshots, reco.user_genre_preferences,
  reco.genre_preference_globals, reco.game_preference_globals
  to vault_app;
grant select on reco.warm_start_snapshots, reco.genre_preference_globals,
  reco.game_preference_globals to vault_worker;

-- The retention candidate view is for the owner-only M6 cleanup runner.  It
-- deliberately exposes no runtime/private archive surface.
revoke all on app.ui_history_retention_candidates from public, vault_app, vault_worker;
do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = role_name) then
      execute format('revoke all on app.ui_history_retention_candidates from %I', role_name);
    end if;
  end loop;
end
$$;

-- The M1 project marker remains unchanged.  Migration history is recorded by
-- Supabase's migration ledger and by migration.legacy_schema_migration_ledger
-- once a source snapshot is actually replayed.
