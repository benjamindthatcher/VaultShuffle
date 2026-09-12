# M3 preservation follow-up checkpoint

11 September 2026. Implements [the preservation follow-up
batch](v2-m3-preservation-followup-batch.md) and root's [acceptance
review](v2-m3-preservation-final-review.md) of the first return, which
together corrected and superseded parts of [the legacy gap
review](v2-m3-legacy-gap-review.md) (see the notice now at the top of that
document). The three acceptance blockers root found -- a loss-time exception
wider than authorized, distinct recency facts preserved only in expiring
staging, and a baseline suppression claiming a destination the row never
reaches -- are addressed below and marked **(acceptance review)** where they
changed what the first return did. Scope: `lib/v2/migration/transform/library*`,
`family*`, `history*` and their tests, the paired contract
(`docs/v2-m3-library-contract.md`), and one new local SQL proposal with a
focused real-PG gate. No applied migration, generated manifest/index,
catalogue/M3-G file, package config, or execution ledger was touched. No
remote query, target apply, auth mutation, commit, or deployment occurred.

## What changed and why

### 1. Legacy retirement (`app.retired_library_games`)

Root's correction: `ownership = 'Wishlist'` is not proof a row was never
owned (`lib/steam-import-jobs.ts:190-221` demotes a previously-Owned row;
`supabase/migrations/20260901193000_share_a_family_library.sql:237-280`
preserves an engaged family row the same way). The transform
(`lib/v2/migration/transform/library.ts`) now emits `legacy_ownership`, the
verbatim source `ownership` literal, in place of the invented `retired_origin`
field. `loss_reason` stays `'unknown'` and still has no `'wishlist'` literal
by design: origin (what the row was) and reason (why it left) stay separate
columns.

