# v2 Steam owned snapshot contract

This document defines the pure boundary used before a Steam owned-library
snapshot can be published into v2. The implementation is
[`lib/v2/import/steam-owned-snapshot.ts`](../lib/v2/import/steam-owned-snapshot.ts)
and has no provider, network, database, queue, or environment access. It
normalizes one complete JSON body; it does not perform the fetch that produced
that body.

## Publication states

`normalizeSteamOwnedSnapshot` returns exactly one of these states:

| State | Meaning | May remove owned rows? |
|---|---|---:|
| `complete` | The body is structurally valid, bounded, internally counted, and every game row passed validation. Zero rows are allowed only after an explicit zero confirmation. | Only after the fetch boundary also proves a complete owned scope and the SQL transaction fences the generation. |
| `unavailable` | Steam did not provide a usable library, such as `{response:{}}` (private) or a provider error marker without game payload. | No |
| `invalid` | The body or one of its records is malformed, contradictory, over a limit, or cannot be represented by the v2 contract. | No |

The normalizer never drops an invalid row and publishes the remainder. A
duplicate, malformed, or otherwise invalid row rejects the whole snapshot.

`{response:{game_count:0,games:[]}}` and `{response:{game_count:0}}` are
explicit empty confirmations and return `complete`. `{response:{}}` returns
`unavailable/private`; it is not an empty library. A `success:false` marker or
an `error` string/object at either the wrapper or `response` level, when
accompanied by `game_count` or `games`, is contradictory and returns `invalid`,
including when the count is zero. A provider error marker without a game
payload returns `unavailable/provider_error`. An explicit `success:true` marker
with an empty `{response:{}}` is also contradictory; the unmarked empty
response remains `unavailable/private`.

## Input and field rules

The public transport forms accepted by the pure boundary are a parsed JSON
value, a JSON string, or UTF-8 bytes in a `Uint8Array`. Byte limits are checked
before parsing and again against the canonical output. UTF-8 decoding is fatal;
malformed byte sequences are not replacement-decoded. Direct objects that
cannot be JSON serialized (including objects containing `bigint` values or
cycles) are invalid. Consequently, a direct JavaScript `bigint` AppID is not a
separate accepted input form: AppIDs arrive through JSON as a number or decimal
string, and the JSON boundary rejects a direct bigint before row normalization.

The default and hard limits are:

| Field | Rule |
|---|---|
| Snapshot game count | `0..10,000`; `game_count` must be a safe integer and equal the array length when `games` is present. |
| Payload | At most 8 MiB of UTF-8 input and canonical output by default. A caller may lower the limit, never raise it above 8 MiB. |
| Parsed JSON structure | The compatibility scan is iterative and bounded at depth 256 and 250,000 visited values/keys. Exceeding either bound is invalid; this prevents deep or broad bodies from consuming the call stack. |
| AppID | Positive decimal number/string in the unsigned 32-bit range `1..4,294,967,295`; canonical output retains a decimal string. Leading-zero strings, booleans, fractions, negatives, and overflow are invalid. |
| Playtime | `null` or omitted means unknown; `0` remains explicit zero. Positive values are exact safe integers no greater than `2,147,483,647`, matching PostgreSQL `integer`. Strings, fractions, negatives, non-finite values, and overflow are invalid. |
| Name | A nonempty string is trimmed and retained, subject to the 500-character catalogue title bound. Omitted, `null`, or whitespace-only names become the explicit `Steam App <appid>` `catalog_stub`. NUL, other control characters, and malformed surrogate sequences are invalid. |
| `rtime_last_played` | Omitted, `null`, or `0` becomes a null timestamp with provenance distinguishing omitted from provider-reported unknown. A positive value is a nonnegative safe Unix-second integer within the conservative PostgreSQL `timestamptz` bound. |

Positive `rtime_last_played` values require
`observationTimeEpochSeconds` in the normalizer options. The fetch boundary
supplies this value from the instant it received the complete body; the
normalizer does not call `Date.now()`. By default, a timestamp may be at most
five minutes after that anchor. The caller may choose a smaller or bounded
larger `maxFutureSkewSeconds`, up to 31 days. Values outside the bound reject
the entire snapshot. This makes a future or corrupt provider timestamp
unpublishable while keeping the canonical hash independent of wall-clock time.

