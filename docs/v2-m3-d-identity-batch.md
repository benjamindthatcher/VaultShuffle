# M3-D: exact scalar and account identity transforms

Coordinator assignment, 10 September 2026. Own new
`lib/v2/migration/transform/scalars*`, `transform/accounts*`, their tests,
`docs/v2-m3-identity-checkpoint.md` and a concise identity transform contract.
Keep the existing manifest/probe scope only for final destination-hash updates
when its sibling's SQL settles. Do not edit that SQL, the reader/exporter,
package files, root ledger or plan. No live/source/remote actions.

Implement the next pure layer from verified source strings to deterministic
account/profile/map records. Use the actual source inventory and reviewed
manifest; no field-name guessing. Consume row/cell types from the reader or a
small structural interface without changing its implementation. The reader is
under final correctness fixes by the separate export worker.

## Exact scalar helpers

Parse PostgreSQL integer and finite decimal strings exactly, with explicit
destination bounds and no Number-mediated bigint/decimal loss. Preserve source
text separately when it is evidence. Parse UTC timestamptz strings with up to
microsecond precision into exact comparable values; preserve NULL, reject
unsupported/nonfinite/ambiguous/out-of-range values with stable codes. Validate
civil dates independently, including leap years. No geographic offset for
Ireland→Virginia and no Date truncation of persisted instants. Scope helpers to
the actual PG17 export forms, documenting unsupported forms and fail-closed
behavior; do not build a general-purpose date/SQL library.

## Account identity phase

Inputs: explicit snapshot/run identity plus exact `app_accounts`, `app_users`,
`manual_steam_profiles` and required merge-source tombstone evidence. Root's
current audits are examples only, not immutable source counts. Inventory the
complete union before numbering; reject duplicate roots/profile kinds,
unmatched profiles, impossible account kinds, conflicting verified Steam IDs,
invalid IDs/timestamps or unproven tombstones. The two current manual accounts
without profiles must remain valid account rows with no fabricated profile.
Manual workspaces sharing a Steam ID are legal and must remain unverified;
verified identity uniqueness remains enforced separately.

Number existing account identities deterministically by exact `(created_at,
UUID)` as the manifest specifies. Required absent merge-source tombstones are
included before numbering with a documented deterministic placement that does
not invent a creation instant or confer verification; if the immutable target
requires an instant, require explicit supported source merge provenance and
record its distinct meaning rather than silently using now. Consult root if a
physical contract gap prevents this. `public_id` remains the original UUID,
mapping directions are unique, integer range overflow rejects, shuffled input
does not affect output and repeated runs yield identical semantic output.

Generate `app.accounts`, `app.steam_profiles` and `migration.account_map`
records against current M1/M3 columns, preserving login versus visit instants,
profile creation/update times and validated display metadata. No normalization
that drops nonempty text or truncates values to satisfy constraints. An
overlong/invalid value is a private reconciliation blocker with only stable
codes/counts in public diagnostics. Source Steam accounts stay verified, manual
profiles stay unverified, tombstones stay deleted and unverified. Initial
revisions use the actual agreed target defaults, never fabricated source facts.
Capabilities, sessions, collections, libraries, game identities and SQL loading
are explicitly later modules; do not invent their policies in this batch.

Keep memory bounded by an explicit configurable maximum account count (identity
maps necessarily retain account-sized data); do not allocate a full library.
No target write or private artifact publication is part of this pure batch.

## Tests and return

Use adversarial fixtures for all conflict classes, microsecond ordering within
one millisecond, equivalent UTC forms if supported, dates/leap boundaries,
large integers/decimals, manual shared Steam IDs, missing manual profiles,
verified collisions, shuffled deterministic numbering, deleted merge sources,
mixed run identity, bounds and sentinel-free diagnostics. Include property-like
permutations and source→target→canonical identity comparisons independent of
the transform implementation. Typecheck/targeted lint; no unnecessary provider
or application tests. Save exact file/API/test/remaining-gap evidence to the
checkpoint before interruption. No M3 completion claim.

Manifest local gate is accepted for continued integration on its returned hash:
118 tests passed and false/NULL visibility plus staging/durable evidence now
agree. Its SQL-derived index must still be compared to the actual replay
catalog; final-load remains blocked on real source checks. Do not treat the
current 1 unresolved column / 5 open relations as source-data parity.
