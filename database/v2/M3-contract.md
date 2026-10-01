# VaultShuffle v2 M3-B physical schema contract

Status: physical schema contract and migration are implemented and **applied**;
clean isolated target-shaped replay and the local constraint, RLS, retention,
deletion and cleanup gates pass. Source-value loading remains blocked until the
manifest decisions named below are resolved. This contract is the companion to
`supabase/migrations/20260910232654_m3_preservation_schema.sql`, which was
created with the Supabase CLI after the immutable M1 and M2 migrations.

### Applied state (reference note, 11 September 2026)

The reviewed M3 migration was applied on the target at **2026-09-10T23:26:54Z**
and management assigned the version `20260910232654`. The local file was
**renamed, not edited**, from its pre-apply name
`20260909214501_m3_preservation_schema.sql`; its content SHA-256 is therefore
unchanged at
`605b72a3d9df1328ec27033c3420c1813a238f6e15bd8fc28f971cddaf30a24a`.

All three migrations are now applied and immutable. No M1, M2 or M3 file may be
edited or reapplied: a newly discovered physical gap is a finding that needs a
new, separately reviewed migration. Remote schema, security and rollback
verification remain with root and are not claimed here. Root's apply record
states that the target still holds no source rows: the marker
`ops.project_marker.schema_version` deliberately remains `m1`, with target
account and game counts at 0. That is root's recorded observation of the remote
target, not a local verification — this note carries no remote query.

M1, M2 and M3 are immutable inputs. Their expected SHA-256 values are:

| migration | SHA-256 |
|---|---|
| `20260906093036_m1_private_foundation.sql` | `54fe0a7defd029e91568b78d51393670ac7ca6edcf915919670c7f64c2476389` |
| `20260907163356_m2_jobs_quota_publish.sql` | `f09d7ca900f3cdaaee81eff0f507adc5869865f16eb7f340eeb1729223bc5aba` |
| `20260910232654_m3_preservation_schema.sql` | `605b72a3d9df1328ec27033c3420c1813a238f6e15bd8fc28f971cddaf30a24a` |

The M3 migration is additive. It creates storage and constraints; it does not
query the source project, import rows, create credentials, enable a provider,
or change deployment configuration.

The M1 `ops.project_marker.schema_version` remains `m1`. M3 advancement is
identified by the Supabase migration filename and the owner-only migration
ledger after a source replay; the stable foundation marker is not widened or
rewritten.

## What must survive

The schema preserves source facts in a form that can be replayed from one
frozen snapshot without inventing a value:

* UI draw, impression, and action history within plan 13's latest-100-draw /
  90-day retention bound, including source IDs, finalist arrays, and context;
  the current-draw pointer is preserved separately in `app.vault_state`;
* exact observed playtime, cumulative daily semantics, games-with-playtime,
  authored hours and completion metrics as separate evidence;
* catalogue metadata, weighted tags, review counts, durations, provider
  observations, US offers/prices, aliases, quarantine and manual decisions;
* account mapping, merge/tombstone evidence, family lender fields, and
  orphaned family-access evidence;
* completion records that resolve to a target game and unknown completion
  records that do not, with one registry key for every source event;
* frozen warm-start aggregates and versioned operator weights separately from
  live learned values;
* private capability, session-freeze, abuse-cooldown, support, worker, queue,
  and import-freeze evidence with explicit retention metadata.

A source fact that cannot satisfy a target constraint is stored in its
evidence or archive relation with a conflict decision. It is never clamped,
rounded, parsed as a date, or assigned a new semantic value merely to make a
foreign key or check pass.

## Existing tables extended in M3

The migration adds the following columns to the M1/M2 model.

