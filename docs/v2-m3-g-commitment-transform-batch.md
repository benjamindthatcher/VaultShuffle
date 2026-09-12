# M3-G: collections, commitments and draw history

Coordinator assignment, 10 September 2026. The persistent database/review max
Luna owns new `lib/v2/migration/transform/collections*`, `commitments*`,
`draws*`, their tests, and `docs/v2-m3-commitment-{contract,checkpoint}.md`.
Session/capability corrections are locally accepted (40 combined identity/
scalar/session/capability tests passed); leave those modules stable. Physical
SQL remains final4 and requires no edits for this batch.

Implement the pure source-string transforms from the complete
`02-collections-and-vault.json` dispositions into the actual M1/M3 destinations
and mapping/staging records. Source inventory, plan sections 5.3, 13, 14, M3-B
rulings, and the latest physical contract govern. Coordinate map APIs with the
two current M3-F workers once, then work autonomously. Reuse exact scalars and
the common game map in `docs/v2-claude-domain-transforms.md`. The library worker
owns `library*`, `family*`, `history*`; the catalogue worker owns `games*`,
`catalogue*`. Do not edit or duplicate those implementations. A row pointing to
a legacy user-game UUID must join through the same-run library-row map and
validate tenant ownership, not resolve by row position or a global AppID guess.

Preserve collection public UUIDs, account, name/description, custom/smart kind,
versioned legacy rules/presets, timestamps and meaningful notes. Number internal
IDs deterministically before resolving children. Unique positions can retain
legal gaps; duplicate positions require the reviewed deterministic ordering
based on source semantics with original-order evidence retained, never dropped
members. Preserve references to unavailable games without fabricating active
ownership. Invalid/range-exceeding metadata fails with a private reconciliation
blocker, not trimming/truncation or guessed defaults.

Preserve scoped pin slots/timestamps and exact personal baseline provenance.
Decimal hours-to-minute conversions must be exact and range checked; use the
existing raw-evidence destination if integer minutes cannot represent a value,
and return an unresolved constraint case rather than rounding silently. Keep
indefinite snoozes NULL, explicit expiration instants and source provenance.
Current picks retain the actual game/draw linkage with explicit account/access
validation; preserve invalid/unavailable source commitment evidence separately
and follow an existing reviewed rule or return a concrete blocker. Do not
silently grant access or point an account at another account's draw/collection.

Preserve draw public IDs, source collection identity, game/AppID, occurred times,
selected genres, context and bounded finalist arrays with exact provider IDs.
Machine selection, served impression and user action remain distinct facts.
No invented exposure probability, negative preference or current model evidence.
Map draw-event children to the same account and deterministic draw ID. Keep
nullable historical game identifiers where supported without inventing a game.
Full event context is retained against the actual JSONB shape/bounds; field
names themselves can contain private content and must not enter diagnostics.
UI history's eventual latest100/90days cleanup is already specified by final4;
this transform does not run a purge or silently apply a moving time filter to
the source. Completion history belongs to M3-F's history worker, not this batch.

Require explicit same-run/snapshot identity on inputs and maps, bound working
sets and output sizes, and ensure deterministic canonical output under shuffled
input. Use source strings/NULL, exact integers/decimals and UTC microseconds;
no wall clock defaults or region offsets. Reuse safe PG array/JSON helpers by
coordinating with catalogue ownership; never parse JSON numbers through a float
and claim exact source parity. A pure JSONB size precheck must not claim the
PostgreSQL physical bound without later actual SQL validation.

Tests must prove cross-tenant/reused UUID refusal, duplicate/missing references,
same AppID across owners, stable collection/draw numbering and ordering, notes
and preset preservation, exact/overflow/unknown baselines, indefinite/expired
snoozes, unavailable commitments, orphan historical IDs, distinct serve/action
semantics, oversized/malformed arrays/JSON, mixed runs and redaction-safe errors.
Use independent expected values and meaningful disposable PG17 constraint
integration for these new outputs; existing sibling databases are read-only
evidence and must not be modified. Targeted strict TypeScript at repository
target, lint and complete owned tests must pass.

No source or remote queries, real export/target load, SQL/schema edits, package
changes, application/UI changes, provider activation, credential changes,
deployment, commits or production actions. Save a resumable checkpoint early;
finish/debug/validate the whole batch before returning, including exact changed
files, commands/results, assumptions, unmapped fields and concrete physical or
semantic blockers. Root reviews the completed gate. M3 remains incomplete
until real snapshot, all domain transforms, per-account parity and storage pass.