Disallowed control characters, including escaped NUL (`\u0000`), and malformed
surrogate sequences anywhere in the parsed provider JSON are rejected. The
compatibility scan checks object keys as well as string values, including
irrelevant provider fields. This keeps a body that may later be staged as JSONB
representable by PostgreSQL as well as keeping provider names safe for the
catalogue text column.

The timestamp anchor and skew are validation inputs only. They do not appear in
`canonicalJson` or `contentHash`, so retries of the same normalized rows have
the same hash when they use different valid observation instants.

## Canonical form and hash

Every complete result has this provider-independent shape:

```json
{
  "provider":"steam",
  "protocolVersion":1,
  "gameCount":2,
  "games":[
    {
      "appId":"42",
      "playtimeMinutes":0,
      "name":"Example",
      "nameSource":"steam.name",
      "lastPlayedAtEpochSeconds":null,
      "lastPlayedSource":"steam.rtime_last_played_unknown"
    },
    {
      "appId":"4294967295",
      "playtimeMinutes":null,
      "name":"Steam App 4294967295",
      "nameSource":"catalog_stub",
      "lastPlayedAtEpochSeconds":1700000000,
      "lastPlayedSource":"steam.rtime_last_played"
    }
  ]
}
```

Records are sorted numerically by canonical decimal AppID. Input object key
order, provider array order, omitted versus irrelevant provider fields, and the
transport representation do not change the result. `canonicalJson` is the
ordinary deterministic `JSON.stringify` representation of that shape and
`contentHash` is its lowercase SHA-256 hex digest. Transport metadata,
observation time, HTTP headers, raw error text, and provider response fields do
not enter the hash.

Names are only identity-time hints. A `steam.name` value may seed a minimal
catalogue identity; a `catalog_stub` is an explicit fallback and must not erase
richer catalogue metadata. The snapshot contains only the current account's
owned rows and never lender, family, achievement, price, or catalogue facts.

## Required fetch boundary before publication

The pure normalizer cannot establish facts that are absent from a JSON body.
The future Steam fetch adapter must therefore validate all of the following
before a `complete` result is eligible for an ownership sweep:

1. The request was authenticated/authorized for the account being refreshed,
   and the account's generation/lease was reserved before the fetch.
2. The HTTP response was the endpoint's ordinary `200 OK` full response, the
   body was fully read before its bounded limit, and the content was parsed as
   the expected JSON document. Partial (`206`), queued (`202`), bodyless
   (`204`), other HTTP errors, timeout, truncation, and malformed content
   become `unavailable` or `invalid` and cannot sweep ownership.
3. The request asked for the complete owned-games scope, including the
   provider's full list semantics and any required app-info fields. It must not
   use `appids_filter`, a page/subset filter, a pinned-games list, or another
   partial scope. A successful response to a filtered request is not a complete
   snapshot.
4. `observationTimeEpochSeconds` is captured once for the received complete
   body and passed to the normalizer. It is stored as snapshot provenance by
   the import job/SQL adapter, but is excluded from the canonical hash.
5. Only a `complete` result from that validated full-scope request can enter the
   bounded SQL publish transaction. `unavailable` and `invalid` results update
   job/capability status as appropriate and leave active ownership untouched.

No network call belongs inside the publish transaction. The transaction locks
the account sync row, checks the generation/lease and idempotency key, and then
publishes the already-normalized rows.

## Concrete Steam fetch boundary

`lib/v2/import/steam-owned-fetch.ts` implements the M2 preparation boundary as
`fetchSteamOwnedSnapshot(steamId, apiKey, options)`. The caller supplies the
fetch function, observation clock, timeout, and account cancellation signal.
The caller must first complete the authorized quota reservation and generation
or lease reservation. The adapter then runs outside the SQL transaction; a
future worker passes only its `complete` result into the atomic publish and
outbox transaction.

The adapter validates a positive, canonical decimal SteamID string before any
request. Steam documents the method argument as `uint64`, while the M1 account
key is a signed PostgreSQL `bigint`, so this boundary additionally caps the
individual identifier at `9223372036854775807` until the account-key contract
changes. The provider and SQL bounds are explicit constants in the adapter.

