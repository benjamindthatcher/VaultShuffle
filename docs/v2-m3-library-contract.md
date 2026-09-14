# M3-F library, family and history transform contract

This document records the pure transform boundary for the M3-F library domain.
It is paired with `docs/v2-claude-domain-transforms.md` and the physical
M1/M3 contract. The transform consumes exact `string | null` COPY cells and
returns bounded, deterministic records. It performs no source query, target
write, wall-clock read, remote access, or credential operation.

## Shared run and identity maps

Every input has one explicit `{ runId, snapshotHash }`. Source row run
annotations, the account map, the game map, intermediate library facts, and
all outputs must carry the same snapshot hash. A mixed run fails with a stable
redacted diagnostic.

The catalogue worker owns the game map. The library worker consumes this exact
shape:

```ts
type GameMapTargetRecord = {
  legacy_app_id: string;
  game_id: number;
  source_kind: "catalog_games" | "stub";
  source_snapshot_hash: string;
};

type GameMap = {
  run_identity: { run_id: string; snapshot_hash: string };
  entries: readonly GameMapTargetRecord[];
};
```

AppIDs remain canonical source text and are checked against 1..4294967295.
The map rejects duplicate AppIDs, duplicate target IDs, invalid source kinds,
foreign hashes, malformed target IDs, and overlarge maps. `lookup` throws for
a missing identity; `hasTarget` proves that a banked target ID belongs to the
same map.

The library transform emits `migration.library_row_map` records:

```ts
type LibraryRowMapRecord = {
  legacy_id: string;
  account_id: number;
  game_id: number;
  steam_appid: string;
  source_snapshot_hash: string;
};
```

`legacy_id` is the source `user_games.id`, `account_id` is resolved through
the same-run account map, and `game_id` is resolved through the game map.
`(account_id, game_id)` and `(account_id, steam_appid)` are unique within one
batch. Downstream transforms may resolve a nullable legacy UUID through this
map only after validating its account, game, AppID/map agreement, and snapshot
hash. A missing row remains a missing row; no game identity is invented.

## `user_games` fan-out

`transformLibraryBatch` preserves one source row in the row map and routes its
facts as follows.

* An owned personal row becomes one `app.library_games` row. Exact observed
  minutes remain `NULL` when the source is `NULL`; they are never made zero.
  Legacy decimal hours are retained separately and compared with the exact
  import formula `Math.round(((observed_playtime_minutes ?? 0) / 60) * 10) /
  10`. Disagreement is an unresolved measurement with `authorship: "unknown"`.
* Family access never contributes personal playtime. A family row emits a
  `FamilyAccessCandidate` with lender identity status, provenance, ownership,
  source observation time, and the same-run hash. A verified
  `family_verified_at` is `verified`; a null verification time is `inferred`
  and uses the source row's `updated_at` as the manifest-defined observation
  fallback. No wall-clock value is generated.
* A malformed or missing lender is retained as orphan evidence and cannot
  create a member or confer access. An all-zero 17-digit lender is malformed,
  not a valid Steam identity. `ownership = 'Wishlist'` on a family candidate is
  a distinct case (below): a resolvable lender never converts it to active
  access.
