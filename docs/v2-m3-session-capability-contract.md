# M3-E session and capability transform contract

This contract describes the pure transform layer between a verified COPY
artifact and later M3 loading. It performs no SQL, source connection, provider
call, token lookup, or target write. The caller supplies one explicit run
identity and one explicit account identity map; all returned records carry the
same source snapshot hash.

## Run and account identity

`TransformRunIdentity` is:

```ts
{
  runId: string;
  snapshotHash: string; // exactly 32 bytes as 64 hexadecimal characters
  observedAt: string;   // labelled snapshot/cutover observation instant
}
```

The run id is bounded to 128 safe ASCII characters. The hash is compared as
decoded hexadecimal bytes. `observedAt` is parsed by the identity worker's
reviewed `parsePgTimestamptz` helper, retaining microsecond precision and
canonicalizing the run identity to UTC. No wall-clock value is used.

`AccountMap` contains the same run and entries with `legacyId`, positive target
`accountId`, `accountKind` (`manual` or `steam`), `identityVerified`, and
`lifecycleStatus` (`active`, `merged`, or `deleted`). A deleted entry may carry
an optional `tombstone` proof with the normalized merge id,
`sourceDeleted: true`, `verified: false`, and an allowed creation-time
meaning. UUID-shaped values are joined case-insensitively, while their
original source spelling is retained in migration records. Duplicate legacy or
target identities, per-entry run mismatches, malformed tombstone proofs, and
mixed snapshot hashes fail before a row is emitted.

The identity worker already returns `run_identity`, `accounts`,
`steam_profiles`, and `account_map` separately. `accountMapFromIdentityResult`
is the reviewed structural adapter that joins those outputs and accepts only a
caller-supplied `observedAt`. A verified Steam profile sets
`identityVerified`; a manual profile never does. The adapter checks that every
account has exactly one map entry and that each map hash equals the identity
run hash. A source map with `source_kind: "unknown"` is accepted only for an
identity result whose matching account is a deleted, unverified manual
tombstone with `source_deleted: true`, a valid merge id, and an allowed
creation-time meaning; the adapter copies that proof into the `AccountMapEntry`.
Live `app_accounts` mappings must use `source_kind: "app_accounts"`; arbitrary
active `unknown` mappings fail. A tombstone remains in the map for audit joins,
but `transformSessions` rejects any row whose owner lifecycle is deleted, so it
cannot authenticate a deleted source. Capability processing requires the
adapter proof before accepting a deleted map entry.

## Sessions

`transformSessions` accepts `sessions`-shaped rows (`id`, `userId`,
`tokenHash`, `createdAt`, `lastSeenAt`, `expiresAt`, optional `revokedAt`) and
`manual_profile_sessions`-shaped rows (`id`, `profileId`, the same time and
digest fields). It validates the complete union before numbering:

* `tokenHash` must be exactly 64 hexadecimal characters and is decoded to the
  exact 32-byte HMAC-SHA-256 value used by the legacy cookie reader. The value
  is not rehashed, rotated, included in errors, or copied into diagnostics. A
  duplicate decoded value, including case variants and cross-table values, is
  a private `session_digest_collision` failure.
* Source UUIDs are unique across both tables, and owner lookup uses the
  explicit account map. A verified row requires an active, verified Steam
  account. A manual row requires an active, unverified manual account. A
  profile link or reused Steam id cannot elevate a manual row.
* `expiresAt > createdAt` and `revokedAt >= createdAt` are checked using the
  shared exact microsecond parser. Source text is preserved; invalid ordering
  is a blocker rather than a repair.
* The sorted source union is keyed by normalized source UUID, source table, and
  target account id. Every row receives a contiguous bigint target id in that
  stable order. The original source id, owner account, kind, time fields and
  snapshot hash are retained in the private migration record.