The request is fixed to the existing
`https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/` route. The
current primary Steamworks reference documents `steamid` (`uint64`),
`include_appinfo`, `include_played_free_games`, and optional `appids_filter` at
<https://partner.steamgames.com/doc/webapi/iplayerservice>. The adapter sets
`include_appinfo=1` and `include_played_free_games=1`, explicitly sets
`skip_unvetted_apps=0` to avoid the provider's omission of unvetted/profile
limited apps, and omits `appids_filter`, `input_json`, paging, and every caller
supplied subset. The unvetted flag is retained as an explicit request and
provenance policy even though it is not listed in the current public reference.
The request also uses `redirect: "error"`; an API key must never be carried to
an untrusted redirected URL.

The body is read through a `ReadableStream` with the normalizer's 8 MiB cap
(or a lower caller limit) before UTF-8 parsing. Declared lengths over the cap,
stream overflow, stream errors, incomplete content-length, fatal UTF-8
decoding, and normalizer failures cannot produce `complete`. Fetch and body
reads race the internal timeout and cancellation signal, including when an
injected fetch or stream ignores abort. There is exactly one fetch invocation;
the boundary never retries or hides additional quota use. HTTP status and
`Retry-After` metadata are sanitized for later retry scheduling. Numeric or
HTTP-date delays up to `MAX_STEAM_RETRY_AFTER_SECONDS` (30 days) are retained
without shortening; HTTP dates use the injected clock. Missing `Retry-After`
on a `429` uses the bounded 60-second default. Malformed values or valid
delays beyond 30 days return `retryDisposition: "deferred"` without a made-up
short delay. Request URL, API key, response body, and upstream error text
never appear in returned errors.

The public result is:

```text
complete   = normalized SteamOwnedSnapshot + provenance
unavailable = private | provider_error | http_error | timeout | cancelled | transport_error
             + httpStatus? + retryAfterSeconds? + retryDisposition?(retryable|deferred)
invalid    = normalizer/body/argument failure with a bounded safe reason
```

Only `complete` carries trusted provenance: the fixed endpoint identity,
`complete_owned` scope, both inclusion flags, `skipUnvettedApps: false`, HTTP
status, exact body byte count, and the injected observation timestamp. The
timestamp is passed to the normalizer for future-clock validation and is kept
out of the canonical hash. `unavailable` and `invalid` results cannot sweep
owned rows.

## Single claimed-job orchestration boundary

`lib/v2/import/steam-owned-job-orchestrator.ts` implements
`runSteamOwnedSnapshotJob(claim, options)` for one successful
`ops.claim_job` result. It does not poll a queue, claim another row, choose a
lane, or discard catalogue work from a shared lane. The application mapping of
the frozen row keeps PostgreSQL `bigint` values as decimal strings and maps
`provider_subject` to the required `steamId`; `providerMode` is copied from the
database's `disabled | fixture | live` control. Caller supplied identity,
filters, and mode are not accepted.

The runner has no default transport. A worker must explicitly inject a
`fixture` or `live` transport, and the selected mode chooses only that
transport. Disabled mode and a missing selected transport return a typed
refusal without a network or database call. The transport receives the
database-derived claim and an abort signal, then runs outside the claim and
publish transactions. Quota, generation, lease, and authorization reservation
remain the frozen database boundary that precedes this call.

Only a complete result passes `canonicalJson`, its decoded 32-byte SHA-256,
the fixed full-scope provenance, and the body observation timestamp to
`ops.publish_owned_snapshot`. The small JSONB result has the complete status,
game count, fixed scope flags, HTTP 200, and body byte count; the game array is
present only in the exact canonical text. Private/provider-error results are
published with only their bounded status/reason and null canonical fields.
Invalid results follow the same terminal publish path with a bounded reason.
Transient HTTP, timeout, cancellation, and transport outcomes use
`ops.retry_job`; a valid provider minimum is converted with the injected clock
or the policy becomes `deferred` rather than retrying early. Retryable work
leaves `messageId` null for the database to reschedule. Deferred and
non-retryable outcomes pass the matching message ID so the database can settle
the queue message atomically. The runner never calls a standalone ack.