| relation | columns and rule |
|---|---|
| `app.accounts` | `last_login_at` keeps the legacy `app_users.last_login_at` interactive-login instant. It is nullable and independent from M1 `last_seen_at` (`app_accounts.last_visited_at`); neither is derived from or offset relative to the other. Both leave with the account row and are included in account export. |
| `catalog.games` | `first_seen_at`, `first_seen_reason` (`seed`, `user_import`, `manual`, `unknown`) and `last_seen_at`; the source first-seen instant is kept separately from the target row creation clock. |
| `catalog.game_metadata` | `developer`, `publisher`, `release_date`; bounded text, no truncation. |
| `catalog.game_features` | duration extras/source/provider ID/source timestamp, ordinal confidence label, status/kind/manual-override, Windows/Mac tri-state, four-way Deck detail, review positive/negative/total, popularity source/metric/range/CCU/date, source capture date, tag provider/status/timestamp/failure evidence. Numeric probability remains nullable. |
| `app.playtime_daily` | `observed_minutes_semantic = 'cumulative_total'` and `games_with_playtime >= 0`; `observed_minutes` continues to mean a cumulative total and is not differenced during loading. |
| `app.game_activity` | `recency_evidence_kind` (`steam_exact`, `observed_playtime_change`, `steam_recent_window`, `unknown`) separate from M1 `evidence_source`. |
| `app.family_members` | source member UUID, lender display/avatar/profile URLs, library and imported counts, sync timestamp, and bounded raw error projection. The complete raw error remains in the archive. |
| `app.collection_games` | source position/created time/order and `position_resolution` (`source`, `stable_reorder`, `conflict`). |
| `app.pins` | raw hours-at-pin, raw text, and `baseline_conversion_status` (`exact_minutes`, `rounded_checked`, `unknown`, `conflict`). |
| `app.completion_events` | source event UUID, origin surface, nullable source game/app ID, raw hours, estimate minutes, price cents, and bounded metric provenance. |
| `ops.account_merges` | source merge UUID/mode/public IDs and analytics delivery time; source account tombstones remain valid M1 accounts. |

The `app.playtime_daily.observed_minutes` column is intentionally cumulative.
The source contains 365,610 owned playtime rows and 1,563 family rows with
null or zero hours; conversion never coalesces those cases. The source has
13,157 completion events, including 401 without hours. A separate raw field
keeps decimal authored values when exact integer minutes cannot be proven.

## New catalogue relations

All provider observations are separate from the compact read model.

* `catalog.duration_estimates` stores one provider observation per
  `(steam_app_id, provider)` with three minute measures, matching status and
  confidence, source timestamps, errors, evidence JSON, and an optional
  32-byte snapshot hash.
* `catalog.duration_aliases` stores the source title/year and an explicit
  review status. `catalog.review_decisions` stores quarantine, catalogue type,
  duration, and manual-override decisions with precedence, reviewer
  attribution, source relation/key, and bounded source payload.
* `catalog.offers` is keyed by game/provider/`US`; `catalog.offer_prices` is
  USD-only and requires nonnegative cents, a bounded discount, a retention
  timestamp, and at most one current observation per offer.
* `catalog.provider_state` stores retry state by game/provider/evidence kind.
  Processing and retry timestamps are checked against their status and failure
  counts cannot be negative.

Every source AppID remains present even when `game_map` is unresolved. A
legacy `steam_type = 'game'` projection is accepted only with a recorded
`catalogue_type` decision; the source classification is provenance and is not
silently rewritten to a new meaning.

## New application and recommendation relations

`app.vault_draws`, `app.vault_draw_events`, and `app.vault_events` retain
bounded UI history separately from `app.vault_state`. Draw rows retain source
public UUIDs, account/game mappings, collection mappings, selected genres,
pool size, reroll index, nullable finalists, action context, and the source
snapshot hash. The M1 `current_draw_ref` uses a compound foreign key with
`account_id`, so a tenant cannot point at another tenant's draw. Their
physical registry class is `ui-history-90d`: the owner-only
`app.ui_history_retention_candidates` view identifies draws older than 90 days,
draws beyond the latest 100 per account, their draw events, and aged action
events. Its existing descending account/time indexes support an account-scoped
M6 cleanup query, which must bind one account and delete in small batches; the
view's `NOT MATERIALIZED` ranking CTE lets that account predicate reach each
branch. The `LIMIT` bounds each returned batch, while ranking still processes
the selected account's rows. M3 does not run a purge. Deleting a draw
cascades its draw events and clears only `app.vault_state.current_draw_ref`;
deleting its collection clears only `app.vault_draws.collection_id`. Both are
native column-specific `ON DELETE SET NULL` actions that preserve the tenant
key.

