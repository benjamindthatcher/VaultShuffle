# M3 preservation/provider checkpoint

11 September 2026. Batch A from `docs/v2-m3-codex-dispatch-20260911.md`. This
checkpoint is status-truthful: all work described here is local and synthetic.
No remote database was queried, no target migration was applied, and no
production/provider state was changed.

## Phase 1 — acceptance review (complete)

Reviewed the preservation follow-up/final-review and provider contracts against
plan sections 5.4, 7, 13 and 14.2, the frozen source inventory, M3 SQL, and the
actual legacy writers. The three preservation corrections remain substantively
sound: Wishlist is retained as a source label rather than interpreted as
never-owned; family Wishlist tombstones do not confer access; divergent raw and
observed play clocks have a durable home; family measurements are withheld from
borrower activity; inverted completion clocks are withheld. Nonempty recency or
completion-order exception streams remain final-load blockers, and each one now
also has a redacted `migration.conflict_report` counterpart so a pre-commit gate
can see it without reading a raw value.

One source-file defect was repaired: the two literal NUL bytes in
`library-shared.ts` are now the source text `\u0000`. Runtime key semantics are
unchanged (the `ConflictCollector` key is byte-identical at run time) while the
file is no longer a binary-like source artefact — `grep` silently matched
nothing in it before.

## Phase 2 — provider durability (complete, was the blocking defect)

The provider return archived both queues into `staging-30d-post-cutover` and
retired their retry columns with the claim that scheduling is "rebuilt after
cutover". Nothing performs that rebuild, and the source writers show what the
loss actually costs:

* `ensure_catalogue_entries`
  (`supabase/migrations/20260829224231_reparent_product_data_to_app_accounts
  .sql:157-172`) queues every requested AppID that has no `catalog_games` row.
  A `rejected` AppID is exactly that — the classifier refused to store it
  (`lib/catalogue.ts:206-238`). While the queue row exists the verdict holds;
  once the archive expires the next import re-queues it at `attempts = 0` and
  the fetch/classify/quarantine/reject cycle repeats forever.
  `lib/catalogue.ts:167-177` records that this churn (~80 retries per entry)
  already happened once.
* `lib/duration-worker.ts` writes `failed` after `MAX_ATTEMPTS` (140-143), keeps
  the only record of effective backoff in a `retry` fence (145), and writes
  `needs_review` verdicts such as `duration_not_found` /
  `known_title_no_provider_times` (117-127) that re-running cannot change.
* `catalog_games.tags_next_attempt_at` was retired as "rebuilt from
  `tags_status`" — but a `failed` status does not say *when* work becomes due,
  so every failed app would have become due at once after cutover.

Fixed, using the destinations M3 already created for this purpose (no new
schema was needed — `catalog.provider_state` and
`catalog.appid_terminal_rejections` existed and nothing emitted them):

| Source | Case | Durable destination |
|---|---|---|
| `catalog_ingest_queue` | AppID with a catalogue row | `catalog.provider_state` (`metadata`) |
| `catalog_ingest_queue` | terminal on an uncatalogued AppID | `catalog.appid_terminal_rejections` (`ingest`) |
| `game_duration_jobs` | AppID with a catalogue row | `catalog.provider_state` (`duration`) |
| `game_duration_jobs` | terminal on an uncatalogued AppID | `catalog.appid_terminal_rejections` (`duration`) |
| `catalog_games.tags_*` | any app with tag evidence | `catalog.provider_state` (`tags`) |

The split follows the physical schema: `provider_state.game_id` references
`catalog.games`, so it cannot hold a rejected identity — which is why M3
created the AppID-keyed table and why its comment says terminal verdicts are
extracted "before expiry". No provider attribution is invented (both queues are
provider-agnostic, so `UNATTRIBUTED_PROVIDER = 'unknown'`; tags use the real
`tags_source` only for a ready result, because the writer retains the previous
successful source while another refresh is pending or fails). No status is
invented to fit: `retry` becomes `failed` **with
its fence** (the only target status whose CHECK permits one), `rejected`
becomes `no_match`, and a `needs_review` conflict awaiting a person becomes
`review_required` rather than a terminal rejection. Verdict text fails closed
rather than being truncated into the copy that outlives the archive.