The claim lease timestamps are parsed before transport and an expired or
malformed claim is refused; claims more than five minutes in the future are
also refused to avoid fetching against a nonsensical lease. The database
remains authoritative for the final lease and generation fence. If the publish
response is lost after a commit,
the failure result contains an internal prepared publish value for
`resumeSteamOwnedSnapshotPublish`; that path repeats only the frozen publish
call, never the fetch or quota charge, and can receive `already_applied`.
Prepared values contain the bounded canonical game set and must stay inside
the worker boundary rather than logs or user DTOs. Database exceptions are
returned only as fixed phase/code values; upstream error text is never stored.

## SQL publish payload proposal

This is an adapter proposal for the database owner; it does not create or alter
SQL objects. The frozen `publish_owned_snapshot` call receives the complete
game set in `canonicalJson` and parses it inside its transaction; the runner's
small `p_result` never carries the array. The following row shape describes the
bounded records that the database validates after that parse:

```text
app_id                       text       -- validated decimal string
playtime_minutes             integer    -- nullable, null means unknown
name                         text       -- display hint/stub only
name_source                  text       -- steam.name | catalog_stub
last_played_epoch_seconds    bigint     -- nullable, already range/future checked
last_played_source           text       -- provenance enum from the normalizer
```

The proposed SQL sequence is:

1. Lock the account's `library_sync_state` row and reject stale generation or
   lease tokens. Stage one bounded recordset with a unique `app_id` check even
   though the TypeScript normalizer already checked it.
2. Convert `app_id` text to catalogue `steam_app_id bigint` only after the
   provider-range check; preserve the decimal value without signed-int32 casts.
   Upsert only minimal catalogue identities. Do not overwrite richer metadata
   with a stub or treat the Steam title as lender data.
3. Upsert `app.library_games` keyed by `(account_id, game_id)`, changing
   `playtime_minutes` only when the incoming value is known, valid, and distinct. A
   null/unknown playtime must not erase a previously known personal minute
   value; a new row may remain null. The integer bound is defended again by
   SQL constraints/casts. A provider decrease preserves the previous known value
   pending a deliberate correction policy and records sparse anomaly provenance.
   An older full snapshot must also preserve any newer personal observation from
   a pinned refresh; compare the observation times before updating facts.
4. Record valid activity evidence separately. A null/unknown last-played value
   must not erase a prior valid timestamp. Convert the validated epoch to the
   activity timestamp using a checked, parameterized expression; do not derive
   a current wall clock or invent a precise session interval.
5. Archive personal measurements for AppIDs absent from the complete snapshot,
   then delete only missing owned access. Preserve authored state, collection
   membership, history, and family access. Invalidate active commitments when a
   game has no remaining personal or family access, including its current playable
   pick, while retaining historical evidence. Family/lender rows are a separate
   relation and are never swept by this payload.
6. Update snapshot time/hash/count and the applied generation atomically with
   the ownership changes. Enqueue deduplicated shared enrichment through the M2
   queue/outbox boundary in the same transaction. A retry after a committed response
   loss returns the same applied generation/hash.

The adapter should use changed-only writes (`IS DISTINCT FROM`), retain the
normalizer's hash for idempotency/reconciliation, and keep raw provider bodies
outside the canonical relational payload with the documented TTL.

## Deterministic M2 SQL fixture harness

`lib/v2/import/steam-owned-10k-fixture.ts` builds a fixed 10,000-game provider
body and runs that body through `normalizeSteamOwnedSnapshot`; it does not hand
write a canonical JSON copy. The fixture is 839,394 provider bytes and
1,737,832 canonical UTF-8 bytes, with content hash
`5cac4a392b56f5b94ea48313280b0eedb39a40c5bf5a5277c612fde87780f68c`. It
includes the uint32 AppID edge, explicit zero/unknown minutes, catalog stubs,
and every timestamp provenance branch. The fixed observation anchor is
historical metadata only and is excluded from the canonical text and hash.
The SQL fixture runner replaces that provenance timestamp with its injected
claim/receipt clock before publication, so a local database's current clock
never rejects the deterministic game evidence as future data.

