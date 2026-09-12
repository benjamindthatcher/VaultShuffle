# M3-F library/family/history checkpoint

Checkpoint date: 2026-09-11 (London continuation, second pass). Scope is the
owned `lib/v2/migration/transform/library*`, `family*`, `history*` modules and
tests plus the paired library contract. No SQL, package, source, remote,
credential, deployment, or sibling-domain file was changed. The applied M3
migration on disk is `20260910232654_m3_preservation_schema.sql`, SHA-256
`605b72a3d9df1328ec27033c3420c1813a238f6e15bd8fc28f971cddaf30a24a`, verified
and never edited.

## Verified state at resume

The previous session's files and tests were all present on disk and the
checkpoint's claim of **93 passing tests** and a passing owned-file typecheck
reproduced exactly. The only correction the checkpoint needed is that
`npx tsc --noEmit` over the whole repository currently fails on the sibling
batch-3 file `lib/v2/migration/transform/commitments-shared.ts`, not on any
owned file; owned-file strict typechecking is therefore run through an explicit
file list with the repository compiler options.

## Completed layers

* Shared map validation is same-run and bounded. Account/game maps reject
  malformed source kinds, foreign hashes, duplicate identities, invalid target
  IDs, and unsafe intermediate lookups; both expose `hasTarget` for downstream
  hand-off validation.
* `user_games` preserves exact observed minutes, legacy hours, opaque dates,
  sparse authored state, activity provenance, family candidates, wishlist
  retirement evidence, raw measurements, and authoritative stale-state facts.
  Family verification uses `family_verified_at` or the source `updated_at`
  fallback required by the manifest; no wall clock is read.
* Stale `user_game_state` is quarantine/reconciliation-only. Banked facts are
  validated for snapshot, account, AppID, timestamp, decimal, and string
  integrity before comparison. Valid reviewed smallint codes remain unresolved
  evidence; out-of-domain codes fail.
* Family members retain simultaneous lenders and full candidate arrays, enforce
  the five-member and candidate caps as visible conflicts, preserve exact URL
  text, and archive overlength compact metadata in bounded evidence. Access
  candidates are validated before deterministic joins; orphan access never
  confers access.
* Daily history remains cumulative. Completion events retain one identity each
  across resolved/unknown history plus the registry. Malformed hours fail,
  non-finite and negative hours remain raw evidence, and purge ordering is
  stable for equal timestamps.

## Exactness fixes made in this pass

Each of these was checked against the applied M1/M3 DDL rather than against the
transform's own assumptions, and each is covered by a new test.

1. **Legacy hours had no `numeric(30, 12)` fit check.** `library.ts` wrote
   `hours.toCanonicalString()` into both `migration.legacy_library_evidence`
   and `app.library_legacy_measurements`, whose columns are
   `numeric(30, 12)` with a non-negative check. A value needing more scale or
   magnitude would have rounded silently at load, and a negative value failed
   the whole row. The value is now classified `exact` /
   `precision_exceeds_target` / `negative`; the numeric column is NULL outside
   `exact`, the exact text always survives in `legacy_hours_played_raw`, and the
   case is counted as an unresolved conflict. The source column is
   `numeric(10, 1)` in the 9 September audit, but a dated aggregate is evidence
   and not a precondition, so the fit is proved per value.
2. **`app.game_state.notes` was measured untrimmed.** The target check is
   `length(btrim(notes)) between 1 and 10000`, so a 10000-character note inside
   spaces was rejected although the target accepts it. The bound is now measured
   after `btrim` while the stored text stays the verbatim source.
3. **`app.family_members.display_name` had the same fault** against
   `length(btrim(display_name)) between 1 and 200`; fixed the same way.
4. **`migration.legacy_family_access_orphans.evidence` was unbounded.** A
   malformed lender identity of up to 20000 characters is copied into that
   JSONB payload, whose check is `pg_column_size(evidence) <= 32768`; multibyte
   text could exceed it with no precheck at all. All four JSONB payloads
   (library evidence, member evidence, orphan evidence, completion
   `metric_provenance`) now go through one provable byte upper bound,
   `jsonbUpperBoundBytes`, which accounts for the varlena and container headers,
   a JEntry per key and value, alignment padding and binary `numeric` storage
   rather than comparing JSON text length against a JSONB bound.
5. **`raw_family_owner_steam_id` over 200 characters failed every row.** Only
   promotion to `app.game_state_legacy_measurements` has to narrow that text;
   `migration.legacy_user_game_state_audit` takes unbounded text. The bound is
   now enforced at the promotion decision, and a reconcile-only row keeps the
   full text with an explicit conflict. The measurement also moved from the
   JavaScript UTF-16 `length` to a character count, matching PostgreSQL
   `length()`.
6. **`localeCompare` in the family access ordering** was replaced with code-unit
   comparison; collation depends on the host's ICU data and deterministic output
   may not depend on the environment.

## Evidence

Focused command:

```text
node --experimental-strip-types --test \
  lib/v2/migration/transform/library.test.ts \
  lib/v2/migration/transform/library-state.test.ts \
  lib/v2/migration/transform/family.test.ts \
  lib/v2/migration/transform/history.test.ts
```

Result: **121 passed, 0 failed** (39 library, 21 library-state, 26 family, 35
history).

Strict typecheck with the repository compiler options over the owned files:

```text
npx tsc -p .tsconfig.m3-library.tmp.json --pretty false
```

Result: **passed**. Lint over the same nine files: **passed, no findings**.

The suite covers exact integer/decimal/timestamp/civil-date paths, the int32 and
int64 boundaries, non-canonical AppID text, same-run and target-map validation,
source-order permutation, malformed PostgreSQL arrays and malformed JSON-shaped
inputs, unknown/null distinctions, family versus personal attribution,
stale-state one-way reconciliation, byte-measured overlength evidence, redacted
errors, completion identity retention, non-finite/negative/unrepresentable
hours, leap-day and year-boundary civil dates, and equal-time purge ordering.

## Physical constraint gate, completed 11 September

`lib/v2/migration/transform/library-constraints.integration.ts` (1,089 lines)
now runs the typed output of all four transforms against a real PostgreSQL 17
cluster with M1, M2 and M3 replayed, and passes cleanly on a freshly created
fixture database:

```text
VS_M3_LIB_PSQL=node_modules/.cache/vaultshuffle-pg17-20260910/bin/psql \
VS_M3_LIB_PGHOST=/tmp/vs-m3-lib-20260911 VS_M3_LIB_PGPORT=55481 \
VS_M3_LIB_PGUSER=vslib VS_M3_LIB_PGDATABASE=vaultshuffle_m3_library \
node --experimental-strip-types --test \
  lib/v2/migration/transform/library-constraints.integration.ts
```

Result: **25 passed, 0 failed**, against M1+M2+M3 applied fresh to an empty
database on a disposable local cluster (no sibling or evidence database was
touched; the cluster was stopped after the run). It also proves, by real
`app.accounts` deletion and a re-count of every written relation, that account
deletion removes every personal row this domain writes while catalogue
identity and run metadata survive. A no-op `UPDATE` on every written relation
re-fires its CHECK constraints and triggers, so a constraint no `INSERT` above
happened to exercise is still proved.

The three cases the prior handoff flagged for concrete evidence are proven,
each by letting PostgreSQL itself reject the row, so the finding cannot
silently drift from what the schema actually enforces:

| Case | Evidence | Classification |
|---|---|---|
| Wishlist access-loss instant/reason | `insert into app.retired_library_games` with `access_lost_at = NULL` is refused, SQLSTATE `23502` (not-null violation); the same insert with `loss_reason = 'wishlist'` is refused, SQLSTATE `23514` (check violation) | **Genuine physical gap.** `access_lost_at` is `NOT NULL` with a `now()` default and `loss_reason` has no `wishlist` literal (M1:284-286). The transform has no provable loss instant for a wishlist tombstone and no matching reason literal; supplying either would fabricate a clock or misclassify the origin. |
| Missing activity observation instant | `insert into app.game_activity` with `observed_at = NULL` is refused, SQLSTATE `23502` | **Genuine physical gap.** `observed_at` is `NOT NULL` with a `now()` default (M1:268). When the source instant is absent, only a fabricated wall-clock value would satisfy the column. |
| Completion undo predating occurrence | `insert into app.completion_events` with `occurred_at` after `undone_at` is refused, SQLSTATE `23514` | **Genuine physical gap, not a transform error.** Live `completion_events` carries no ordering check between `claimed_at` and `undone_at` (confirmed against `database/v2/source-schema-inventory-20260909.json`), so an out-of-order source row is representable in the source and has no destination in either `app.completion_events` (M1:413) or `app.unknown_completion_history`. Reordering or clamping the timestamps to fit would silently rewrite source evidence. |

None of the three is a loader-policy decision the transform can make unilaterally:
each requires either a new reviewed migration (a nullable instant, an added enum
literal, or a relaxed/alternate ordering destination) or an explicit root
decision to accept data loss for that population. The transform's own behavior
is already correct for all three — it returns a typed record with the
unprovable field set to `null` and an `UNRESOLVED for root` finding, never a
fabricated value — so no code change was needed to close this gate; the gate
was proving that correctness against the real schema, and it now does.

One drive-by hygiene fix: the conflict-report disjointness test used a raw NUL
byte as a composite-key delimiter, which made the file read as binary to
`file(1)` and to `grep` without `-a`. Replaced with `::`, which cannot appear in
any of the three snake_case/dotted identifier fields it joins; typecheck, lint
and the full 25-test suite were re-verified afterward.

## Remaining gates

A completed M3-F acceptance still needs the root-owned physical replay/loader
gate on the applied target (this batch proved constraints on a local replay,
not the target itself), the three decisions above, and real snapshot parity.
Remote source auth/TLS and a real export remain unproven. No value is
synthesized to make any gate green.
