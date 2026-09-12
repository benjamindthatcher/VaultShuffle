# M2 database contract

Status: approved implementation contract. This file defines the physical and
call boundaries for M2 and the migration/fixtures implement these signatures.
M1 is frozen at
`supabase/migrations/20260906093036_m1_private_foundation.sql`, SHA-256
`54fe0a7defd029e91568b78d51393670ac7ca6edcf915919670c7f64c2476389`.

The M2 migration is additive and remains under coordinator review for target
application. Its final local SHA-256 and clean replay evidence are recorded in
`M2-checkpoint.md`; local optimization and queue-serialization edits are
executable migration changes, not comment-only replay differences.

M2 remains private. Browser/Data API roles receive no table access to `ops` or
the PGMQ schema, and workers use narrow fixed-search-path definer functions.
No password, session token, API key, or provider response body is stored in
these tables. All lease times are obtained from the database clock inside
locked functions; a caller may provide provider observation provenance, but
never an expiry or lease timestamp. PGMQ is installed at its default target
version, owned by `postgres`, and exposed only through these wrappers.

## 1. Inputs and publication boundary

The input is the result of
[`normalizeSteamOwnedSnapshot`](../../lib/v2/import/steam-owned-snapshot.ts),
whose transport and fetch rules are recorded in
[`docs/v2-import-contract.md`](../../docs/v2-import-contract.md). The complete
canonical object is:

```text
{
  status: "complete", provider: "steam", protocolVersion: 1,
  gameCount: number,
  games: [{
    appId: string,                         // 1..4294967295, decimal
    playtimeMinutes: integer | null,       // 0..2147483647; null is unknown
    name: string,
    nameSource: "steam.name" | "catalog_stub",
    lastPlayedAtEpochSeconds: positive bigint | null,
    lastPlayedSource: "steam.rtime_last_played"
      | "steam.rtime_last_played_unknown" | "not_provided"
  }],
  canonicalJson: string,
  contentHash: lowercase SHA-256(canonicalJson)
}
```

`unavailable` (`private` or `provider_error`) and `invalid` results carry only
their bounded status/reason. They never sweep owned rows. An explicit,
validated complete zero is the only zero-game result eligible to sweep.

The SQL publish call accepts both the exact TypeScript `canonicalJson` bytes
and its digest. It must validate the digest over those UTF-8 bytes and parse
the text again into bounded JSONB/recordsets. It must not calculate a
replacement hash from `jsonb::text`, because JSONB does not retain the
canonical key/order or whitespace representation. SQL repeats the AppID,
count, size, name, timestamp, and integer bounds even though the TypeScript
boundary checked them.

Steam's provider sentinel `rtime_last_played = 0` is normalized to a null
last-played value before canonicalization. A non-null canonical epoch is
strictly positive; both full publication and the pinned observation function
reject zero or negative epochs rather than treating 1970 as known evidence.

The worker records two distinct times:

* `fetch_started_at` is written by `claim_job` from a fresh database clock after
  it acquires the job and any sync-row lock. It is the conservative observation
  fence for a full fetch.
* `body_observed_at` is provider provenance supplied by the validated fetch
  adapter and normalizer. It is not used to extend a lease or to make a full
  fetch newer than a pinned refresh that happened after `fetch_started_at`.

For each game, a newer confirmed personal observation made after the fence
wins. A full snapshot that began earlier cannot overwrite its minutes or
last-played value, and it cannot retire that game merely because the game is
absent from the older full body. The game remains active and a sparse anomaly
records `newer_observation_defers_removal`; the next complete observation can
reconcile it. Greatest-known personal minutes and last-played timestamps are
also monotonic. An unchanged or zero game does not receive a duplicate
measurement row just to stamp import time; `library_sync_state` records bulk
snapshot provenance.

## 2. Mapping onto M1 relations