`lib/v2/import/steam-owned-sql-harness.ts` is an opt-in adapter seam for an
isolated local SQL or `psql` test database. Its mapping core has no imported SQL
client, credential lookup, implicit connection, queue polling, or ordinary-test
side effect. A caller supplies `M2SqlInvoker` (or explicitly constructs the
bounded local `psql` adapter), which receives one call object at a time and
binds these exact positional values from the frozen M2 contract:

| Function | Positional values |
|---|---|
| `ops.claim_job` | `p_lane`, `p_visibility_seconds` |
| `ops.publish_owned_snapshot` | `p_job_id`, `p_lease_token`, `p_result`, `p_canonical_json`, `p_content_hash`, `p_body_observed_at`, `p_message_id` |
| `ops.retry_job` | `p_job_id`, `p_lease_token`, `p_error_code`, `p_error_detail`, `p_provider_retry_at`, `p_retry_policy`, `p_message_id` |

`claimOneM2OwnedSnapshot` makes exactly one claim call and maps only a claimed
`owned_snapshot` row. It rejects catalogue rows, malformed identities, and
Steam IDs outside the signed PostgreSQL `bigint` range; it never discards an
unrelated shared-lane job. `runSteamOwned10kFixtureAgainstM2Sql` then injects
the actual fixture snapshot into the orchestrator. It supplies no live
transport, so a real-mode claim is refused without network access.

The adapter requires SQL publish rows to return `result` as `applied`,
`already_applied`, or `stale`, along with the frozen counters and hash/count
columns. Draft rows using `invalid` or `failed` as the protocol result are
rejected and become a sanitized worker database error; terminal job status is a
separate database field. `assertM2PublishRowForFixture` checks the observed
count and exact digest and can require all changed counters to be zero for a
second identical publish. `resumeM2SqlPreparedPublish` repeats only the
prepared publish call after a lost response, preserving the original canonical
text/hash and never refetching or charging quota. An `already_applied` replay
must return the exact stored summary, including the original changed counters;
zero changed counters are reserved for a distinct new job whose input produces
a no-op.

The SQL row parser preserves nullable `account_id`, `generation`,
`applied_generation`, `snapshot_hash`, and `observed_count` fields on stale or
private/invalid terminal rows. A complete `applied` or `already_applied` row
must still contain the expected 32-byte hash and 10,000-game count when the
runner validates it.

For an isolated local server, construct `createPsqlM2SqlInvoker` with explicit
coordinates such as `/tmp/vaultshuffle-pg17/bin/psql`, the private socket, port,
user, disposable database name, `workerRole: "vault_worker"`, and an explicit
`fixtureMode: true`, then pass it to `runSteamOwned10kFixtureAgainstM2Sql`.
Every RPC runs in one bounded UTC transaction, sets the transaction-local
fixture guard, and assumes the supplied worker role; the explicitly supplied login must already be authorized to assume that role.
The fixture does not grant or revoke cluster memberships. The helper uses one
bounded psql process per RPC, sends the statement through stdin, disables shell
execution, quotes every value as a typed PostgreSQL literal, and returns only
parsed JSON rows. Declared PostgreSQL `bigint` result fields are cast to decimal
text before JSON encoding, preserving SteamID64 and generation precision. It
does not inherit credential environment variables or log stderr.

Coordinator completed the final local SQL rehearsal on 9 September 2026 in
fresh disposable `vaultshuffle_m2_import_gate`, replaying immutable M1 SHA-256
`54fe0a7defd029e91568b78d51393670ac7ca6edcf915919670c7f64c2476389` and M2
`20260907163356_m2_jobs_quota_publish.sql`, SHA-256
`f09d7ca900f3cdaaee81eff0f507adc5869865f16eb7f340eeb1729223bc5aba`.
The durable integration passed using the explicit isolated local admin login
and effective `vault_worker` per RPC, transaction-local fixture guard and UTC.
No persistent cluster role grants were made. Initial 10k publish RPC wall time
was **644.804 ms**, below the five-second gate. This supersedes the earlier
SHA669 rehearsal and its job-timestamp interval, which was not commit latency.