The M6 runner's candidate read is intentionally account-scoped and
batch-bounded:

```sql
select relation_name, row_id, reason
  from app.ui_history_retention_candidates
 where account_id = $1
 order by relation_name, row_id
 limit $2;
```

The runner deletes only the returned rows, in small transactions, and repeats
the query for the same account until no candidates remain. An unscoped read of
the view is not a bounded cleanup operation.

`app.unknown_completion_history` retains source events with nullable game IDs,
actor/surface, occurred/undone state, raw metrics and provenance. A check
requires `undone_at` exactly when state is `undone`. The
`app.completion_event_registry` has one source-event UUID and an XOR between a
resolved M1 completion ID and an unknown-history ID. Partial unique indexes
prevent either target row from being claimed twice.

`reco.warm_start_snapshots` is versioned and frozen. Its user genre,
global-genre, and global-game relations hold nonnegative positive/total
aggregates (positive cannot exceed total), with source account IDs retained
when no current account mapping exists. `reco.operator_weight_versions` is a
separate versioned relation; a learning write cannot overwrite a hand-tuned
operator weight.

## Capability, abuse, support, and operational evidence

`app.account_capability_evidence` preserves the raw account-side visibility
flags, checked time, games count, precedence, projection status, conflict code,
snapshot hash, and source evidence. It is a durable account-domain fact,
deleted with the account and included in its export. The D-IDN-3 binding is:

1. the account-side tuple written by `lib/games.ts` and read by the session
   payload is authoritative;
2. the source measurements are retained without collapsing disagreements;
3. `true` can project `visible`; `false` or `NULL` projects `unknown` unless
   independent evidence proves privacy; and
4. a false flag never projects `hidden` by itself because it means no positive
   hours/last-played value was observed.

`app.game_state_legacy_measurements` is the sparse durable destination for a
stale-state row whose raw code, timestamp, dismissed playtime, or provenance
is the sole surviving evidence after reconciliation. It retains the source
user UUID and native raw values, cascades on account deletion, and is included
in account export. The complete `migration.legacy_user_game_state_audit` copy
remains bounded staging; its `evidence_disposition` must explicitly request
promotion before the staging deadline, and the sparse table never feeds the
runtime state or activity projections.

`ops.abuse_cooldowns` stores only a 32-byte key digest, bucket, observed
window/count, algorithm version, expiration, status, and snapshot hash. It
does not store a source key. `support.retention_policy_decisions` starts with
`support-content-retention = pending` and the M6-or-M7 milestone; no purge
deadline is invented. `support.contact_messages` and
`support.feedback_submissions` retain bounded email/message/context fields,
link to that pending policy, and are inaccessible to runtime roles.

## Migration bookkeeping and archives

The `migration` schema contains:

* `account_map`, `game_map`, `library_row_map`, `collection_map`, and
  `session_map`. Both source and target directions are unique. The library
  map is mandatory because six source relations plus nullable completion
  events address a game by its per-user library UUID.
* `runs`, `applied_steps`, `relation_counts`, and `conflict_report`. Counts
  and decisions go in `conflict_report`; raw values do not.
* `legacy_user_game_state_audit`, keyed by `(account_id, steam_appid)`, is the
  bounded reconciliation staging copy of the stale child. It may not feed
  `app.game_state` or `app.game_activity`. It retains the source timestamps,
  raw status codes, dismissed playtime, recency evidence time, family-owner
  fields, source user UUID, and an explicit row disposition without pretending
  timestamps are smallint code-book values. Only rows marked as needing sole
  evidence are promoted to the sparse durable
  `app.game_state_legacy_measurements` relation before staging expiry.
* `legacy_library_evidence` also retains `hours_played` as bounded numeric
  evidence plus its source text, alongside completion percentage and nullable
  date-added text that have no compact runtime destination. A missing source
  date remains NULL.
* `legacy_library_evidence`, `legacy_family_member_evidence`,
  `legacy_family_access_orphans`, `legacy_account_preferences_evidence`,
  `legacy_manual_session_audit`, `legacy_auth_intent_audit`,
  `legacy_account_merge_audit`, `legacy_purge_review_archive`, and
  `legacy_collection_membership_evidence`.