* A personal wishlist row becomes a retired measurement with the last known
  personal/observed values, plus `legacy_ownership` carrying the verbatim
  source `ownership` literal. Root's 11 September correction: `Wishlist` is
  not proof a row was never owned (`lib/steam-import-jobs.ts:190-221` demotes
  a previously-Owned row absent from the latest Steam response), so the
  transform preserves the literal rather than asserting either "never owned"
  or "was owned". `access_lost_at` stays `NULL` (no source instant records a
  removal for a row that carries no removal timestamp of its own) and
  `loss_reason` stays `'unknown'` -- never `'wishlist'`, since origin and
  reason are different facts. `database/v2/proposals/
  m3_legacy_preservation_followup.sql` (unapplied; root's to review) is the
  paired minimal schema change: `access_lost_at` becomes nullable, and a
  NULL-safe CHECK allows that null only for `loss_reason = 'unknown'` with
  `legacy_ownership = 'Wishlist'` exactly. A legacy `'Owned'` label, an
  unlabelled row and every runtime `loss_reason` still require a real
  instant, and the `now()` default is untouched. The `legacy_ownership is
  not null` conjunct is load-bearing rather than redundant: a CHECK passes
  on UNKNOWN as well as on TRUE, so comparing a nullable column with `=`
  alone would accept exactly the unlabelled row the constraint exists to
  refuse.
* Authored state fields populate sparse `app.game_state` only when the target
  disjunction is satisfied. Derived completion percentage never becomes
  `manual_progress`. Whitespace-only notes are counted and become `NULL`. This
  is unconditional on access channel: a family-sourced row's engaged state
  (a note, a Completed/Slept status) survives here the same as an owned row's.
  Legacy `completion_suggestion_dismissed_playtime` is exact decimal hours,
  matching its writer's direct use of `game.hours_played`. It is multiplied by
  60 with exact decimal arithmetic before reaching the destination's integer
  minutes. A non-integral minute, negative value, or int32 overflow fails
  closed; no rounding or clamping occurs. The original exact hours text is
  also retained independently as `completion_dismissed_hours_raw` in
  `migration.legacy_library_evidence.evidence`.
* Activity rows (`app.game_activity`) source `observed_at` (the receipt time)
  from `recency_evidence_at`, and `last_played_at` from `last_observed_played_at`
  -- never the other way, and never the raw legacy `last_played_at` column
  directly. Every reviewed live writer (`upsert_user_steam_games`,
  `apply_steam_recent_window`, `refresh_pinned_steam_playtime`) sets
  `recency_evidence_at` exactly when it sets or preserves `recency_source`,
  including the `steam_recent_window` case where `last_observed_played_at`
  stays null or stale on purpose. That is a writer pattern, not a
  source-schema guarantee -- no source CHECK ties the columns together -- so a
  row whose fields do not fit it (receipt time absent with other recency
  evidence present, receipt time present with no kind, or a receipt time and
  kind with neither a minutes nor a last-played value to satisfy the M1
  disjunction) is never guessed at; it is withheld into `recency_exceptions`
  (full raw evidence, never loaded) and blocks final load/commit.
* The two raw legacy play instants are two facts. `app.game_activity.
  last_played_at` takes `last_observed_played_at`; whenever the raw legacy
  `last_played_at` is a distinct fact -- a different instant in either
  direction, or a value with no observed counterpart -- it is kept in the
  proposal's new nullable `app.game_activity.legacy_last_played_at`. Neither
  is substituted for the other, and no ordering between them is asserted or
  enforced: an inverted pair is stored as found. `migration.
  legacy_library_evidence.evidence` still carries both for reconciliation,
  but it is `staging-30d-post-cutover` and is never the only copy (root's
  acceptance review: the previous revision let the divergent reading expire
  with that staging table).
* A plain minutes baseline with zero recency evidence is not fabricated an
  observation time. The accounting conflict names the durable column that
  actually already holds the count for that row -- `app.library_games.
  playtime_minutes` for an owned row, `app.retired_library_games.
  last_personal_minutes` for a wishlist one -- as two separate conflict
  classes, since one class would report a single batch-wide destination for
  rows that reached two different tables.
* A family-access row's measurement is never assigned to the borrowing
  account. It has no durable personal destination at all (both personal
  tables are owned/retired-personal only, and `library_legacy_measurements`
  records a reproducibility discrepancy rather than a bare baseline), and the
  source never records whose play a family row's reading describes. Minutes
  or recency evidence on such a row is withheld into `recency_exceptions`
  with its exact values -- never written to `app.game_activity` under the
  borrower's `account_id`, and never dropped as redundant.
* Every withheld exception also gets a bounded, redacted aggregate record in
  `migration.conflict_report` with `status = "unresolved"`, one class per
  reason, so the later loader's pre-commit gate can see the condition without
  reading a raw value.
* Every source row has bounded raw evidence. Opaque `date_added` text is never
  parsed as a date. Source values that exceed every owned evidence bound fail
  closed instead of being truncated.

The transform also returns complete `authoritative_facts` for the stale-state
reconciliation hand-off. Each fact contains all comparison timestamps,
family provenance, the converted integer-minute dismissal baseline, and
`source_snapshot_hash`. The source-hours spelling remains separate in the
legacy evidence record.

## Stale `user_game_state`

`transformLegacyGameState` writes only the bounded audit and explicitly
promoted sparse evidence. It cannot produce `app.game_state` or
`app.game_activity`. Before comparison it validates every banked authoritative
fact: target account membership, canonical AppID, same-run hash, exact cached
timestamp structure, exact decimal text, and nullable string shape.

The source smallint code books are not decoded. Values in the reviewed source
domains (previous status 1/2 and recency 1/2/3) are preserved as opaque stale
evidence in `app.game_state_legacy_measurements`; interpreting them is not
required because they never become active state or activity authority. Values
outside those source domains fail as invalid enums. A stale row is promoted
only when it is an orphan, disagrees with an authoritative fact, carries
unresolved code/provenance, or contains a source-hours dismissal baseline that
does not convert to an integral minute. Exact source hours are compared with
the authoritative fact only after conversion to minutes, so stale evidence
cannot replace or falsely disagree with authoritative state because of units. An
all-NULL conflict remains reconciliation-only because the sparse destination
requires one raw value.

## Family members and access

`transformFamilyBatch` assigns deterministic member IDs by `(account_id,
steam_id)`, preserves every member and candidate array, records the five-member
cap as a load conflict without dropping rows, and retains `library_seen` and
`games_imported` without clamping. `legacy_games_imported` is an independent
historical counter and is not claimed to equal the current resolved-access
count; a disagreement rewrites neither value. Display names use the target trim rule;
avatar/profile URLs preserve exact text, including whitespace, subject only to
their length bounds. Overlength compact fields are null in the compact record
and kept in bounded JSON evidence. Evidence over its JSONB bound fails closed.

The family transform validates the library candidate hand-off before sorting:
source UUIDs, account ownership, target game/AppID agreement, lender status and
positive Steam identity, provenance, timestamp scalar integrity, ownership,
and same-run hash. A resolved lender produces `app.family_game_access`; a
missing lender row produces `app.family_access_orphans` and staging evidence
with `confers_access = false`. Candidate arrays alone never become access.

A candidate with `ownership = 'Wishlist'` never produces active
`app.family_game_access`, even when its lender resolves to a live
`app.family_members` row. `supabase/migrations/20260901193000_
share_a_family_library.sql:237-280` (`remove_user_family_member_games`)
proves this is a supported source tombstone written on family-member removal
for an engaged row, not an unresolved combination: it rewrites the row to
`ownership = 'Wishlist'` while leaving `access_source = 'family'` and
`family_owner_steam_id` intact (the lender is frequently still a member --
only this one game's access ended). It is retained in
`app.family_access_orphans` with `disposition = 'retired'` (the proposal's new
literal, distinct from `'quarantine'`, which means the lender identity itself
could not be resolved) and `confers_access = false`; lender minutes are never
converted to a personal measurement, since `app.family_game_access` carries no
minutes at all and this row never reaches `app.library_games` or
`app.retired_library_games`.

## Daily, completion and purge history

Daily snapshots remain civil dates and cumulative totals. The transform copies
`total_minutes` and `games_with_playtime` exactly, never differences totals or
repairs decreases; a decrease is a conflict.

Each completion UUID enters exactly one of resolved completion history,
unknown completion history, or `completion_ordering_exceptions` -- never more
than one, and every source event lands in exactly one. Resolution order is
the tenant-scoped library row map, then the game map by AppID. Null or
unresolved identity remains unknown history with original nullable
identifiers. Actor, origin surface, exact raw metric text, and bounded metric
provenance survive. Finite malformed hours fail as invalid decimal;
`NaN`/`Infinity` are retained as non-finite raw evidence; negative hours are
retained as raw evidence and excluded from the constrained nonnegative numeric
column. No value is rounded or converted to minutes.

An event with `undone_at < occurred_at` never reaches resolved or unknown
history, and never reaches `completion_event_registry`: both destinations'
ordering CHECK stays untouched (a real runtime invariant, not weakened for
this case), so the event is withheld into `completion_ordering_exceptions`
instead, carrying the complete exact facts (full identity, both raw
timestamps, metrics) that the redacted `conflicts` stream cannot hold. The
9 September read-only audit (`database/v2/source-conflicts-audit-20260909
.json`, `completions.undo_before_claim: 0` of 13,157) found none in the
snapshot it read; that is a separate HTTP-paginated read, not the real export
snapshot, so a nonempty result here at the real export still blocks final
load/commit rather than being waved through as a proven-absent case.

Purge reviews remain authored decision history and never generate completion
events. For `action = complete`, active, undone-only and eventless populations
are counted separately. Existing completion events remain authoritative, an
undone event stays undone, and eventless review history is exposed as legacy
history rather than current completion state.
Equal-time decisions sort by the full durable tuple, with the archive's source
UUID as a final tie-breaker, so output is independent of input order.

## Failure and physical gates

Public transform failures carry only a stable code, relation, field and count;
they never include UUIDs, Steam IDs, notes, server text, timestamps or metric
values. Working sets are bounded by explicit row limits and output order is
deterministic.

Root's 11 September follow-up (`docs/v2-m3-preservation-followup-batch.md`)
and its acceptance review (`docs/v2-m3-preservation-final-review.md`) closed
the wishlist-retirement, activity-observation and divergent-play-fact gaps
this section used to describe as open loader decisions. `database/v2/
supabase/migrations/20260911234500_m3_legacy_preservation_followup.sql`
(applied by root on 12 September) supplies the schema change: a nullable `access_lost_at` under a
NULL-safe CHECK, `app.retired_library_games.legacy_ownership`,
`app.game_activity.legacy_last_played_at`, and a `'retired'` disposition
literal on both orphan relations. Each constraint it replaces is matched by
exact frozen name and exact frozen definition and raises on drift rather than
dropping whatever a text search finds. All of it is additive, on relations
already registered in `ops.data_retention_registry` as
`durable-account-lifetime` / `account_export` with an `account_id` cascade, so
the newly stored facts inherit deletion and export rather than needing a
registry change.

Two exception streams remain explicit gates:
`recency_exceptions` (a recency-field combination no reviewed writer explains,
or a family-access measurement with no durable personal destination) and
`completion_ordering_exceptions` (an inverted completion clock). Both are
non-empty-blocks-load conditions. The verified real snapshot contains three
family-access recency measurements whose subject cannot be attributed safely;
completion ordering is empty. Both are visible to a pre-commit
gate through their redacted `migration.conflict_report` counterparts. Remote
source authentication, remote TLS, real snapshot parity, and target apply
remain outside this pure batch.