Manifest dispositions were updated to match, not merely the code: both queue
relations moved from `archive-only` to `migrated`, and eight columns moved from
`derived-retirement`/`audit-archive` to `preserved` with resolvable targets.

## Phase 3 — preservation verification (complete)

Re-verified against the code and the physical gate, not from the prior
checkpoint's word: Wishlist never implies never-owned (`legacy_ownership` is the
verbatim literal); a null loss instant is restricted to labelled
`Wishlist` + `unknown` (every other combination is rejected `23514`); family
tombstones confer no active access (`disposition = 'retired'`, zero
`app.family_game_access` rows); divergent raw/observed clocks survive durably in
`app.game_activity.legacy_last_played_at` in either direction; family minutes
never become borrower activity (withheld as
`family_access_measurement_unassignable`).

## Phase 4 — follow-up migration prepared (complete, unapplied)

`database/v2/supabase/migrations/20260911234500_m3_legacy_preservation_followup
.sql`, SHA256 `beecb95c25e87f1b239f11f16e807338ec496df19ac27deffa5fb49b0bda5f59`.
DDL unchanged from the reviewed proposal; the proposal file now points at it and
is kept only as review history.

Index/manifest status is truthful rather than convenient:
`build_destination_index.py` records the file with `"applied": false`, and
because it adds columns to already-applied relations, the builder now emits a
`pending_columns` section (`app.game_activity.legacy_last_played_at`,
`app.retired_library_games.legacy_ownership`) and a boundary note stating that a
pending column is a resolvable target that is **not** present on the target
database, so no decision may be closed on one. The five source-dependent
relation decisions and the exact-hours blocker are untouched — the manifest
still reports 1 unresolved column and 5 relation-level open decisions.

The apply review packet (rollback, rebuild, RLS/privacy/retention/default/
constraint evidence, remaining gates) is `docs/v2-m3-followup-apply-packet.md`.

## Phase 5 — evidence (complete)

```text
node --experimental-strip-types --test lib/v2/migration/transform/*.test.ts
python3 database/v2/migration/manifest/build_destination_index.py
python3 database/v2/migration/manifest/build_manifest.py
python3 database/v2/migration/validate/validate_manifest.py
```

* Unit suite: **492 passed, 0 failed** across every transform test file
  (catalogue 75, catalogue-provenance 25, duration-provider 25, the rest
  unchanged) — 12 more than the 480 the dispatch recorded, all of them new
  durability cases.
* Destination index: 92 relations (92 applied + 0 proposed), 993 columns,
  **2 pending columns**, 13 extended relations; `--check` clean.
* Manifest: 44 relations / 486 columns valid; 1 unresolved column and 5 open
  relation decisions deliberately preserved.
* Fresh disposable PG17, M1+M2+M3+follow-up replayed in order:
  library/preservation gate **27 passed**, provider gate **17 passed**, both
  0 failed. The three immutable SHA256s are unchanged.

## Interface freeze for C

* `transformIngestQueueArchive({ runIdentity, gameMap, rows })` →
  `{ archive, provider_state, terminal_rejections, counts }`.
* `transformDurationJobArchive({ runIdentity, gameMap, rows })` →
  `{ archive, provider_state, terminal_rejections, counts }`.
* `transformCatalogue(...)` → result gains `provider_state` and
  `counts.provider_state`.
* New loadable target relations for the loader: `catalog.provider_state`,
  `catalog.appid_terminal_rejections`. Column order is the target's own. Both
  transform records expose `source_snapshot_hash` as canonical 64-character
  lowercase hex, while both physical target columns are `bytea` and must
  receive the decoded 32 bytes (or PostgreSQL `\\x` bytea form).

The frozen row interfaces are:

| Output | Fields, in transform order |
|---|---|
| `provider_state` | `game_id`, `provider`, `evidence_kind`, `status`, `failure_count`, `next_attempt_at`, `processing_started_at`, `fetched_at`, `last_error_code`, `last_error`, `source_snapshot_hash`, `updated_at` |
| `terminal_rejections` | `steam_app_id` (exact bigint text), `evidence_kind`, `provider`, `terminal_status`, `reason`, `attempts`, `last_error_code`, `first_requested_at`, `last_attempt_at`, `source_relation`, `retry_allowed_after`, `source_snapshot_hash` |