`database/v2/proposals/m3_legacy_preservation_followup.sql` (**unapplied**;
root's to review) is the paired minimal schema change: `access_lost_at`
becomes nullable, and a new NULL-safe CHECK
(`retired_library_games_null_loss_instant_requires_legacy_label`) allows that
null only when `loss_reason = 'unknown'` **and** the new `legacy_ownership`
column is exactly `'Wishlist'`.

**(acceptance review)** The first return's CHECK accepted any non-null
`legacy_ownership`, which also admitted a legacy `'Owned'` label -- wider than
the binding batch authorized. It now names the literal. NULL-safety is
explicit rather than incidental, because a CHECK passes on UNKNOWN as well as
on TRUE: `loss_reason` is NOT NULL so `loss_reason = 'unknown'` is always a
real boolean, and the `legacy_ownership is not null` conjunct forces the
null-label case to FALSE instead of UNKNOWN (`FALSE AND anything` is FALSE in
three-valued logic). Without it, `access_lost_at is not null or (TRUE and
UNKNOWN)` would evaluate to UNKNOWN and admit exactly the unlabelled null loss
instant the constraint exists to refuse. A normal runtime access loss
(`'complete_snapshot'`/`'manual'`) still requires a real `access_lost_at` and
the `now()` default is untouched, all proven by
`library-constraints.integration.ts` against real PostgreSQL.

### 2. Family retirement (`app.family_access_orphans`)

A real bug, not just a documentation gap: `lib/v2/migration/transform/
family.ts` previously granted active `app.family_game_access` to ANY
candidate whose lender resolved to a live `app.family_members` row,
regardless of `candidate.ownership`. `remove_user_family_member_games`
proves a family-tombstone row (`ownership = 'Wishlist'`,
`access_source = 'family'`, lender identity left intact) is common precisely
because the lender is *usually still a member* -- only that one game's access
ended, not the whole relationship -- so this bug would have silently restored
access the source explicitly revoked.

Fixed: a candidate with `ownership = 'Wishlist'` never reaches
`app.family_game_access`, regardless of lender resolution. It is retained in
`app.family_access_orphans` with a new `disposition = 'retired'` literal
(distinct from `'quarantine'`, which means the lender identity itself could
not be resolved -- conflating the two would misreport a deliberate,
source-recorded revocation as an identity-resolution failure). The
`accessCountByMember` recompute (used to validate the legacy
`games_imported` counter) is corrected as a side effect: it no longer counts
these retired candidates as active access either.

The proposal SQL widens both `app.family_access_orphans.disposition` and the
paired staging copy `migration.legacy_family_access_orphans.disposition` to
add `'retired'` (both needed it; the first PG gate run caught the staging
table's CHECK still refusing the literal after only the durable table was
widened).

**(acceptance review)** Both replacements now match the exact frozen
constraint name **and** the exact frozen `pg_get_constraintdef` text, and
`raise exception 'drift: ...'` if either differs, instead of the first
return's `ilike '%disposition%'`/`ilike '%quarantine%'` text search, which
would have silently dropped some other later constraint that happened to
mention either word. The gate proves the guard fires: it re-runs the
proposal's own `DO` blocks against the already-widened cluster and requires
`P0001` with a `drift:` message.

### 3. Recency (`app.game_activity`)

Root's correction: the prior review's claim that `recency_evidence_at` is
null exactly when no other recency field exists was an inference from the
writers it read, not a schema-enforced guarantee, and it missed a later
redefinition of the import writer
(`supabase/migrations/20260831175217_add_steam_playtime_refresh.sql`) and a
third writer (`refresh_pinned_steam_playtime`). It also missed that the
current code already sources `last_played_at` (target) from the raw legacy
`last_played_at` column, not `last_observed_played_at`, and the prior
review's suggested "fidelity improvement" would have discarded whichever
field it didn't pick.

Fixed:

* `observed_at` (the receipt time) sources from `recency_evidence_at`,
  never `last_observed_played_at`. `last_played_at` (target) sources from
  `last_observed_played_at`, never the raw legacy column. Root's ownership
  correction applies here too: this is now a settled mapping, not a "which do
  we discard" choice -- both raw facts survive (below).
* Any field combination this review's evidence does not explain -- a receipt
  time absent while other recency evidence exists, a receipt time with no
  kind, or a receipt time and kind with nothing to satisfy the M1 disjunction
  -- is withheld into a new `recency_exceptions` array (full raw evidence,
  same-run identity) instead of being guessed at. Nonempty blocks final load.
* **(acceptance review)** The two raw legacy play instants are two facts, and
  the divergent one no longer expires. The first return kept it only in
  `migration.legacy_library_evidence.evidence`, whose registered retention
  class is `staging-30d-post-cutover`, while marking the row otherwise
  loadable. The proposal now adds a nullable
  `app.game_activity.legacy_last_played_at`, written whenever the raw legacy
  `last_played_at` is a distinct fact: a different instant **in either
  direction**, or a raw value with no observed counterpart. Neither timestamp
  is ever substituted for the other, and no ordering between them is asserted
  or enforced -- the reviewed writers only advance `last_observed_played_at`
  at or after the raw column, but that is a writer pattern, not a
  source-schema guarantee, so an inverted pair is stored as found. The
  staging copy is kept for reconciliation but is no longer the only copy.
* **(acceptance review)** Baseline suppression now names the destination the
  row actually reaches. A plain minutes baseline with zero recency evidence is
  still not fabricated an observation time, but the accounting conflict is
  split by destination -- `library_activity_baseline_only_suppressed` for an
  owned row (`app.library_games.playtime_minutes`) and
  `library_activity_baseline_only_suppressed_retired` for a personal wishlist
  row (`app.retired_library_games.last_personal_minutes`). Two classes rather
  than one because `ConflictCollector` keys on class/relation/column, so a
  single class would report one batch-wide destination for rows that reached
  two different tables.
* **(acceptance review)** A family-access row's measurement is never assigned
  to the borrowing account. The first return both claimed
  `app.library_games` for a family row's suppressed baseline (a table that row
  never enters) and, on the well-formed path, emitted an
  `app.game_activity` row under the borrower's `account_id` for a reading
  whose subject the source never records. A family row carrying minutes or
  recency evidence is now withheld into `recency_exceptions` with reason
  `family_access_measurement_unassignable`, carrying its exact values -- not
  written to any personal table and not dropped as redundant. The access fact
  itself still flows to `family.ts` unchanged.
* **(acceptance review)** Every withheld exception now also gets a bounded,
  redacted `migration.conflict_report` record with `status: "unresolved"`,
  one conflict class per reason, so the later loader's pre-commit gate can see
  a nonempty exception stream from the durable report alone. The decision text
  is prose and counts only -- no UUID, Steam identity, timestamp or metric
  value, asserted by both the unit suite and the PG gate.
* `interval_ended_at` is `null`, not `recency_evidence_at`: a receipt
  timestamp is not a play-session interval bound, and stuffing it there was
  reusing a field for something it does not mean.

Privacy and deletion for the newly stored facts were checked once rather than
assumed: `app.game_activity` and `app.retired_library_games` are already
registered in `ops.data_retention_registry` as `durable-account-lifetime`,
`holds_personal_data`, `account_fk_column = 'account_id'`, `deletion_mode
'cascade'`, `export_scope 'account_export'`. The new columns add no account
UUID, so `account_uuid_columns` stays `{}` and the registry's `de_identify`
rule is unaffected; no registry row changes. The gate proves the values are
actually present before the account delete and gone after it.

### 4. Inverted completion clocks (`app.completion_events` /
`app.unknown_completion_history`)

