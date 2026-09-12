# M3-F legacy gap review: wishlist retirement, activity receipt time, undo ordering

11 September 2026. Bounded, read-only design review of the three physical gaps
raised in [the review batch](v2-m3-legacy-gap-review-batch.md) and evidenced in
[the library checkpoint](v2-m3-library-checkpoint.md) (constraint gate,
11 September) and [library contract](v2-m3-library-contract.md). No SQL, code,
or transform file was edited. All references are to files on disk in this
checkout at HEAD `b51dcd163a923bba0315dac125fa7d945690d4e9`; applied M3 SQL
(`20260910232654_m3_preservation_schema.sql`, SHA256
`605b72a3d9df1328ec27033c3420c1813a238f6e15bd8fc28f971cddaf30a24a`) was read
only, never edited.

> **Superseded in part, 11 September 2026.** Root reviewed this document and
> found two unsupported claims, which are corrected and implemented in
> [the preservation follow-up batch](v2-m3-preservation-followup-batch.md) and
> its [checkpoint](v2-m3-preservation-followup-checkpoint.md):
>
> 1. §1 below asserted "Wishlist items were never owned." That is false for
>    this repository: `lib/steam-import-jobs.ts:190-221`
>    (`reconcileSteamOwnership`) demotes a previously-Owned personal row
>    absent from the latest Steam response to Wishlist, and
>    `supabase/migrations/20260901193000_share_a_family_library.sql:237-280`
>    (`remove_user_family_member_games`) preserves an engaged family row the
>    same way on member removal. The recommended `retired_origin` field
>    (implying an inferred "this was wishlisted" interpretation) is replaced
>    by `legacy_ownership`, the verbatim source literal, and a distinct
>    family-retirement path was added that this document did not cover at
>    all (§1's proposal only touched `app.retired_library_games`).
> 2. §2 asserted "`recency_evidence_at` is null exactly when there is no
>    recency evidence of any kind" as a proven fact. That is an inference from
>    the writers this review read, not a schema-enforced guarantee, and a
>    later writer (`supabase/migrations/20260831175217_
>    add_steam_playtime_refresh.sql`, `refresh_pinned_steam_playtime`) was not
>    in this review's evidence set. The follow-up implementation treats an
>    unexplained field combination as a blocking exception (`recency_exceptions`)
>    rather than asserting the pattern always holds. §2's "fidelity
>    improvement" framing for `last_played_at` vs. `last_observed_played_at`
>    was also corrected: both are preserved as distinct facts, not one chosen
>    over the other.
>
> §3 (inverted completion clocks) was not corrected -- its classification and
> recommendation stood and were implemented as proposed, with a real latent
> bug in the transform's array-push fixed.
>
> The decision table and evidence below are kept as the original investigation
> record; read them together with the corrections above, not as the final
> word on §1/§2.

## Summary decision table

| # | Question | Classification | Recommendation | Physical change? |
|---|---|---|---|---|
| 1 | Wishlist tombstone `access_lost_at` / `loss_reason` / invented `retired_origin` | **Genuine physical gap**, both for the missing instant and for the missing origin dimension. Real: every source `user_games.ownership = 'Wishlist'` row hits this; it is not a synthetic edge case. | (a) `alter column access_lost_at drop not null` (keep the `now()` default for future runtime-detected losses). (b) Add one new nullable `retired_origin` column, **not** a new `loss_reason` literal — origin and reason are different facts and conflating them destroys information. `loss_reason='unknown'` for a wishlist row stays correct: there was no loss *event*, so there is no loss *reason* to name. | Yes — new migration, two independent minimal changes to `app.retired_library_games`. |
| 2 | `app.game_activity.observed_at` when `last_observed_played_at` is null | **Mostly a transform bug, not a physical gap.** The source already carries the observation-receipt instant the target column wants, under a different, already-read column (`recency_evidence_at`); the transform reads it but writes it to the wrong field. A true physical gap remains only for the sub-population with *zero* recency evidence of any kind. | Fix `lib/v2/migration/transform/library.ts` to source `observed_at` from `recency_evidence_at` (not `last_observed_played_at`), and gate `app.game_activity` row emission on `recencyEvidenceAt !== null` instead of `observedMinutes !== null`. Closes the gap for every row with real recency evidence, including the `steam_recent_window` kind that is proven live in production. The residual zero-evidence population needs **no** `app.game_activity` row at all — its minute count is already durable in `app.library_games.playtime_minutes`. | **No.** Transform-only fix; no migration needed. |
| 3 | `undone_at < occurred_at` has no destination in either `app.completion_events` or `app.unknown_completion_history` | **Valid-schema, zero real occurrences.** The source schema and the one live write path can represent it, but the 9 September production audit found `undo_before_claim: 0` of 13,157 real completion events. Not proven present; not impossible either. | Keep both target ordering invariants as-is (do not relax a live runtime CHECK for a phantom case). Fix a real latent bug in `lib/v2/migration/transform/history.ts`: today an out-of-order row is still pushed into the array bound for the DB, so if one ever appears it would abort the whole load with a raw `23514`, not degrade gracefully. Route it instead to a small typed exception list (raw `legacy_event_id`, `account_id`, `occurred_at`, `undone_at` preserved verbatim) that a human reviews before cutover — `migration.conflict_report` is an aggregate/count table and cannot hold this. Re-run the same audit query against the final pre-cutover export as a go/no-go gate; only build a durable table if it is ever actually nonzero. | **No, conditionally.** Transform fix now; a migration only if the pre-cutover re-audit finds a real row. |

Escalate-to-root items: none of the three requires a product/architecture call
beyond what is below — question 1's minimal migration is scoped and small
enough to fold into the same "new migration" root already expects for the
other two loader decisions the checkpoint flagged.

---

## 1. Wishlist tombstones

### What the target actually enforces

`app.retired_library_games` (`database/v2/supabase/migrations/20260906093036_m1_private_foundation.sql:278-288`):

```sql
create table app.retired_library_games (
  account_id integer not null references app.accounts(id) on delete cascade,
  game_id integer not null references catalog.games(id),
  last_personal_minutes integer
    check (last_personal_minutes is null or last_personal_minutes >= 0),
  last_observed_at timestamptz,
  access_lost_at timestamptz not null default now(),
  loss_reason text not null
    check (loss_reason in ('complete_snapshot', 'manual', 'unknown')),
  primary key (account_id, game_id)
);
```

No `retired_origin` (or any origin-shaped) column exists anywhere in M1 or M3.
`loss_reason` has three literals and none of them is `wishlist`.

### What the source actually is

Source `user_games.ownership` is a hard two-value enum,
`check (ownership = ANY (ARRAY['Owned', 'Wishlist']))`
(`database/v2/source-schema-inventory-20260909.json`, `user_games` constraints).
A `Wishlist` row is not a row that *lost* access — Steam wishlist items were
never owned, never granted library access, and the source schema has no
removal/tombstone timestamp for them at all (no `deleted_at`, no audit trail;
the row simply exists in the export with `ownership = 'Wishlist'` right now).
Calling this "access lost" is a real category mismatch against the column's
own name, not only a missing enum value.

### Is the origin already preserved durably elsewhere?

No. The transform (`lib/v2/migration/transform/library.ts:905-916`) writes
`ownership: row.ownership` into `evidenceDetails`, which lands in
`migration.legacy_library_evidence.evidence` — but that table's own DDL marks
it `retention_class text not null default 'staging-30d-post-cutover' ... check
(retention_class = 'staging-30d-post-cutover')`
(`database/v2/supabase/migrations/20260910232654_m3_preservation_schema.sql:1313-1315`),
consistent with plan §13's "Migration staging/exports ... purge within 30 days
of validated cutover." Every other `migration.*` candidate
(`migration.library_row_map`, the raw evidence tables) is the same staging
class. There is no `app.*` (durable) column anywhere that records "this
retired row was a wishlist item, not a formerly-owned one." After the 30-day
staging window closes, that fact is gone for good if not given a durable home
now.

This matters operationally, not just historically: today 100% of
`app.retired_library_games` rows produced by this transform are wishlist rows
(`retired.push` appears exactly once in `library.ts`, gated on
`personal && row.ownership === "Wishlist"`, line 662). A future milestone is
expected to add the *other* population — genuinely-owned games lost between
snapshots, reason `complete_snapshot`/`manual`. Once both populations share
the table, `loss_reason = 'unknown'` will be reachable by **both** "this was
always wishlist" and "this was owned and we don't know why it's gone" unless
origin is tracked separately. That is the conflation the review batch warned
against, and it is real, not hypothetical, given the plan's own stated future
disposition.

### Recommendation

Two independent, minimal physical changes to `app.retired_library_games`,
both consistent with plan §5.2 ("preserves evidence without widening active
rows") and with what the transform already, correctly, refuses to fabricate:

1. `alter table app.retired_library_games alter column access_lost_at drop not null;`
   Keep the `default now()` for the population a future diff-based detector
   will produce (where "now" genuinely is the instant the loss was observed).
   Leave `NULL` representable for a row with no provable instant, matching the
   transform's existing `access_lost_at_status: "unprovable_source_instant"`.
2. Add `retired_origin text not null default 'owned' check (retired_origin in
   ('owned', 'wishlist'))`. The transform already computes and emits this
   value (`library.ts:671`, `retired_origin: "wishlist" as const`) — it
   currently has nowhere to go. No transform code change is needed once the
   column exists; only the loader's column list changes. Do **not** add a
   `loss_reason` literal for wishlist: origin (what this row was) and reason
   (why it left) are orthogonal, and the checkpoint's evidence already shows
   `loss_reason='wishlist'` fails as `23514` for a good reason — it isn't a
   reason.

### Acceptance tests

- Real-PG constraint test (extending
  `lib/v2/migration/transform/library-constraints.integration.ts`, in the
  style of its existing 25): insert a wishlist-shaped row
  (`access_lost_at = NULL, retired_origin = 'wishlist', loss_reason =
  'unknown'`) and assert it is accepted.
- Assert the pre-migration failure modes the checkpoint already proved
  (`access_lost_at = NULL` refused, `loss_reason = 'wishlist'` refused) are
  gone post-migration *without* changing what a `complete_snapshot`/`manual`
  row requires (`access_lost_at` still enforced not-null for those, since only
  the column nullability changed, not a new relaxed default).
- A round-trip test that a row with `retired_origin` omitted defaults to
  `'owned'`, so any future loader path that doesn't yet know about origin
  fails closed toward the *safer* of the two categories rather than silently
  becoming `'wishlist'`.

---

## 2. Activity observation receipt time

### What the target enforces and what the transform currently does

`app.game_activity` (`database/v2/supabase/migrations/20260906093036_m1_private_foundation.sql:262-276`):

```sql
create table app.game_activity (
  account_id integer not null references app.accounts(id) on delete cascade,
  game_id integer not null references catalog.games(id),
  last_observed_minutes integer check (... >= 0),
  last_played_at timestamptz,
  observed_at timestamptz not null default now(),
  evidence_source text not null check (... in ('steam_profile','steam_api','user','unknown')),
  interval_started_at timestamptz,
  interval_ended_at timestamptz,
  primary key (account_id, game_id),
  check (last_observed_minutes is not null or last_played_at is not null),
  check (interval_ended_at is null or interval_started_at is null or interval_ended_at >= interval_started_at)
);
```

`observed_at` is not "the last-played instant" — it is *when this evidence was
captured*, a distinct fact the target schema deliberately separates from the
nullable `last_played_at`. The transform currently conflates them
(`lib/v2/migration/transform/library.ts:190-197`, `:824-843`): it reads
`row.lastObservedPlayedAt` (source `last_observed_played_at`) for **both**
`last_played_at` and, when non-null, `observed_at`; when it is null the row is
marked `observed_at_status: "unprovable_source_instant"` and the conflict is
recorded as `library_activity_observed_at_unprovable` (`:816-822`). Separately
it reads `row.recencyEvidenceAt` (source `recency_evidence_at`) but only uses
it for `interval_ended_at` (`:841`) — a field whose own check constraint
(`interval_ended_at >= interval_started_at`, always true here since
`interval_started_at` is hardcoded `null`) makes that placement a no-op.

### What the source writer actually records

The source has a column built for exactly this distinction, and it is a real,
currently-shipping, currently-called part of the product — not a dormant or
historical field.

`recency_evidence_at` is set by the source's own recency-inference system
(`supabase/migrations/20260825180000_infer_game_recency.sql:1-19`, comment:
*"Recency is now inferred from evidence VaultShuffle can actually obtain... The
rule that matters: absent evidence is UNKNOWN, never 'a long time ago'."*).
Two live writers populate it:

1. `public.upsert_user_steam_games`
   (`supabase/migrations/20260825190000_observe_playtime_for_recency.sql`),
   the library-import RPC. On every path that sets `last_observed_played_at`
   (a playtime rise, or a newer exact Steam timestamp — lines 159-177), it
   sets `recency_evidence_at` under the **same** `case` conditions (lines
   181-190), always to `now()`. The two columns are therefore never
   independently null: whenever `last_observed_played_at` is non-null,
   `recency_evidence_at` is guaranteed non-null too.
2. `public.apply_steam_recent_window`
   (`supabase/migrations/20260825191500_apply_recent_window_evidence.sql:14-49`),
   called nightly from live application code
   (`lib/nightly-metadata.ts` → `lib/recency-sync.ts:16-39` →
   `getSupabaseAdmin().rpc("apply_steam_recent_window", ...)`). Its own
   comment is explicit: *"`last_observed_played_at` is deliberately NOT set. We
   do not know the day... `describeRecency` reads `recency_evidence_at` for
   this source"* (lines 6-9). The `UPDATE` sets `recency_source =
   'steam_recent_window', recency_evidence_at = now()` (lines 35-38) while
   leaving `last_observed_played_at` untouched.

This second writer is precisely the population the review batch's gap
statement describes: real, useful evidence ("this game was played sometime in
the last two weeks") with no `last_observed_played_at`, but with a genuine,
durably-recorded, non-fabricated instant in `recency_evidence_at` — the exact
moment that evidence was captured, which is exactly what the target's
`observed_at` column is defined to hold.

The live product's own reader agrees with this split. `describeRecency`
(`lib/recency.ts:80-111`) branches on `recency_source`: for `steam_exact` /
`observed_playtime_change` it anchors on `lastObservedPlayedAt` (precise); for
`steam_recent_window` it explicitly anchors on `recencyEvidenceAt` (line 99,
comment: *"Steam told us, at `recencyEvidenceAt`, that the game had been
played at some point in the two weeks before that"*) and computes a bounded,
imprecise window from it. This is the same semantic split the target schema
encodes — `observed_at` (receipt, always known when there is any evidence) vs.
`last_played_at` (precise instant, only sometimes known) — already live in
production code, just not yet threaded through the transform.

### Where the true residual gap is

`recency_evidence_at` is null **exactly** when there is no recency evidence of
any kind (`recency_source is null`) — never set by either writer otherwise.
For an owned row with no recency evidence at all but a seeded
`observed_playtime_minutes` baseline (every owned row gets one on import,
`round(greatest(coalesce(input.hours_played, 0), 0) * 60)`), the transform's
current predicate `hasActivity = observedMinutes !== null || lastPlayedAt !==
null` (`library.ts:812`) is true, forcing a `game_activity` row that has no
observation instant available anywhere in the source — a real, unavoidable
gap for that sub-population, but note it never carries information beyond
what `app.library_games.playtime_minutes` already holds durably for the same
account/game. A `game_activity` row with `last_observed_minutes` equal to the
same number and zero recency signal adds nothing.

### Recommendation — transform-only, no migration

1. `observed_at` sources from `row.recencyEvidenceAt`, not
   `row.lastObservedPlayedAt`.
2. `last_played_at` continues to source from `row.lastObservedPlayedAt`
   (unchanged) — it correctly stays `NULL` for `steam_recent_window` rows,
   which is honest: the day is genuinely not known, matching `describeRecency`
   treating that case as imprecise.
3. Gate row emission on `hasActivity = row.recencyEvidenceAt !== null`
   instead of the current `observedMinutes !== null || lastPlayedAt !== null`.
   This makes `observed_at` provably non-null for every emitted row —
   `observed_at_status: "unprovable_source_instant"` becomes unreachable, not
   just less common — and it removes the redundant zero-evidence rows
   entirely rather than needing a fallback timestamp for them. The minute
   count is not lost: it stays exactly where plan §5.2 already puts the
   authoritative current count, `app.library_games.playtime_minutes`.
4. `interval_ended_at` should go back to `null` (its prior use of
   `recencyEvidenceAt` was filling a field that now duplicates `observed_at`
   for no reason — legacy has no source interval end and inventing one from a
   receipt timestamp misrepresents it as a play-session boundary).

Minor, secondary note (not required, flagged for completeness): `last_played_at`
could instead source from source `last_played_at` directly in one place
today (`library.ts:829`, `row.lastPlayedAt`) rather than the more current
`last_observed_played_at`. Since `last_observed_played_at` is seeded from
`last_played_at` on first write and is the only field `describeRecency` reads
for "last played," sourcing target `last_played_at` from
`row.lastObservedPlayedAt` would track the live product's own notion of
recency more faithfully when the two diverge. This is a fidelity
improvement, not a constraint fix — both source columns are valid nullable
timestamps and the target accepts either — so it is optional and left to the
implementing thread's judgment. (Verified in this review's evidence above,
not asserted from contract text.)

### Acceptance tests

- Unit: a row with `recency_source = 'steam_recent_window'`,
  `last_observed_played_at = null`, `recency_evidence_at = <T>` now emits a
  `game_activity` row with `observed_at = T`, `last_played_at = null`,
  `recency_evidence_kind = 'steam_recent_window'`, and no
  `library_activity_observed_at_unprovable` conflict.
- Unit: a row with `recency_source = null`, `observed_playtime_minutes = 0`,
  no other recency fields — no `game_activity` row is emitted at all; the
  minutes still appear once, in `app.library_games.playtime_minutes`.
- Regression: existing `steam_exact` / `observed_playtime_change` fixtures in
  `library.test.ts` keep identical output (since `recency_evidence_at` is
  non-null exactly when `last_observed_played_at` is non-null in those two
  kinds, per the writer's shared `case` conditions cited above).
- Real-PG constraint test: assert the `unprovable_source_instant` conflict
  class no longer fires for any fixture that includes recency evidence of any
  kind, in `library-constraints.integration.ts`.

---

## 3. Completion undo predating occurrence

### What both target destinations enforce

`app.completion_events`
(`database/v2/supabase/migrations/20260906093036_m1_private_foundation.sql:405-415`):
`check (undone_at is null or undone_at >= occurred_at)` (line 413).
`app.unknown_completion_history`
(`database/v2/supabase/migrations/20260910232654_m3_preservation_schema.sql:631-658`):
`check ((state = 'occurred' and undone_at is null) or (state = 'undone' and
undone_at is not null and undone_at >= occurred_at))` (lines 656-657). Both
tables enforce the same invariant; there is no destination for an inverted
pair anywhere in the target.

### Does the source actually permit this, and has it happened?

Source `completion_events` has no ordering constraint at all —
`database/v2/source-schema-inventory-20260909.json` lists only a PK, an FK,
and a `source` enum check for that table; `claimed_at` and `undone_at` are
independent nullable-vs-not-null timestamp columns with no CHECK between
them. So it is schema-representable in the source. But representable is not
the same as present: the 9 September read-only production audit
(`database/v2/source-conflicts-audit-20260909.json`) ran exactly this check
and recorded, against the real database:

```json
"completions": { "events": 13157, "undo_before_claim": 0, ... }
```

Zero of 13,157 real completion events are inverted. The live (and only) write
path corroborates why: `recordCompletionClaim` never sets `claimed_at`
explicitly (relies on the row default) and `recordCompletionUndone` always
writes `undone_at: new Date().toISOString()` against the most recently
claimed, not-yet-undone row for that account/game
(`lib/completion-events.ts:53-75`) — an undo cannot target a row that doesn't
exist yet, so under the one application code path that writes this table, the
ordering can only invert via clock skew across requests or an out-of-band
write (a direct SQL fix, an old dropped/ignored migration's bulk path). This
is therefore a **valid-schema, zero-observed-instance** case: real but
unproven, not impossible, not (yet) actually seen.

### The actual bug this review found

The transform's stated behavior ("the load is blocked until the ordering
decision is recorded",
`lib/v2/migration/transform/history.ts:494`) is not what the code does. When
`ordering === "undone_before_occurred"` (lines 486-497), the row is still
pushed unconditionally into `resolvedEvents` or `unknownEvents`
(lines 565-608) with both raw timestamps intact — which are the exact arrays
handed to the loader for `app.completion_events` /
`app.unknown_completion_history`. If such a row is ever present in a real
export, this does not degrade gracefully into a quarantined, reviewable
exception; it hits the target CHECK constraint and hard-fails the whole
relation's load with a bare `23514`. `migration.conflict_report`
(`database/v2/supabase/migrations/20260910232654_m3_preservation_schema.sql:1161-1172`)
cannot help after the fact either — its primary key is `(run_id,
conflict_class, source_relation, source_column)`, an aggregate row with a
`conflict_count`, not a place to hold one exact raw event.

### Recommendation

Do not touch the target ordering invariant — it is a real runtime correctness
rule (an undo genuinely cannot precede the event it undoes) and weakening it
for a case proven absent today would be exactly the "broad new history
subsystem for a rare anomaly" the batch says to avoid.

Fix the transform instead: when `ordering === "undone_before_occurred"`,
withhold the row from both `resolvedEvents`/`unknownEvents` and from
`registry`, and instead append it (verbatim `legacy_event_id`, `account_id`,
`occurred_at`, `undone_at`, `origin_surface`, resolved/unresolved game
identity) to a new, small, typed return array — e.g.
`orderingExceptions: readonly CompletionOrderingException[]` — that the run
report surfaces distinctly from the bounded/redacted `conflicts` stream (which
by design carries no raw timestamps or IDs, per
`docs/v2-m3-library-contract.md`'s "Failure and physical gates" section).
Before the real pre-cutover export, re-run the same `undo_before_claim` audit
query. If it is still zero, ship with the exception path unused and unbuilt
further — no migration, no new durable table. If it is ever nonzero, root
reviews the (expected: very small) list of raw exceptions and decides per-row
disposition then, with real evidence in hand rather than a synthetic one.

This keeps exact event identity, occurred/undone status, and raw times intact
without swapping, clamping, discarding, or silently activating anything —
satisfying the batch's requirement — while not building schema for a
population that has never been observed.

### Acceptance tests

- Unit: a synthetic `undone_at < claimed_at` fixture is no longer present in
  either `resolvedEvents` or `unknownEvents`, appears exactly once in the new
  exception array with both raw timestamps preserved, and produces no
  `registry` row (so no dangling FK to a row that was never written).
- Real-PG constraint test: confirm `app.completion_events` and
  `app.unknown_completion_history` still reject a directly-inserted inverted
  row (regression guard that the target invariant itself is untouched).
- Process gate (not a code test): re-run
  `database/v2/source-conflicts-audit-20260909.sql`'s `completions.
  undo_before_claim` aggregate against the actual pre-cutover source snapshot
  before final load, and record the result in the execution status ledger
  alongside the other cutover gates.

---

## Scope notes

This review read: the plan (§5.2, 5.3, 13, 14), `v2-execution-status.md`, the
library contract and checkpoint, the applied M1/M3 migration SQL, the source
schema inventory and 9 September conflicts audit, the live legacy writer
migrations for recency and completion events, the corresponding live
application read/write code (`lib/recency.ts`, `lib/recency-sync.ts`,
`lib/completion-events.ts`), and the owned M3-F transform source
(`lib/v2/migration/transform/library.ts`, `history.ts`) for the exact current
behavior each gap statement was based on. No SQL or target was queried or
mutated; no file outside this document was written. No test suite was
re-run — the transform's existing 121/121 and 25/25 real-PG results are taken
as reported in the checkpoint, not reproduced here.