The real test validates first-commit response loss and exact nonzero stored
summary replay without refetching; a new identical job preserves library and
activity `xmin` fingerprints as well as zero change counters; known and unknown
minute rows retire and reacquire correctly. Private, invalid, stale and deferred
retry outcomes also pass. Logs:
`/tmp/vaultshuffle-m2-import-gate-{rebuild,integration}.log`.
Cleanup verified zero fixture accounts/jobs/library/queue rows and providers
disabled. The disposable database retains its 10k shared catalogue/outbox rows;
use a fresh replay for another integration run. This is synthetic data only.

Scripted invoker unit tests check argument order and error handling without
network access. The actual PostgreSQL integration remains explicitly opt-in,
separate from the default zero-network suite. Deployment still requires the
separate least-privilege worker login setup; the local effective-role test does
not provision deployment credentials.

`lib/v2/import/steam-owned-sql-integration.integration.ts` is the durable
opt-in test for that seam. It never creates, drops, or recreates a database.
The caller must first prepare a disposable database by replaying the intended
M1 and M2 migrations, then provide every connection coordinate explicitly:

```sh
VAULTSHUFFLE_M2_IMPORT_INTEGRATION=1 \
VAULTSHUFFLE_M2_IMPORT_ALLOW_MUTATION=1 \
VAULTSHUFFLE_M2_PSQL_PATH=/absolute/path/to/psql \
VAULTSHUFFLE_M2_PSQL_HOST=/absolute/path/to/socket \
VAULTSHUFFLE_M2_PSQL_PORT=55432 \
VAULTSHUFFLE_M2_PSQL_USER=vault_worker_login \
VAULTSHUFFLE_M2_ADMIN_USER=isolated_local_admin \
VAULTSHUFFLE_M2_PSQL_DATABASE=vaultshuffle_m2_import_rehearsal \
VAULTSHUFFLE_M2_WORKER_ROLE=vault_worker \
node --experimental-strip-types --test \
  lib/v2/import/steam-owned-sql-integration.integration.ts
```

The test uses the admin connection only for its own fixture account, job
seeding, bounded evidence queries, and cleanup; it uses the worker connection
for every claim, publish, and retry RPC. On a local cluster where the worker
role is `NOLOGIN`, an explicitly supplied isolated admin may set
`vault_worker` transaction-locally. Persistent cluster-wide role grants are
not part of this test. The test verifies the M2 migration file's SHA-256 before
mutating the database and fails closed if it differs from the recorded frozen
revision.

## Tests

`lib/v2/import/steam-owned-snapshot.test.ts`,
`lib/v2/import/steam-owned-fetch.test.ts`, and
`lib/v2/import/steam-owned-job-orchestrator.test.ts`,
`lib/v2/import/steam-owned-10k-fixture.test.ts`, and
`lib/v2/import/steam-owned-sql-harness.test.ts` are zero-network adversarial
suites.
Together they cover explicit zero/private/unknown semantics, AppID
signed-boundary and overflow cases, SQL integer minute bounds, timestamp
range/anchor/skew rules, malformed names, contradictory provider markers,
whole-response rejection for duplicate/count/malformed rows, 1,001 and
10,000-game fixtures, input/canonical byte caps, fatal UTF-8 decoding, direct
bigint rejection, stable ordering/hash behavior, fixed full-scope request
parameters, SQL-compatible SteamID validation, redirect refusal, bounded
stream reads, truncation, HTTP errors, numeric and HTTP-date retry metadata
(including past, obsolete asctime/GMT, malformed, overflow, and deferred
over-range values), timeout
and cancellation (including abort-ignoring injected operations), and no-retry
behavior. The orchestrator suite also covers explicit fixture/live transport
selection, claim identity/time fences, terminal/retry routing, atomic queue
settlement, sanitized DB failures, prepared publish replay, and no-refetch
response-loss recovery. The SQL harness suite additionally checks exact M2
claim/publish/retry positional arguments, count/hash verification, no-op change
counters, private/invalid/deferred routing, draft result rejection, and
fetch-once response-loss replay.

Run it with:

```sh
node --experimental-strip-types --test lib/v2/import/*.test.ts
```