Not corrected -- root's classification (valid-schema, zero-observed per the
9 September audit, not proven impossible) and recommendation stood. A real
latent bug was fixed: the transform recorded the ordering conflict but still
pushed the malformed row into the array bound for the loader, so a real
occurrence would have hard-failed the whole relation's load with a raw
`23514` rather than degrading gracefully. `lib/v2/migration/transform/
history.ts` now withholds such a row into a new
`completion_ordering_exceptions` array (full raw facts, same-run identity)
and skips it entirely -- no catalogue-identity resolution, no
`completion_events`/`unknown_completion_history` row, no
`completion_event_registry` row, so it cannot dangle a reference or become an
accidental active completion. Every source event lands in exactly one of
three destinations (resolved, unknown, or exception); none of the four
constraints are relaxed. No new durable table: the 9 September audit
(0 of 13,157) does not by itself justify one, and a real occurrence at the
final export needs root review of the actual row(s), not a table built ahead
of evidence.

## Evidence

Owned-file strict TypeScript, same compiler options as the prior checkpoint:

```text
npx tsc -p .tsconfig.m3-library.tmp.json --pretty false
```

Result: **passed**. Lint (`npx eslint` over the seven touched/owned files):
**passed, no findings**.

Focused unit suite:

```text
node --experimental-strip-types --test \
  lib/v2/migration/transform/library.test.ts \
  lib/v2/migration/transform/library-state.test.ts \
  lib/v2/migration/transform/family.test.ts \
  lib/v2/migration/transform/history.test.ts
```

Result: **128 passed, 0 failed** (44 library, 21 library-state, 26 family, 37
history) -- up from 125 at the first return and 121 before this batch. The
three new/rewritten library cases are the acceptance-review ones: both raw
play readings surviving across unequal, inverted, one-null and equal pairs;
baseline suppression naming the real destination for owned, wishlist and
mixed batches; and a family row's measurement being withheld rather than
assigned or dropped, plus the exception/conflict accounting check.

Real-PG constraint gate, one fresh disposable PG17 cluster, immutable
M1+M2+M3 applied byte-for-byte followed by the new proposal:

```text
PGBIN=node_modules/.cache/vaultshuffle-pg17-20260910/bin
$PGBIN/initdb -D node_modules/.cache/vaultshuffle-m3-libfinal-20260911/data \
  -U vault_local_admin -A trust --encoding=UTF8 --locale=C
$PGBIN/pg_ctl -D node_modules/.cache/vaultshuffle-m3-libfinal-20260911/data \
  -o "-p 55495 -k /tmp/vs-m3-libfinal-20260911 -c listen_addresses=" \
  -l /tmp/vs-libfinal-server.log -w start
# vslib is granted superuser on this throwaway cluster only (M1 creates roles).
$PGBIN/createdb -O vslib vaultshuffle_m3_libfinal
$PGBIN/psql -v ON_ERROR_STOP=1 -f database/v2/supabase/migrations/20260906093036_m1_private_foundation.sql
$PGBIN/psql -v ON_ERROR_STOP=1 -f database/v2/supabase/migrations/20260907163356_m2_jobs_quota_publish.sql
$PGBIN/psql -v ON_ERROR_STOP=1 -f database/v2/supabase/migrations/20260910232654_m3_preservation_schema.sql
$PGBIN/psql -v ON_ERROR_STOP=1 -f database/v2/proposals/m3_legacy_preservation_followup.sql

VS_M3_LIB_PSQL=$PGBIN/psql \
VS_M3_LIB_PGHOST=/tmp/vs-m3-libfinal-20260911 \
VS_M3_LIB_PGPORT=55495 \
VS_M3_LIB_PGUSER=vslib \
VS_M3_LIB_PGDATABASE=vaultshuffle_m3_libfinal \
node --experimental-strip-types --test \
  lib/v2/migration/transform/library-constraints.integration.ts
```

Result: **27 passed, 0 failed** on the first run of this fresh cluster (up
from 26 at the first return and 25 before this batch). The M3 SQL applied is
verified byte-identical to the recorded checkpoint, SHA256
`605b72a3d9df1328ec27033c3420c1813a238f6e15bd8fc28f971cddaf30a24a`, before the
proposal is layered on top, and the two frozen `disposition` CHECK definitions
were read back from the applied schema and matched the proposal's expected
text before it ran. The cluster was stopped and the disposable data directory
removed after the run; no sibling cluster was touched.

Every earlier meaningful case was preserved, not replaced. New/rewritten cases
this run specifically proves, each by letting PostgreSQL reject or accept a
row rather than trusting the transform's own claim:

* A labelled legacy-Wishlist tombstone (`access_lost_at = NULL,
  loss_reason = 'unknown', legacy_ownership = 'Wishlist'`) is **accepted**.
* An unlabelled null loss instant (`legacy_ownership = NULL`) is **refused**,
  `23514` -- the NULL-safe CHECK does not accidentally pass it.
