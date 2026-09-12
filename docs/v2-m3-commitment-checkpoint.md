# M3-G commitments, collections and draw transforms

Checkpoint. First written 2026-09-11 before implementation; **re-banked
2026-09-11 by the Claude M3-G native agent with the measured state of disk**
rather than the planned state.

## Ownership and boundary

This batch owns the pure transforms and tests for the `02-collections-and-vault`
source dispositions:

- `lib/v2/migration/transform/commitments-shared.ts` (shared M3-G vocabulary)
- `lib/v2/migration/transform/collections.ts` and its test
- `lib/v2/migration/transform/commitments.ts` and its test
- `lib/v2/migration/transform/draws.ts` and its test
- this checkpoint and `docs/v2-m3-commitment-contract.md`

The account, scalar, session, capability, catalogue and library transforms are
consumed as published interfaces and are never edited here. This batch changes
no SQL, no source data, no remote state, no runtime application code and no
package configuration.

## Measured state of disk at re-bank (2026-09-11)

Verified, not assumed:

- `lib/v2/migration/transform/commitments-shared.ts` exists (written 00:28,
  20997 bytes) and is the **only** M3-G file present. `collections.ts`,
  `commitments.ts`, `draws.ts` and every M3-G test are absent.
- `commitments-shared.ts` does **not** compile. `tsc --noEmit` reports exactly
  two errors in it, both import-contract mistakes rather than logic:
  - line 25: `fitsNumeric` is imported from `./scalars.ts`, which does not
    export it. It is exported by `./library-shared.ts`.
  - line 508: `parsePgDecimal` from `./scalars.ts` returns `PgDecimal | null`
    and is assigned to a `PgDecimal`.
- A third, unrelated error is outside this batch and left alone:
  `lib/v2/migration/transform/family.ts(410,7): Cannot find name
  'MAX_DISPLAY_NAME_LENGTH'`. That file belongs to the library worker.
- Applied migration verified on disk by SHA-256:
  `605b72a3d9df1328ec27033c3420c1813a238f6e15bd8fc28f971cddaf30a24a`
  `database/v2/supabase/migrations/20260910232654_m3_preservation_schema.sql`.
  M1 is `54fe0a7defd029e91568b78d51393670ac7ca6edcf915919670c7f64c2476389`,
  M2 is `f09d7ca900f3cdaaee81eff0f507adc5869865f16eb7f340eeb1729223bc5aba`.
  All three are immutable; nothing in this batch edits a `.sql` file.

## Shared interfaces, measured as concretely available

All three named dependencies exist on disk and are consumed, not reinvented:

1. **GameMap** — produced by `transform/games.ts` (`buildGameMap`,
   `GameMap`, `GameMapTargetRecord`, `lookupGameId`) in the shape fixed by
   `docs/v2-claude-domain-transforms.md`, and indexed through
   `library-shared.indexGameMap`. Used only for `vault_draws.steam_appid`,
   which references the catalogue directly.
2. **Library-row map** — produced by `transform/library.ts` as
   `LibraryRowMapRecord { legacy_id, account_id, game_id, steam_appid,
   source_snapshot_hash }` and returned from `transformLibraryBatch` as
   `library_row_map`. Every legacy `user_games` UUID reference in this batch
   resolves through it with an account-ownership check.
3. **Catalogue exact-value helpers** — `transform/catalogue-values.ts`
   (`parsePgTextArray`, `encodeJsonStringArray`, `inspectJsonDocument`,
   `pgLength`, `pgBtrim`, `utf8ByteLength`). Used for `selected_genres`
   (`text[]`) and `vault_events.context` (`jsonb`) so no JSON number ever
   passes through a double.

## Saved decisions

All inputs carry one explicit `{ runId, snapshotHash }` and every account,
game, library-row, collection and draw map is checked against it. Legacy UUID
game references join by the same-run library-row map with an account ownership
check; AppID identity is used only for the `vault_draws.steam_appid` source
column. Public collection and draw UUIDs stay verbatim. Internal IDs are
assigned after deterministic account/time/UUID ordering and before child
resolution.

Source rows that fit a nullable physical evidence destination but have an
unavailable game, collection, or historical game reference remain represented
with their legacy identity and a null target plus a stable finding. Missing or
cross-tenant **required** references, invalid bounds, malformed arrays/JSON, and
invalid timestamps are reconciliation blockers. No row is silently dropped,
trimmed, guessed, or re-owned.