* `legacy_ingest_queue_archive`, `legacy_duration_job_archive`,
  `legacy_import_freeze_report`, and `legacy_schema_migration_ledger`.

The lasting catalogue destinations are `catalog.game_sightings`,
`catalog.seed_runs`, `catalog.duration_imports`, and
`catalog.appid_terminal_rejections`; bounded worker history is
`ops.legacy_worker_runs`. They are not duplicated under `migration` with an
unbounded retention label.

Every retention-bearing relation names an enforced class in
`ops.retention_classes`, and `ops.data_retention_registry` records its account
key, original account-UUID columns, deletion mode, and export scope. Raw
migration staging and raw export evidence use `staging-30d-post-cutover`: the
window starts only after a validated cutover and is bounded at 30 days. The
stale `legacy_user_game_state_audit` copy follows that staging bound; its
explicit sparse disposition moves only sole/conflicting facts and source UUIDs
needed after reconciliation to the durable account-domain table. A
recovery hold may delay purge only when it is separately recorded with an
incident, approver, rationale, and expiry. A staging row that is the sole home
of lasting evidence blocks the preservation gate until its durable destination
is populated. Durable account facts (including `last_login_at`, source UUIDs,
capability tuples, sparse hours discrepancies, purge decisions, orphan family
access, and completion history) cascade on account deletion and belong in
account export. The UI draw/impression/action relations use `ui-history-90d`:
the cleanup view retains at most the latest 100 draws per account and removes
rows older than 90 days. Existing descending account/time indexes support the
account-scoped runner query documented above; an unscoped view read can rank
all tenants and is not a bounded cleanup operation.

Shared catalogue facts have no account key and use a durable catalogue class;
provider price observations carry their own `retention_until`. Operational
worker history carries a row-level expiry (14 days for routine rows and 30 days
for failures). The support content deadline remains a pending M6-or-M7 policy,
but support rows that name an account still cascade and are exportable. The
schema ledger, counts, conflict classes, and retention vocabulary are permanent
bookkeeping without personal data. No real purge or cutover is performed by the
migration.

The physical retention classes therefore replace the earlier unbounded prose
windows; the current table of relation-level outcomes is:

| archive | retention |
|---|---|
| raw migration/account/library/family/collection/session/import evidence, including `legacy_user_game_state_audit` | `staging-30d-post-cutover`, after validated cutover; no credential or source payload secrets |
| sparse stale state evidence promoted to `app.game_state_legacy_measurements` | `durable-account-lifetime`; source UUIDs cascade on account deletion and are account-export eligible |
| UI draw/impression/action history (`app.vault_draws`, `app.vault_draw_events`, `app.vault_events`) | `ui-history-90d`; latest 100 draws per account and no rows older than 90 days; owner-only indexed cleanup candidate view and M6 runner |
| durable account facts and authored/provenance exceptions | `durable-account-lifetime`; cascade on account deletion and account-export eligible |
| catalogue sightings, seed/import provenance, and terminal provider verdicts | `durable-catalogue-evidence`; no account UUID; provider price rows have per-row expiry |
| routine worker history | `bounded-operational`; row expiry measured from source `started_at` (14 days routine, 30 days failure) |
| support content | `support-pending-decision` until M6-or-M7; account-linked rows still cascade and export |
| run metadata, counts, conflict reports, retention classes, and schema ledger | `migration-bookkeeping-permanent`; no personal data |

## Privacy and role boundary