| M1 relation | M2 use |
|---|---|
| `app.library_sync_state` | One row per account remains the generation/idempotency fence. M2 keeps lease authority solely in `ops.jobs`; it adds full-fetch provenance and `active_request_key` while preserving `generation`, `in_flight_job_id`, `applied_generation`, `authoritative_snapshot_at`, `snapshot_hash`, `observed_count`, and `last_result`. Add a compound FK from `(account_id, in_flight_job_id)` to the matching job pair. |
| `app.library_games` | Keep the compact three-column primary key plus `playtime_minutes`. Map canonical AppIDs through `catalog.games`; update only with `IS DISTINCT FROM` and never let unknown minutes erase known minutes. |
| `app.game_activity` | Keep one sparse row per account/game. Add `observation_scope` (`full_owned`, `pinned_owned`, `user`) and `last_played_source` so full and pinned evidence can be ordered without a history row per import. Update `observed_at` only when an evidence value or provenance changes. |
| `app.retired_library_games` | For a complete snapshot, retain the greatest known personal minutes and last observation for missing owned games, then remove only the active personal-access row. Reacquisition upserts active access, folds the greatest retired minutes, and removes the retired row. |
| `catalog.games` | Convert the canonical decimal AppID to the existing bounded `bigint` `steam_app_id`. Seed a minimal title and normalized sort title only when absent. A `catalog_stub` never replaces a richer title or metadata. Add a title-source marker or equivalent protection. |
| `catalog.game_metadata` / `catalog.game_features` | Shared enrichment owns these relations. An owned import may enqueue work, but never writes a provider body or overwrites richer metadata with a stub. |
| `app.vault_state` | Preserve state, history, collection memberships, pins, and snoozes during an ownership sweep. Clear `current_game_id` only when the game has neither personal nor `family_game_access`; retain draw/history references. Increment `state_revision` only when this commitment changes. |
| `app.pins` | The owned snapshot is the library scope only. Keep wishlist pins. After a complete sweep, clear a library/family/all pin only when the game has neither personal nor `family_game_access`; do not clear it merely because personal access was lost while family access remains. |
| `app.family_game_access` | Never sweep this relation from an owned snapshot. Family-only access keeps a game playable even when personal access is retired. |
| `app.account_capabilities` | A complete snapshot always makes library visibility `visible`; playtime and last-played visibility are `visible` only when the snapshot contains at least one corresponding value, otherwise `unknown`. A private response sets library `hidden` and the other fields `unknown` without changing active ownership. Transient invalid/provider-error outcomes update status only and preserve prior visibility. |
| `app.library_observation_fences` | Sparse per-account/game confirmation time for valid pinned AppIDs, including null/null measurements; it prevents an older full sweep from removing newer pinned evidence. |

The complete publish stages all rows before changing any relation. Missing rows
are retired only after the complete status, count, scope, generation, lease,
and digest checks pass. A pinned observation that is newer than the stored
`fetch_started_at` fence defers removal and is recorded sparsely. A private,
provider-error, malformed, partial, or timed-out response cannot remove rows.

## 3. Proposed private relations and constraints

### `ops.provider_controls`

One row per provider, with `provider` primary key, `mode` in `disabled |
fixture | live`, a bounded reason, `updated_at`, and no credential columns.
The M2 preview default is `steam/disabled`; a live request is rejected while
it is disabled. Fixture mode is an explicit test-only opt-in and is usable only
inside a rollback-scoped fixture. This makes the fact that unchanged
production v1 calls are outside the M2 quota accounting explicit; enabling
live Steam requires the deployment cutover integration to be reviewed first.

### `ops.jobs`