Collection duplicate positions use source position plus explicit source-order
evidence when supplied, then canonical legacy game UUID as a deterministic
tie-break. Gaps are preserved and every member is retained. Pin hours retain
exact raw text and a bounded numeric value; a checked integer-minute conversion
is marked explicitly, while negative, overflow, non-finite, or
non-round-trippable values retain raw evidence and a conflict status. Null
snooze expiry remains indefinite. Vault current game requires account-scoped
map access; the source `user_vault_state` inventory has no current-draw column,
so absent draw data is represented as absent rather than invented.

Draw selection, draw impression rows, and user action rows remain separate
output families. Selected genres and finalist AppIDs are parsed with bounded
exact helpers; event context is validated as an object while preserving source
JSON text and never entering diagnostics.

## Completed, 11 September

All five layers are finished, tested and verified independently rather than
accepted on a prior run's word.

1. **Shared vocabulary** — `commitments-shared.ts` (835 lines). Stable.
2. **Collections** — `collections.ts` + `collections.test.ts`.
3. **Commitments** — `commitments.ts` + `commitments.test.ts`. One real test
   bug was found and fixed here: "refuses a missing cell rather than reading it
   as NULL" expected `m3g_invalid_timestamp` for a deleted `snoozed_at` key, but
   `snoozed_at` reads through the identical `m3Timestamp(m3Cell(...))` two-step
   as `pinned_at` and `updated_at`, so an absent key fails at `m3Cell` first with
   `m3g_input_invalid`, before `m3Timestamp` ever runs. The transform's behavior
   is coherent and matches its own sibling assertion in the same test two lines
   above; the test's expectation was wrong and is now corrected.
4. **Draws** — `draws.ts` + `draws.test.ts` (new, 37 tests, written this batch).
   Two of my own fixture bugs surfaced against the real code and were fixed
   before landing: `selected_genres` and `finalist_appids` are native
   PostgreSQL array output text (`{a,b}`), not JSON — the source columns are
   `text[]` and `bigint[]`; the transform's *output* is JSON for the `jsonb`
   destination, but the *input* fixtures need PG array syntax. And one test
   UUID used the tag `"g1"`, which is not valid hexadecimal for a UUID segment.
5. **Physical constraint gate** — new
   `commitments-constraints.integration.ts` (12 tests), covering all six
   relations this domain writes: `app.collections`, `app.collection_games`,
   `migration.collection_map`, `app.pins`, `app.snoozes`, `app.vault_state`,
   `app.vault_draws`, `app.vault_draw_events`, `app.vault_events`. It proves,
   against real PostgreSQL: the inverted-snooze CHECK is real and independent
   of what the transform emits; a draw's collection reference detaches via
   column-specific `SET NULL` when the collection is deleted while the
   membership row and the collection-map row correctly cascade away with it;
   every written relation revalidates cleanly under a no-op `UPDATE`, which
   re-fires CHECK constraints and triggers a plain `INSERT` may not have
   exercised; and account deletion removes every personal row while catalogue
   identity survives.

## Evidence

```text
node --experimental-strip-types --test \
  lib/v2/migration/transform/collections.test.ts \
  lib/v2/migration/transform/commitments.test.ts \
  lib/v2/migration/transform/draws.test.ts
```
Result: **129 passed, 0 failed** (36 collections, 56 commitments, 37 draws).

```text
VS_M3G_PSQL=node_modules/.cache/vaultshuffle-pg17-20260910/bin/psql \
VS_M3G_PGHOST=/tmp/vs-m3g-20260911 VS_M3G_PGPORT=55483 \
VS_M3G_PGUSER=vsm3g VS_M3G_PGDATABASE=vaultshuffle_m3g \
node --experimental-strip-types --test \
  lib/v2/migration/transform/commitments-constraints.integration.ts
```
Result: **12 passed, 0 failed**, against M1+M2+M3 applied fresh to an empty
database on a disposable local cluster stopped after the run. No sibling or
M1/M2 evidence database was touched.

`npm run typecheck`: passes across the repository. `npx eslint lib/v2`: clean,
no findings.

## Combined domain gate

Per the batch's acceptance section, the full pure-transform suite was run once
across every M3 domain to catch any interface integration error between the
independently developed catalogue, library, session/capability and
collections/commitments/draws modules:

```text
node --experimental-strip-types --test lib/v2/migration/transform/*.test.ts
```
Result: **418 passed, 0 failed.**

## Remaining gates

Everything owned by this batch is complete and evidenced above. What remains
is outside this batch's scope: root's physical-contract sign-off on the applied
target (this batch proved constraints on a local replay, not the live target),
real snapshot parity, and the later provider/duration/config/support/ops
transforms, staged loader and per-account reconciliation. No value was
synthesized to make any gate here green, and no genuinely unrepresentable
physical fact was found in this domain — every proposed row round-tripped
through the applied schema exactly as the transform produced it.
