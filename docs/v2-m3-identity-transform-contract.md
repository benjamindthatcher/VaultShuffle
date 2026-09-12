# M3-D identity transform contract

This contract covers the bounded, pure account identity phase. It consumes
verified PG17 COPY cells and produces deterministic records for
`app.accounts`, `app.steam_profiles`, and `migration.account_map`. It performs
no source query, target write, export, or publication. Sessions, capabilities,
library/game identities, collections, and game policy belong to later phases.

The implementation is [`lib/v2/migration/transform/scalars.ts`](../lib/v2/migration/transform/scalars.ts)
and [`lib/v2/migration/transform/accounts.ts`](../lib/v2/migration/transform/accounts.ts).
The public entry point is `transformIdentityBatch(input, { maxAccounts })`.
`input.runIdentity` must carry a validated `runId` and lower-case SHA-256
`snapshotHash`; optional project/database labels are carried only as manifest
metadata. `CopyRow` remains the cell boundary (`string | null`), and the
transform does not alter the reader.

## Scalar rules

`parsePgInteger` accepts signed decimal integer text and returns `bigint`, with
inclusive `bigint` bounds. `parsePgDecimal` accepts finite PG numeric text,
including a decimal point and exponent, and retains the original source text
beside an exact coefficient/scale representation. It rejects `NaN`, infinity,
malformed forms, excessive precision/scale, and failed bounds. No conversion
passes through `Number`.

`parsePgTimestamptz` accepts the PG17 UTC/fixed-offset forms used by the
exporter (`YYYY-MM-DD[ T]HH:MM:SS[.ffffff]` with `Z`, `UTC`, or a numeric
offset, including `+00` and `+00:00`). It returns an exact epoch-microsecond
`bigint`, a decimal text copy, and a canonical UTC rendering. NULL stays NULL.
Named geographic zones, missing zones, non-finite values, more than six
fractional digits, invalid offsets, and invalid dates fail with stable codes.
No `Date` object or geographic Ireland/Virginia offset is used. `parseCivilDate`
checks leap years independently and accepts only year `0001` through `9999`.

## Source union and numbering

The source rows follow the reviewed inventory exactly:

* `app_accounts.id`, `account_type`, `created_at`, `updated_at`, and
  `last_visited_at` form the account root. `updated_at` is parsed for source
  validity but is retired per the disposition; the target account has no
  corresponding mutation timestamp.
* `app_users.id` must match a Steam account root. Its `steam_id` is checked as
  a 17-digit decimal string and round-tripped through the signed target
  `bigint`; its display/avatar fields and profile timestamps become a verified
  `app.steam_profiles` record. `last_login_at` becomes
  `app.accounts.last_login_at` and remains independent from
  `last_visited_at -> last_seen_at`, including NULL.
* `manual_steam_profiles.id` must match a manual account root. Its public URL,
  two display names, avatar, Steam ID and profile timestamps become an
  unverified profile record. Manual profiles may share a Steam ID with one
  another or with a verified profile.
* `account_merges` is validated for the reviewed `promoted` and
  `merged_existing` shape and returned as private transform evidence for the
  later merge audit writer.

The complete account root union is built before IDs are assigned. Existing
roots sort by exact parsed `created_at` and canonical UUID, then receive
1-based target integer IDs. The same order drives accounts, profiles and maps;
input order cannot affect it. Both directions of `migration.account_map` are
unique in the returned records, and `source_snapshot_hash` is copied from the
explicit run identity. `mapped_at` is intentionally omitted from pure output
so the eventual loader can use the target default without fabricating a time.
Initial `library_revision` and `state_revision` are the agreed target defaults
`"0"`. A live root map row uses `source_kind = 'app_accounts'`; a synthetic
deleted-source tombstone uses `source_kind = 'unknown'` because it preserves a
UUID and merge evidence without asserting that an `app_accounts` snapshot row
exists.

The two measured profile-less manual roots remain account records without a
fabricated profile. Duplicate roots, duplicate/profile-kind conflicts,
unmatched profiles, an impossible account kind, a Steam root without
`app_users`, invalid UUID/Steam ID/timestamp/metadata, verified Steam
collisions, mixed run identity, and integer/count overflow all fail closed.
Metadata is retained verbatim when it satisfies the target bounds. Trimming
or truncation is never used to make nonempty source text fit; an overlong or
whitespace-only display value is a private blocker. Errors contain only stable
codes, relation/field names and counts, never source values.

## Deleted merge sources

The legacy merge function can remove a manual source account while retaining
an `account_merges` row. For a missing source, the transform requires a
separate `MergeSourceTombstoneEvidence` record with the exact merge/source/
target/Steam identity, `source_deleted = true`, provenance
`account_merge_source_deleted`, and a creation-time meaning. `merge_observed_at`
uses the explicit merge timestamp only as the synthetic tombstone row's
required `app.accounts.created_at`; the output carries that meaning and never
calls it the source account's creation instant. A separately evidenced
`source_account_created_at` may be supplied instead. Missing, mismatched,
unneeded, or unsupported evidence is a blocker.

Such a row is numbered in the same complete union, has `lifecycle_status =
'deleted'`, `account_kind = 'manual'` because `merged_existing` is the reviewed
manual-source path, no profile, NULL visit/login values, and explicit
`source_deleted: true` / `verified: false` evidence. Its map row preserves the
deleted source UUID with `source_kind = 'unknown'`; this records tombstone
provenance without inventing a live source row. The current coordinator audit
measured no required tombstones; that is evidence only and must be rerun for
the actual export.

The identity phase intentionally leaves three physical concerns to their
reviewed downstream writers: the source visibility tuple and profile-side
visibility evidence have no identity-row columns and are handled by the later
capability phase; `ops.account_merges.reason` and its durable tombstone audit
are handled by the later merge phase; and the target map's `mapped_at` is a
database bookkeeping default. Source `app_accounts.updated_at` has no M1/M3
account destination and is therefore validated then retired according to the
manifest. These are documented destination boundaries, not guessed fields or
coerced values.