```text
id                 uuid primary key
job_kind           text: owned_snapshot | catalog_enrichment
lane               text: interactive | background
account_id         integer nullable FK app.accounts ON DELETE CASCADE
game_id            integer nullable FK catalog.games ON DELETE CASCADE
provider           text not null
generation         bigint nullable, >= 0
catalog_revision   bigint nullable, >= 0
first_request_key  uuid nullable
dedupe_key         text not null, btrim length 1..256
status             text: queued | enqueued | leased | fetching | publishing
                   | succeeded | unavailable | invalid | retryable | failed | cancelled
attempt            smallint 0..5
max_attempts       smallint 1..5
available_at       timestamptz not null
lease_token        uuid nullable
lease_expires_at   timestamptz nullable
fetch_started_at   timestamptz nullable
queue_name         text nullable, fixed by lane
message_id         bigint nullable
result_hash        bytea nullable, exactly 32 bytes
observed_count     integer nullable, >= 0
result_code        text nullable, bounded
result_detail      text nullable, <= 2000 characters
retry_policy       text: none | retryable | deferred | non_retryable
provider_retry_at  timestamptz nullable, provider minimum, not a lease time
protocol_version   smallint nullable, bounded positive integer
created_at         timestamptz not null
updated_at         timestamptz not null
completed_at       timestamptz nullable
retain_until       timestamptz nullable; 14 days for success, 30 for terminal
completed_lease_token uuid nullable; binds terminal replay
applied_generation bigint nullable; committed generation summary
```

Shape checks require an `owned_snapshot` job to have an account, an authorized
active profile, `steam` provider, generation, and no game; manual accounts may
use an unverified linked profile while `steam` accounts require verification.
An enrichment job has a game, `steam_store` provider, and revision, and no
account. The provider/job-kind pairing is enforced by the row constraint, so a
catalogue job cannot be treated as a keyed Steam Web API job. Exactly one active owned job is
allowed per account, regardless of refresh bucket. A partial unique index on
`(account_id)` over `owned_snapshot` jobs in `queued, enqueued, leased,
fetching, publishing, retryable` provides that fence. `ops.job_requests` has a
compound `(account_id, job_id)` foreign key to the matching job pair and a
globally unique request key recorded with its account, so an alias cannot point
at another tenant's job. A separate unique index on `(account_id, first_request_key)` plus
the retained aliases remains in force for retained completed jobs;
the same request key can never create a different job. Shared enrichment uses
a partial unique index on its semantic `dedupe_key`. Add indexes for due jobs,
lease expiry, account/generation, and `(provider, game_id, catalog_revision)`.
The optional queue name is constrained to the lane's fixed queue. Provider
charge rows use a compound account/job foreign key when a job is present.

Jobs contain status and bounded result metadata only. They do not contain a
library array or raw provider body. Account deletion cascades account-owned
jobs and leaves shared catalogue jobs account-independent.

### `ops.provider_quota_daily` and `ops.provider_token_buckets`

Quota uses a daily UTC counter plus token buckets; it does not use fixed
per-minute windows. `provider_quota_daily` is keyed by provider, UTC date, and
lane scope (`all` or `background`) and stores a daily limit and charged call
count. The initial limits are 80,000 global calls/day and 50,000 background
calls/day. Interactive calls use remaining global capacity; there is no hard
30,000-call interactive bucket.

`provider_token_buckets` is keyed by provider and scope (`global` or
`background`) and stores configurable capacity, refill-per-second, current
tokens, and the last-refill timestamp. Initial burst policy is global capacity
120/refill 2 per second and background extra capacity 60/refill 1 per second.
The database clock refills and debits buckets under row locks. A global debit is
required for every endpoint; a background debit additionally consumes the
background bucket and daily count. Daily dates and refill calculations use a
fresh clock after all required locks are acquired.

`ops.provider_call_charges` is a bounded attempt ledger with provider, job,
endpoint, attempt UUID, lane, units, charged-at, and database timestamps. A unique
`(attempt_id)` makes a committed charge idempotent. Charges are deliberately
nonrefundable: a crash after claim and before network I/O may waste one call,
but it cannot return capacity or let a retry spend an expired day's budget.
Every actual retry is charged again. The allowlisted endpoint values include
`owned_snapshot`, `profile`, `vanity`, `public_owned_lookup`, `recent`, and
`pinned`, so this boundary is reusable without adding provider credentials to
SQL. Shared catalogue work uses the separate `steam_store` outbox/provider
class and is not charged against the keyed Steam Web API budget. Preview
remains provider-disabled and uses no live calls.

### `ops.enrichment_outbox`