`source_snapshot_hash` stays hex in transform results and run/checksum metadata;
only the database binding decodes it. A loader must insert all three
provider-state evidence kinds independently and reject a duplicate composite
key rather than choosing a winner.
* Definitive local schema path:
  `database/v2/supabase/migrations/20260911234500_m3_legacy_preservation_followup.sql`
  (unapplied). Target-row changes: two new nullable columns plus one new
  disposition literal, listed in the apply packet.

## Remaining blockers (root's, not this batch's)

* The follow-up migration is unapplied and this batch may not apply it.
* Everything is proven on synthetic fixtures against a local replay. The five
  source-dependent decisions and the exact-hours blocker stay open and may not
  be closed from a historical aggregate audit instead of the real export.
* Terminal-verdict volume is unknown until the real export: the 9 September
  audits are HTTP-paginated reads, not the export snapshot.

## Phase 6 — 12 September bounded integration acceptance (complete)

The durable provider delta was rechecked against the frozen source constraints
and current writer behaviour. `catalog_games.tags_status` accepts only
pending/processing/ready/failed and `duration_status` accepts only
pending/processing/ready/failed/no_match/review_required; the catalogue
transform now rejects any broader target-only literal instead of treating it as
a source fact. Every catalogue row emits one tags provider-state row. Ready tag
evidence may retain `tags_source`; pending, processing, and failed attempt state
uses provider `unknown`, because the writer does not clear the last successful
content source while another attempt is queued or fails.

Unmapped AppIDs are fail-closed at the physical boundary. An uncatalogued
nonterminal ingest or duration row with a live retry fence raises
`provider_physical_gap`; so do an uncatalogued ready ingest row and an
uncatalogued nonterminal duration `needs_review` verdict. There is no lossless
row shape for those cases: `catalog.provider_state` requires `game_id`, while
`catalog.appid_terminal_rejections` accepts terminal outcomes. These failures
are final-load blockers if the frozen export contains them. A terminal
uncatalogued outcome remains loadable by AppID, and due work with no surviving
fence remains rebuildable.

Provider outputs have no contradictory duplicate key across sources. The three
mapped producers use distinct `evidence_kind` values under the physical
`(game_id, provider, evidence_kind)` key: ingest metadata, duration, and tags.
The fresh PostgreSQL gate inserted all three for the same game and provider and
read back exactly `duration,metadata,tags`; no last-writer-wins merge is
permitted.

Focused evidence for this delta:

* catalogue/provider units: **128 passed, 0 failed** (catalogue 75,
  catalogue-provenance 27, duration-provider 26);
* strict TypeScript and ESLint over the seven changed provider files: passed
  with no findings;
* manifest validator: **99 passed, 0 failed**; probe-safety: **22 passed,
  0 failed**;
* destination-index and manifest `--check`: clean; coverage remains 44
  relations / 486 columns with 1 unresolved column and 5 relation-level open
  decisions;
* strict final-load now fails with both V13 and **V18**, where V18 names the 2
  locally prepared, unapplied columns across 2 relations; and
* a fresh disposable PostgreSQL 17 replay of M1 + M2 + M3 + the follow-up:
  provider constraint gate **17 passed, 0 failed**, including the three-source
  composite-key coexistence assertion. The server was stopped after the run.

The follow-up bytes did not change during this review. SHA256 remains
`beecb95c25e87f1b239f11f16e807338ec496df19ac27deffa5fb49b0bda5f59`;
M1/M2/M3 remain `54fe0a7d…` / `f09d7ca9…` / `605b72a3…`.

The apply packet now records rollback accurately: dropping either new column
after a load destroys its populated facts, and restoring the old CHECK/NOT
NULL shape can reject preserved rows. Its rollback SQL is explicitly pre-load
only. It also records the target observation as dated evidence, not proof of a
future apply state. The read-only 12 September target record shows a healthy
correct project/marker, only M1/M2/M3 applied, accounts/games/runs all zero,
zero unforced RLS, zero browser table grants, and INFO-only advisors. The SQL is
locally apply-ready at its frozen checksum, subject to an authorized
transactional apply and an immediate repeat of identity/version/drift/row-shape
and security prechecks. No remote DDL was performed.