* `manualDisposition` must be the fixed continuity value `migrate-cookie`.
  Manual rows are inserted into the same target relation with
  `sessionKind: "manual"`, their exact decoded digest, source profile owner,
  account, times, and snapshot hash. This preserves the legacy `vault_session`
  cookie across the cutover. The transform has no retirement disposition for
  `manual_profile_sessions`; a stale expiry policy would strand returning
  workspace logins. No purge or source mutation occurs.

The target `app.sessions` record uses `sessionKind: "verified_steam"` for the
verified source and `sessionKind: "manual"` for continuity-mode manual rows;
its `tokenDigest` is a typed loader value and must stay inside the private
transform path. Public errors contain only stable codes and bounded primitive
details. Default bounds are 100,000 account-map entries and 200,000 total
session rows; callers may lower them but may not raise them.

The legacy application contract is concrete: the browser cookie is named
`vault_session`; a value beginning with `manual.` selects
`manual_profile_sessions`, and the complete raw cookie value is passed to
`HMAC-SHA256(SESSION_SECRET, token)`. Manual cookies are issued for 365 days,
refreshed on a stale visit, and their database row refreshes `last_seen_at` and
`expires_at`; ordinary Steam cookies are issued for 30 days and select
`sessions`. `manual_profile_security_intents` is a different one-time
OpenID-flow token (10 minutes in the writer, bounded to 15 minutes by the
legacy table); it is not a session row, does not select the authentication
branch, and is outside this transform. Its pending rows can be expired and the
flow restarted without retiring the manual browser session. The flow's
short-lived callback cookie is `vault_profile_security`, separate from
`vault_session`. This distinction is why only security intents expire/restart
at freeze; long-lived manual sessions remain available for cookie continuity.

## Capabilities

`transformCapabilities` accepts a complete `app_accounts` capability row for
each active account-map entry and optional `app_users` profile rows for active,
verified Steam accounts. Proven deleted tombstones have no source capability
row and are omitted from compact output and evidence. Each source row passes
the five-cell tuple together:

```ts
{
  libraryVisible: boolean | null;
  playtimeVisible: boolean | null;
  lastPlayedVisible: boolean | null;
  checkedAt: string | null;
  gamesSeen: string | number | null;
}
```

COPY boolean forms `t`, `f`, `true`, and `false` are accepted and normalized;
counts use the shared exact integer parser and the target non-negative integer
domain. Missing active-account rows, duplicate rows, wrong account kinds,
invalid tuple cells, mixed row runs, and unverified/non-active profile owners
fail with stable code-only errors. A deleted map entry without the adapter's
explicit proof is invalid, and an account or profile capability row targeting a
proven deleted tombstone fails with `capability_deleted_tombstone_row`; the
transform never fabricates a tuple or capability evidence for that identity.

The account-side tuple is authoritative as one unit. Its three flags project
independently as `true -> visible` and `false` or `NULL -> unknown`; compact
status is `ok` only when at least one positive flag exists, otherwise
`unknown`. This phase never produces `hidden`, `private`, or `error` from the
legacy availability heuristics. Account `checkedAt` and `gamesSeen` remain
with the account-side flags in one evidence row.

Profile rows are evidence-only (`feedsCompactCapability: false`) and are
retained in the physical `app.account_capability_evidence` shape. A profile
without an account-side observation fails, as does a profile date when the
account-side date is absent. A profile date newer than the account tuple fails;
an equal-time tuple conflict (or an undated conflict) fails. An older or
undated profile that does not trigger those guards is retained without changing
the compact account projection. Every evidence row carries the source
precedence, raw five-cell tuple, projection status, source snapshot hash and
the explicitly labelled run `observedAt` as `capturedAt`.

Capability output is ordered by target account id and includes no arbitrary
legacy text. Default bounds are 100,000 accounts and 200,000 total capability
rows; callers may lower them only. The transform returns typed records for the
later loader; it does not publish them or report their private source ids.

## Current evidence boundary

The modules are pure and locally tested against independent synthetic source
rows. The accepted reader/exporter baseline remains separate. Remote source
authentication, remote TLS hostname/CA verification and real source data are
outside this batch and remain unproven until an authorized source run exists.