```text
id                bigint generated always as identity primary key
provider          text not null
game_id           integer not null FK catalog.games ON DELETE CASCADE
catalog_revision  bigint not null, >= 0
kind              text not null
status            text: pending | enqueued | succeeded | retryable | failed
attempt           smallint 0..5
available_at      timestamptz not null
last_error_code   text nullable, bounded
last_error_detail text nullable, <= 2000 characters
created_at        timestamptz not null
enqueued_at       timestamptz nullable
completed_at      timestamptz nullable
```

Unique `(provider, game_id, catalog_revision, kind)` coalesces shared work.
The owned publish transaction inserts with `ON CONFLICT DO NOTHING`; a
dispatcher turns the row into one background job/message. The outbox contains
references and error metadata, never the complete provider response.

### Small M1 alterations

Add full-fetch provenance and the compound job FK to
`app.library_sync_state`; lease/token authority remains in `ops.jobs` so there
is one source of truth. Add `observation_scope` and `last_played_source` checks to
`app.game_activity`; add a sparse `app.library_observation_anomalies` relation
with account/game, job, observed-at, prior/incoming minutes, reason, and a
bounded provider/source code. Its unique key is an event/dedupe key, and it
does not hold raw bodies. Add `title_source` to `catalog.games`, or an
equivalent protected source column, so stubs cannot overwrite curated/provider
metadata. All new private tables are forced-RLS deny-all to both runtime
roles; definer functions are the only write path.

The pinned path is executable rather than test-only evidence injection:

```text
app.begin_pinned_owned_refresh(
  p_game_id integer
) returns table(
  allowed boolean,
  block_code text,
  attempt_id uuid,
  attempt_token uuid,
  provider_subject bigint,
  provider_mode text,
  fetch_started_at timestamptz,
  expires_at timestamptz,
  retry_at timestamptz
)

app.record_pinned_owned_observation(
  p_attempt_id uuid,
  p_attempt_token uuid,
  p_result jsonb
) returns table(
  accepted boolean,
  game_id integer,
  observed_at timestamptz,
  minutes integer,
  current_library boolean
)
```

`vault_app` execute only; the account and linked SteamID come from the current
principal/profile. Manual accounts may use an unverified linked profile; Steam
accounts require a verified linked profile. `p_result` is a bounded validated
owned-game result and must
contain `status = complete` plus the canonical AppID matching the attempt's
authorized pinned game; null/null without that AppID never confirms access.
The attempt/token comes from `consume_provider_attempt` with endpoint `pinned`,
is checked for expiry and supersession by a newer full-authority fetch, and is
single-use. The function uses a fresh database clock for `observed_at`,
advances scoped freshness even when minutes are unchanged, and writes/retains
personal access and activity atomically. It is the path used by the concurrent
fence fixture; callers cannot manufacture a different account's evidence.

## 4. Exact call interfaces

All functions below have fixed `search_path` (`pg_catalog`, then only the
explicit private schemas), are `SECURITY DEFINER` where noted, and reject
unknown lane/provider values. They use `clock_timestamp()` after acquiring
their locks for lease/quota validity. Callers cannot supply account IDs for
tenant functions.

### Request, coalescing, and status

```text
app.request_owned_snapshot(
  p_request_key uuid,
  p_lane text default 'interactive'
) returns table(
  job_id uuid,
  status text,
  generation bigint,
  coalesced boolean,
  quota_retry_at timestamptz
)

ops.request_owned_snapshot_for_account(
  p_account_id integer,
  p_request_key uuid
) returns table(
  job_id uuid,
  status text,
  generation bigint,
  coalesced boolean,
  quota_retry_at timestamptz
)
```

`app.request_owned_snapshot` is `vault_app` execute only and derives the
account and linked SteamID from the current principal/profile. Active manual
accounts may import an unverified linked profile; a `steam` account must have
its linked profile verified. The worker variant is `vault_worker` execute only,
fixes the lane to `background`, and revalidates the active account and linked
profile with the same manual/verified-Steam rule; it does not accept a SteamID
or provider identity. Both reject `disabled`, require fixture mode to be
explicitly enabled inside a rollback-scoped fixture, and lock the sync row.
They create one queued job per account regardless of refresh bucket. UUID
request keys are unique through retained completion; a second request while an
active job exists maps to that job instead of creating another one. Enqueueing
does not debit quota or create a lease; the claim immediately before network
I/O does both atomically.