M1/M2 role bindings remain unchanged: `vault_app` and `vault_worker` are
`NOLOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, and `NOCREATEROLE`; the migration is
run by the local target-like owner. New application and recommendation tables
are forced-RLS. Tenant policies use `app.current_account_id()` for draw/event
and user-preference rows. Catalogue observations have narrow read-only
policies for `vault_app`/`vault_worker`; decision, provider-state, support,
operations, archive, and migration evidence has no runtime policy.

`migration` and `support` have no `USAGE` for `public`, `anon`,
`authenticated`, `vault_app`, or `vault_worker`. No M3 table grants access to
the source project, and no M3 object exposes a token, password, session digest,
OpenID nonce, processing lease token, or provider credential.

The only new privileges on existing objects are schema `reco` usage for the
new warm-start reads and column-level update on `app.accounts.last_login_at`.
New sequence privileges are named grants for the three draw/event identity
sequences used by `vault_app`. Existing M1 sequence ACLs are not widened by an
`ALL SEQUENCES` grant.

## Replay and phase contract

The eventual owner-only loader must run in one consistent source snapshot and
carry its 32-byte snapshot/manifest hash into every map, durable evidence row,
archive row, and phase report. It uses this order:

1. freeze writes and record the source snapshot identity;
2. create the run row and validate the immutable M1/M2 hashes;
3. build account, catalogue, library-row, collection, and session maps in the
   documented deterministic order;
4. load durable catalogue evidence and account/family/collection identities;
5. load exact library/recency/playtime facts, then state/activity projections;
6. load completion registry/history, draw/action history, and preferences;
7. write conflict counts, sequence watermarks, relation counts, and archive
   retention cutoffs; and
8. mark the run successful only after all required checks pass.

Every phase is idempotent by its source key and can resume from
`migration.applied_steps`. Identity sequences are advanced above the maximum
imported identity after their phase. A conflict or unknown code blocks the
affected projection and records a count; it does not delete the source row or
choose a semantic value.

The migration itself only creates this physical contract. It does not perform
the source freeze, data load, remote apply, export, or production maintenance.

## Current measured source evidence and remaining blockers

The coordinator's fresh local aggregate evidence reports:

* 45 non-public relations; auth users, storage buckets/objects, and the HTTP
  queue have no rows. The queue shape is `(id, method, url, headers, body,
  timeout_milliseconds)`; there is no `created` column.
* 684 accounts, including two profile-less manual accounts. Visibility
  disagrees on 183 of 461 Steam accounts: 271 timestamp comparisons are
  involved. The D-IDN-3 account-side tuple remains authoritative, with all
  original flags and timestamps retained.
* one duplicate collection position requires a deterministic stable reorder
  and conflict report; no position is silently overwritten.
* family candidate counts have maximum four and no orphans; all five merge
  rows retain their source IDs. No current tombstone is required, but the
  schema supports historical deleted-source tombstones.
* completion identities and order are valid; no current tombstones are needed.
  Session token shape, expiry, and decoded-token collision checks are clean.
* playtime, completion, stale-state, and worker/queue counts remain evidence
  inputs. The source has 24,428 stale staging rows and measured disagreements
  in completion (3), last-played (1), last-observed (284), and recency (343).

The physical layer does not decide the following source-value questions:

The physical destination gaps called out by the earlier proposal are closed in
this contract: `catalog.games.first_seen_at` preserves the source catalogue
instant, `legacy_library_evidence.legacy_hours_played` preserves authored
library hours, and bounded `legacy_user_game_state_audit` carries every source
field in its native timestamp/numeric/raw-code shape while
`app.game_state_legacy_measurements` retains only explicitly promoted sparse
exceptions. `app.accounts.last_login_at`
preserves the separate interactive-login instant while M1 `last_seen_at` keeps
the long-lived-session visit instant. Those relations and fields remain
private/audit evidence where applicable and do not become runtime authority
until the loader resolves its source-value decisions.

* P05/D-LIB-1: whether authored `hours_played` or exact observed minutes is
  the authority for `app.library_games.playtime_minutes`;
* P07g/D-CE-2: events with no library row and no AppID must remain unknown
  history rather than be fabricated into a game;
* P07a/D-COL-1: the one duplicate position must use stable source order and
  retain a conflict record;
* P07e/D-LIB-4: orphan family access is quarantine evidence, never a fabricated
  lender row;
* P08/D-UGS-1: stale `user_game_state` smallint meanings are unresolved and
  cannot populate runtime state/activity;
* D-CAT-1/D-CAT-9/D-DUR-3: catalogue type, quarantine, duration aliases and
  manual duration decisions need explicit manifest decisions;
* D-IMP-1: an import in flight at freeze produces a partial-library report and
  must be re-run; its payload and processing token are not copied; and
* D-MRG-1: if a future source merge points to a deleted source account, the
  loader must retain a deleted `app.accounts` tombstone with the source public
  UUID before inserting `ops.account_merges`.

These are loader/manifest gates, not reasons to weaken the physical checks.