* A legacy `'Owned'` label with a null loss instant is **refused**, `23514` --
  the authorized legacy case is exactly Wishlist.
* An invalid label (`'wishlist'`, `'Borrowed'`) is **refused** by the column's
  own literal CHECK and can never reach the null-instant exception.
* A `'complete_snapshot'`/`'manual'` reason with a null instant is still
  **refused** even when labelled `'Wishlist'` -- normal runtime access loss is
  untouched, and a write naming no `access_lost_at` at all still receives a
  real `now()` instant.
* `'wishlist'` is still not a valid `loss_reason` literal -- **refused**.
* Re-running the proposal's own constraint-replacement `DO` blocks against the
  already-widened cluster **raises** `P0001` with a `drift:` message rather
  than dropping whatever it finds, and the installed definition is the exact
  widened four-literal CHECK.
* A resolvable-lender family tombstone (`ownership = 'Wishlist'`, a real
  `LENDER` that resolves to a live member) produces **zero** rows in
  `app.family_game_access` and **one** `disposition = 'retired'` row in
  `app.family_access_orphans`, with its `lender_steam_id` actually resolving
  -- proving this is not the pre-existing `'quarantine'` case.
* `app.family_game_access` holds **exactly one** active grant (the genuine
  ROW_FAMILY candidate), not two.
* Every `app.game_activity` row the transform emits **inserts cleanly**
  (no more provable/unprovable split); a synthetic combination with no
  receipt time is proven **absent** from the loadable set and present in
  `recency_exceptions`; a raw `NULL observed_at` is still **refused**,
  `23502`, proving the invariant this design now depends on is real.
* Both distinct raw play readings land durably in the direction each was
  found: a raw `last_played_at` **before** the observed one
  (2026-01-31 23:00 vs 2026-02-01) and an **inverted** one **after** it
  (2026-02-06 vs 2026-02-05) both round-trip into
  `app.game_activity.legacy_last_played_at` with the observed value still in
  `last_played_at`; a row with no raw reading keeps the new column **NULL**
  rather than repeating the observed one; and an inverted pair inserted
  directly is **accepted**, since no ordering CHECK was invented for it.
* A family row carrying 45 observed minutes produces **zero**
  `app.game_activity` rows under the borrowing account and **zero**
  `app.library_games` rows, with its exact minutes present in the
  `family_access_measurement_unassignable` exception instead.
* A personal wishlist row's suppressed baseline is physically where the
  accounting says: 15 minutes in
  `app.retired_library_games.last_personal_minutes`, **zero** rows for that
  (account, game) in `app.library_games`.
* Every withheld row across both exception streams is countable from
  `migration.conflict_report` alone, and **none** of those records is
  reported as anything but `unresolved`.
* An inverted completion clock is **absent** from `app.completion_events`,
  `app.unknown_completion_history`, and `app.completion_event_registry`, and
  **present** in `completion_ordering_exceptions` with both raw timestamps;
  a direct insert of the same shape into either destination is still
  **refused**, `23514`.
* Account deletion still removes every relation this domain writes, including
  the two new populations above and both new columns' stored values (asserted
  present before the delete), while catalogue identity survives.

## Remaining blockers

* `database/v2/proposals/m3_legacy_preservation_followup.sql` is a proposal
  only. It has not been applied to the target `vbjtbwelnhbbdfrqczyf` or any
  project with real data, and this batch is not authorized to apply it. Root
  reviews the exact diff and decides the migration/apply gate. It now makes
  four physical changes: a relaxed `NOT NULL` plus a new CHECK on
  `app.retired_library_games`, the new `legacy_ownership` column there, the
  new `app.game_activity.legacy_last_played_at` column, and the widened
  `'retired'` disposition literal on both orphan relations.
* `app.game_activity.legacy_last_played_at` is a preservation column, not a
  read path. Nothing in the application reads it, and `lib/recency.ts` keeps
  using the observed reading; if root wants the divergence surfaced to a user
  or to reconciliation, that is a later decision on top of the stored value.
* `recency_exceptions` and `completion_ordering_exceptions` are typed
  transform output, not database tables; nothing loads them. Their existence
  is now visible to a pre-commit gate through the redacted
  `migration.conflict_report` records described above, but the gate itself is
  a later milestone: the loader still has to treat a nonempty result from
  either as a hard final-load/commit blocker, and this batch did not touch
  loader code.
* Everything above is proven on synthetic fixtures against a local replay,
  not against the actual target or a real source export. Real snapshot parity, remote source auth/TLS, and target apply
  remain outside this batch, as before.
* The 9 September conflicts audit (0 of 13,157 inverted completion events)
  is a separate HTTP-paginated read, not the real export snapshot; per root's
  decision, the same check must be re-run inside the actual pre-cutover
  export as a go/no-go gate before concluding `completion_ordering_exceptions`
  will stay empty in practice.