```text
app.get_owned_snapshot_status(
  p_job_id uuid
) returns table(
  job_id uuid,
  status text,
  generation bigint,
  applied_generation bigint,
  snapshot_hash bytea,
  observed_count integer,
  result_code text,
  result_detail text,
  updated_at timestamptz
)
```

`vault_app` execute only and account-scoped. It returns the committed result
after response loss; it never exposes queue internals or provider errors beyond
the bounded safe fields.

### Quota and queue wrappers

```text
ops.consume_provider_attempt(
  p_endpoint text,
  p_job_id uuid default null,
  p_scope_game_id integer default null,
  p_units integer default 1,
  p_attempt_id uuid default null,
  p_ttl_seconds integer default 120
) returns table(
  allowed boolean,
  block_code text,
  attempt_id uuid,
  attempt_token uuid,
  account_id integer,
  provider_subject bigint,
  provider_mode text,
  fetch_started_at timestamptz,
  expires_at timestamptz,
  retry_at timestamptz,
  global_daily_remaining bigint,
  background_daily_remaining bigint,
  global_tokens numeric,
  background_tokens numeric
)

ops.enqueue_job(
  p_job_id uuid
) returns table(message_id bigint, queue_name text)
```

This is a migration-owned definer boundary for the allowlisted keyed Steam
Web API endpoints `owned_snapshot`, `profile`, `vanity`, `public_owned_lookup`,
`recent`, and `pinned`. It derives account and linked SteamID from the current
principal or job/profile. Manual accounts may use an unverified linked profile;
Steam accounts require a verified linked profile. It checks `provider_controls`,
and debits global daily
plus token-bucket capacity and background capacity atomically. For `pinned`,
`p_scope_game_id` must be a current bounded `library` or `all` pin for that
account. The DB issues the attempt token and expiry. No provider identity is
accepted from a request body. `p_units` is positive and bounded.

For pre-session `profile`, `vanity`, and `public_owned_lookup` calls only, the
separate `app.consume_provider_attempt(p_endpoint, p_units, p_attempt_id,
p_ttl_seconds)` wrapper may issue an interactive charge with no account or
subject and grants no tenant access or identity proof. `owned_snapshot`,
`recent`, and `pinned` require stored account/profile context. The pre-session
caller's independently validated lookup/OpenID input is never treated as the
database principal. A fresh call through this wrapper is rejected when a
transaction already has an account principal; only a previously recorded
attempt may be replay-checked. Runtime workers reach the raw helper through
the fixed claim/request/pinned paths; it is not granted as an arbitrary
job-ID RPC to `vault_worker`.

`ops.enqueue_job(p_job_id uuid) returns table(message_id bigint,
queue_name text)` is worker/scheduler-only and does not charge quota. It chooses
`vault_interactive` or `vault_background` from the job lane; callers cannot
inject a PGMQ queue name. Messages contain only the job UUID and bounded
protocol version. Interactive and background lanes use separate queues.

```text
ops.claim_job(
  p_lane text,
  p_visibility_seconds integer default 120
) returns table(
  claimed boolean,
  block_code text,
  retry_at timestamptz,
  job_id uuid,
  message_id bigint,
  job_kind text,
  account_id integer,
  game_id integer,
  provider text,
  provider_subject bigint,
  provider_mode text,
  generation bigint,
  catalog_revision bigint,
  lease_token uuid,
  attempt integer,
  attempt_id uuid,
  attempt_token uuid,
  charged_at timestamptz,
  fetch_started_at timestamptz,
  lease_expires_at timestamptz,
  global_daily_remaining bigint,
  background_daily_remaining bigint,
  global_tokens numeric,
  background_tokens numeric
)

ops.renew_job_lease(
  p_job_id uuid,
  p_lease_token uuid,
  p_visibility_seconds integer
) returns table(ok boolean, lease_expires_at timestamptz)

ops.ack_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_message_id bigint
) returns boolean

ops.retry_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_error_code text,
  p_error_detail text,
  p_provider_retry_at timestamptz default null,
  p_retry_policy text default 'retryable',
  p_message_id bigint default null
) returns table(status text, retry_at timestamptz, attempt integer, acknowledged boolean)
```

`vault_worker` execute only for the public worker wrappers. Queue wrappers all take the lane advisory lock
before any PGMQ read/delete/visibility operation, then use the common
queue -> account sync -> job order. `claim_job` uses the fixed lane queue's
PGMQ visibility read, locks the job and account sync row, derives the authoritative
SteamID/profile and mode, then charges one provider attempt and writes a fresh
lease token and `fetch_started_at` in the same transaction immediately before
the worker fetch. The visibility window and DB lease are 15..300 seconds,
default 120. A budget denial leaves the message queued/visible later and
returns `claimed = false`; no fetch starts. `renew_job_lease` checks the current
token, exact owned sync pointer/generation, active profile, and charged Steam
subject, then uses a fresh clock after lock wait. `retry_job` repeats those
sync/profile/subject checks before changing retry state. `ack_job` deletes only
the matching PGMQ message after the applied marker is present. A stale worker
cannot renew, publish, retry, or acknowledge a newer generation.

The fetch boundary converts a supported numeric or HTTP-date `Retry-After` to
`p_provider_retry_at` using its injected observation clock. `retry_job` computes
the final schedule as the maximum of the bounded exponential backoff/jitter
and this provider minimum; it never shortens a provider delay. A valid delay
outside the scheduler's normal horizon is recorded with `retry_policy =
'deferred'` and its safe future time, or with `non_retryable` when the adapter's
explicit policy says it cannot be scheduled. The job result exposes the policy
and bounded code/detail, so an out-of-range delay is never silently changed to
an arbitrary one-hour retry. `p_provider_retry_at` is provenance/scheduling
input, not a lease or expiry supplied by the caller; lease validity still uses
a fresh database clock after lock acquisition.

The migration installs the default PGMQ extension version as `postgres`, creates
`vault_interactive` and `vault_background`, and revokes direct browser/runtime
access to the PGMQ schema. It pins no extension version.

### Atomic owned publish

```text
ops.publish_owned_snapshot(
  p_job_id uuid,
  p_lease_token uuid,
  p_result jsonb,
  p_canonical_json text default null,
  p_content_hash bytea default null,
  p_body_observed_at timestamptz default null,
  p_message_id bigint default null
) returns table(
  result text,
  job_id uuid,
  account_id integer,
  generation bigint,
  applied_generation bigint,
  snapshot_hash bytea,
  observed_count integer,
  library_changed integer,
  activity_changed integer,
  retired_count integer,
  sweep_deferred_count integer,
  enrichment_enqueued integer,
  acknowledged boolean
)
```

`vault_worker` execute only. The function takes the lane queue lock, then locks
the corresponding `library_sync_state` and job, and obtains a fresh database
clock. The charged attempt's Steam subject must still match the active stored
profile before any private rows are changed. The sync generation must equal
the job generation exactly; a newer or older sync generation is stale. It
returns
`stale` without writes for a wrong/expired lease or generation. A duplicate
call after a committed publish returns `already_applied` with the stored
generation/hash/count. It accepts `complete`, `unavailable`, and `invalid`:

For `complete`, `p_result` contains only the bounded status and small
provenance (`status`, provider, protocol version, game count, fixed complete
scope, HTTP status/body byte count, and safe retry metadata). It contains no
game array. The exact canonical text contains the only game array and has
exactly `provider`, `protocolVersion`, `gameCount`, and `games` (no status,
canonicalJson, or hash fields). The decoded 32-byte `p_content_hash` is a
separate argument so SQL can validate the TypeScript hash without relying on
JSONB serialization. Receipt-time validation allows the normalizer's expected
less-than-one-second Unix-second truncation when comparing `body_observed_at`
to the microsecond `fetch_started_at`; the fresh DB clock remains authoritative
for leases.
For `unavailable` or `invalid`, `p_canonical_json` and `p_content_hash` are
null and `p_result` contains only the bounded status/reason fields.

1. For `complete`, validate the canonical text/digest and the entire bounded
   game set before opening the ownership sweep. Upsert catalogue identities,
   changed personal minutes, sparse activity, and deduplicated enrichment;
   archive/delete only missing personal access; preserve state, collections,
   history, pins, snoozes, and family access; then update the sync/job applied
   marker and optionally delete the matching PGMQ message in the same
   transaction.
2. For `unavailable` or `invalid`, update job/result and account capability
   status only. A private response additionally sets library visibility to
   `hidden` and playtime/last-played visibility to `unknown`; transient
   invalid/provider-error outcomes preserve prior visibility. Keep active
   library, retired rows, and playable commitments unchanged. A private
   response is not an empty response.

For complete reacquisition, the active minutes are the greatest known value
from incoming, active, activity, and retired personal evidence. A lower
provider value is retained as an anomaly, not silently applied. Missing games
with a newer `pinned_owned` observation after `fetch_started_at` remain active
and receive a sparse deferral event. Otherwise, missing rows are copied to
`retired_library_games` with last observation/provenance and only their active
personal rows are deleted. If a complete sweep leaves a library, family, or all
pin with neither personal nor family access, clear that pin; keep wishlist pins.
If `vault_state.current_game_id` then has no personal or family access, clear
that current pick while retaining its draw reference and history. Personal loss
while family access remains does not clear a playable commitment. Increment
`library_revision` only for an actual access/fact change and `state_revision`
only when a commitment changes.

The function does not stamp unchanged `game_activity` rows. It updates the
account sync observation time/count even when the row-level write count is
zero. The result/job marker is written before an acknowledgement; a retry after
transport or response loss is therefore idempotent.

### Shared enrichment

```text
ops.enqueue_enrichment(
  p_provider text,
  p_game_id integer,
  p_catalog_revision bigint,
  p_kind text
) returns table(outbox_id bigint, coalesced boolean)
```

Worker-only definer call. It validates the game/revision and uses the outbox
unique key. The owned publish function calls it in the same transaction for
new/changed minimal identities; the dispatcher may create one shared background
job, but `steam_store` work has no keyed Steam Web API quota reservation or live
claim path in M2. Rich catalogue updates remain separate from owned-access
reconciliation.

## 5. Queue, lease, and quota rules

The database transaction never performs network I/O. A worker claims briefly,
charges one nonrefundable provider attempt, fetches outside the transaction,
and publishes only with the current token and generation. PGMQ visibility is
at-least-once transport, not business exactly once. Visibility renewal,
bounded exponential backoff with jitter, `Retry-After`, capped attempts,
terminal status, and bounded replayable error metadata are recorded in
`ops.jobs`; successful and terminal failure messages are deleted atomically.
Every actual retry is charged again. A crash before fetch may waste one
charged call, and a queued job never carries a reservation across a UTC day.

Semantic keys are:

* personal: `(provider, account_id, owned_snapshot)`;
* shared: `(provider, game_id, catalog_revision, kind)`.

Only one active owned job per account exists. Account deletion cascades
personal jobs/charge records and cannot be blocked by queue or audit rows.
Shared catalogue work remains independent of a deleted account. Durable TTL
cleanup is a scheduled-worker policy: successful jobs are retained fourteen
days, terminal/dead-letter jobs thirty days, and no raw body is retained. Cleanup is
not part of the M2 publish transaction.

## 6. Required tests and evidence

The M2 SQL fixture must be management-compatible: one pure SQL request,
transaction-scoped test-role `SET` grants, no psql variables inside dollar
quotes, no `TRUNCATE`, and cleanup limited to synthetic keys or a full
rollback. A separate two-connection fixture is required for quota and fencing
because a single management request cannot expose interleavings.

The fixture set must assert:

* private RLS/default ACLs: browser roles cannot see or call `ops`; only the
  intended runtime role can execute each wrapper; queue names/search paths are
  fixed;
* normalizer mapping: explicit zero versus private/error, canonical text hash
  versus JSONB text, duplicate/count mismatch, invalid/negative/overflow AppID
  and minutes, non-positive known last-played epochs, malformed names/timestamps,
  >10,000 rows, >8 MiB, and no partial publish;
* publish correctness: new/changed-only rows, unchanged/zero sparsity, unknown
  minutes and last-played preservation, provider decrease anomaly, newer pinned
  observation/fetch-start fence, deferred removal, complete-only retirement,
  reacquisition using max-known minutes, family-only access, wishlist pins,
  current-pick invalidation, capability visibility for complete-zero/all-null/
  known snapshots, private-after-known hiding, transient error preservation,
  and preservation of state/collections/history;
* fencing/idempotency: missing/wrong/expired token, generation race, two
  workers finishing out of order, same request coalescing, response loss and
  repeated hash, rollback on malformed payload, and a complete zero sweep;
* quotas: daily UTC 80,000 global/50,000 background counters, global and
  background token-bucket refill, concurrent debit capacity, disabled/fixture/
  live modes, generic allowlisted endpoints, nonrefundable claim charges,
  retries charged again, and bounded Retry-After/deferred scheduling;
* PGMQ/jobs: queue creation/ownership, lane routing, bounded job-id messages,
  visibility reclaim/renewal at 120 seconds (15..300 bounds), stale ack
  rejection, backoff, max five attempts, terminal/dead-letter state, and
  enrichment outbox deduplication;
* observation fencing: same-second receipt/start tolerance, both old-full/new-
  pinned and old-pinned/new-full orderings, scoped freshness when minutes are
  unchanged, stale pinned attempt rejection, and no revival after a newer full
  authority;
* bounded transaction work: 1,001 and 10,000 game snapshots, no network call
  in publish, and measured changed-only writes with a target transaction budget
  of five seconds.

## 7. Fixed implementation decisions

1. Install the default PGMQ version as `postgres`, create durable
   `vault_interactive` and `vault_background`, and expose no direct PGMQ
   schema access. Do not pin an extension version.
2. Use daily UTC counters plus global/background token buckets: global/day
   80,000, background/day 50,000, global capacity 120/refill 2 per second,
   background extra capacity 60/refill 1 per second. Interactive uses unused
   global capacity and has no separate hard ceiling.
3. Queue jobs without quota; claim charges one attempt and creates the lease
   atomically immediately before network I/O. Charges are nonrefundable;
   retries charge again. The allowlisted charge boundary is generic across
   provider endpoints.
4. Keep typed provider modes. Preview is disabled; fixture mode requires an
   explicit rollback-local opt-in; live mode is a separately reviewed
   deployment setting.
5. Keep one active owned job per account regardless of refresh bucket. Request
   UUID uniqueness persists through retained completed jobs. Both app and
   worker request paths derive the linked Steam profile/SteamID; manual
   accounts may use an unverified profile, while Steam accounts require
   verification. Every coalesced request UUID is retained through completion
   by an account/request-to-job mapping.
6. Keep exact canonical text plus digest and small status/provenance metadata;
   games are supplied only in canonical text. Successful/terminal publish and
   matching PGMQ acknowledgement are one transaction.
7. Use 120-second default leases/visibility (15..300 bounds), renew before
   40 seconds, max five attempts, and bounded backoff plus provider minimum
   Retry-After. Retain success fourteen days and terminal/dead-letter rows thirty
   days; TTL cleanup is scheduled-worker policy.
8. The pinned path is DB-issued-attempt/token bound, pin-scope authorized, and
   rejects stale/expired attempts or attempts superseded by newer full authority.
   A null/null result without the validated AppID is not ownership evidence.
9. Catalogue identities are soft-retired. Intentional catalogue deletion may
   cascade ephemeral jobs/outbox rows; no blanket reverse library index is
   introduced.
10. A complete result sets library visibility to `visible`, with playtime and
    last-played visibility `visible` only when the snapshot contains a
    corresponding value; otherwise those fields are `unknown`. Private sets
    library `hidden` and the other fields `unknown`, while transient invalid or
    provider-error results preserve existing visibility.
