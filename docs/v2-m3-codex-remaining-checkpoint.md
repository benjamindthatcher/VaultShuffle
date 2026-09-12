# M3 remaining domains checkpoint

Batch B from `docs/v2-m3-codex-dispatch-20260911.md`. Local and synthetic only:
no source or target connection, no secret lookup, no SQL apply, no index edit,
no real rows, no commit.

## 2026-09-11 — discovery and interface freeze (complete)

Read `AGENTS.md`, the installed Next TypeScript guide, the B dispatch, three
disposition manifests, immutable M1/M3 schema, source writers, and identity/
library transform interfaces. Published the three entry-point names and their
input/output boundary in `v2-m3-remaining-contract.md`.

## 2026-09-12 — implementation, tests and physical gate (complete)

All five owned source groups are implemented as pure typed transforms behind
the three frozen entry points, with the shared vocabulary rewritten around its
own error space (`RemainingTransformError`, `remaining_*` codes) and an
explicit blocker channel.

| Module | Sources | Durable destinations |
|---|---|---|
| `reco-config.ts` | `user_genre_preferences`, `genre_preference_globals`, `game_preference_globals`, `algorithm_weights`, `app_settings` | `reco.warm_start_snapshots` + three children, `reco.operator_weight_versions`, `app.account_preferences`, `migration.legacy_account_preferences_evidence` |
| `support-ops.ts` | `contact_messages`, `feedback_submissions` | `support.contact_messages`, `support.feedback_submissions`, `support.retention_policy_decisions` |
| `legacy-operations.ts` | `metadata_worker_runs`, `steam_import_jobs`, `api_rate_limits`, `account_merges`, `manual_profile_security_intents` | `ops.legacy_worker_runs`, `migration.legacy_import_freeze_report`, `ops.abuse_cooldowns`, `ops.account_merges`, `ops.account_aliases`, `migration.legacy_account_merge_audit`, `migration.legacy_auth_intent_audit` |

The full rules are in `docs/v2-m3-remaining-contract.md`. The decisions worth
naming here, because each one was a choice between two losses:

1. **float8 → numeric(30, 12) is not always possible.** A `double precision`
   counter can carry 17 significant digits. Rather than rounding (a changed
   counter) or failing the batch (unusable at real scale), such a row is
   withheld into `withheld_counters` with its exact source text and a
   `counter_unrepresentable` blocker. This is the one physical question B
   raises; it is left for root rather than answered with a schema change.
2. **An unverified `app_settings` key is quarantined, not collapsed.**
   `app_settings` has no key vocabulary in the schema, so an unknown key could
   be a preference, a feature flag or a credential. Unknown and
   credential-shaped keys reach bounded staging only, never the durable and
   exported `app.account_preferences`. No value is logged or echoed in a
   blocker, and nothing is dropped.
3. **Support authorship is preserved or the row is withheld.** The target
   forbids a half-identity, so a submission whose author is not in the map is
   withheld with identifiers only — anonymising it would detach a named
   person's own words from their deletion request.
4. **No cooldown is invented, reset or activated.** Without a supplied
   observation instant and algorithm version, `api_rate_limits` produces no
   rows at all. With an instant but no window length, every row is `unknown`
   with a NULL expiry (D-ABUSE-3). `account_id` is always NULL: a digest is not
   reversible into an account.
5. **No job is resumable.** The freeze report physically has no column for a
   lease token, a lease instant or the in-flight payload, and the intent audit
   has none for a token digest or nonce. Both are proved by querying
   `information_schema` in the gate, not by reading the code.

## Evidence

```text
node --experimental-strip-types --test lib/v2/migration/transform/*.test.ts
npx tsc -p .tsconfig.m3-batches.tmp.json --pretty false
npx eslint <the eight owned files>

VS_M3R_PGHOST=/tmp/vs-m3-batches-20260912 VS_M3R_PGPORT=55496 VS_M3R_PGUSER=vsm3 \
VS_M3R_PGDATABASE=vs_remaining VS_M3R_PSQL=node_modules/.cache/vaultshuffle-pg17-20260910/bin/psql \
node --experimental-strip-types --test \
  lib/v2/migration/transform/remaining-constraints.integration.ts
```

* Unit suite: **540 passed, 0 failed** across every transform test file (48 of
  them new here: 17 reco-config, 13 support-ops, 18 legacy-operations).
* Strict TypeScript: passed. Lint: passed, no findings.
* Physical gate: **14 passed, 0 failed** against a disposable PG17 cluster with
  M1+M2+M3 replayed. It proves exact round trips (`numeric(30, 12)` keeping
  `7.500000000001`, microsecond `timestamptz`, jsonb text), cross-account and
  half-identity rejection, unknown-owner handling, the retirement claims by
  `information_schema` rather than by assertion, secret quarantine, and that an
  account delete empties nine personal relations while account-free evidence
  survives.

## Interfaces for C

```ts
transformRecoConfigBatch({ runIdentity, accountMap, gameMap, warmStart, operatorConfig,
  userGenrePreferences, genrePreferenceGlobals, gamePreferenceGlobals, algorithmWeights, appSettings })
  -> { run_identity, warm_start_snapshot, user_genre_preferences, genre_preference_globals,
       game_preference_globals, operator_weight_versions, account_preferences,
       legacy_account_preferences_evidence, withheld_counters, blockers, counts }

transformSupportOpsBatch({ runIdentity, accountMap, contactMessages, feedbackSubmissions })
  -> { run_identity, retention_policy_decisions, contact_messages, feedback_submissions,
       withheld, blockers, counts }

transformLegacyOperationsBatch({ runIdentity, accountMap, workerRuns?, importJobs?, rateLimits?,
  accountMerges?, securityIntents?, cutover?, mergeTombstones? })
  -> { run_identity, legacy_worker_runs, import_freeze_report, abuse_cooldowns, account_merges,
       account_aliases, legacy_account_merge_audit, legacy_auth_intent_audit, blockers, counts }
```

Load-order facts C needs: `reco.warm_start_snapshots` must be inserted first and
its generated `id` stamped onto the three reco children;
`support.retention_policy_decisions` must exist before either support relation;
`ops.account_merges`/`ops.account_aliases` need both accounts present. A
nonempty `blockers`, `withheld_counters` or `withheld` array is a pre-commit
gate, exactly like the library domain's exception streams.

## Manifest changes A should make

None. Every disposition these transforms satisfy is already recorded in
`05-reco-and-config.json` and `06-support-and-ops.json`, and the two open
relation decisions (D-ABUSE-3, D-IMP-1) are deliberately still open: both
depend on the real freeze, and this batch produces the evidence for them
rather than closing them.

## Remaining true dependencies

* The `numeric(30, 12)` precision question is root's; until it is answered,
  over-precise counters are withheld rather than loaded.
* D-ABUSE-3 (does an unexpired legacy cooldown still bind after cutover?) and
  D-IMP-1 (which accounts were mid-import at the freeze?) need the real freeze,
  not this snapshot.
* Support retention (M6/M7) is an open policy decision; content is migrated
  exactly so nothing is lost before it is made.
* Everything here is proven on synthetic fixtures against a local replay. No
  real source row has been read by this batch.

## 2026-09-12 — loader integration acceptance repair

Re-reviewed B against the completed loader boundary and current source writers.
Reproduced one semantic gap: an unknown or credential-shaped `app_settings`
key was blocked but also emitted as loadable 30-day evidence. That made an
unresolved private value look like expiring staging rather than a non-loadable
pre-commit exception. `transformRecoConfigBatch` now emits it only in
`withheld_settings`; `legacy_account_preferences_evidence` is restricted to
verified preferences. The exact private source value remains in the transform
exception stream, never in diagnostics or target rows, and the blocker remains
mandatory. C has been sent the amended shape and gate requirement.

Next action: run the focused reco unit/type checks and communicate the exact
final exception count shape to C. No schema or manifest change is requested.

## 2026-09-12 — acceptance result

Completed two B boundary repairs:

1. Unknown and credential-like settings now emit only `withheld_settings`, a
   private non-loadable exception stream. They no longer appear in
   `migration.legacy_account_preferences_evidence`; verified preferences alone
   use that bounded staging relation. The loader must set
   `exceptionCounts.settings_withheld` from this array and reject publication.
2. `account_merges.merge_mode` must agree with the mapped source/target pair
   before its target spelling is derived. A malformed `promoted`/two-account or
   `merged_existing`/same-account row now fails with
   `remaining_order_conflict`, rather than being silently reinterpreted.

Focused validation completed:

```text
node --experimental-strip-types --test \
  lib/v2/migration/transform/reco-config.test.ts \
  lib/v2/migration/transform/legacy-operations.test.ts
# 36 passed, 0 failed

npx eslint lib/v2/migration/transform/reco-config.ts \
  lib/v2/migration/transform/reco-config.test.ts \
  lib/v2/migration/transform/legacy-operations.ts \
  lib/v2/migration/transform/legacy-operations.test.ts
# passed, no findings
```

`npx tsc -p .tsconfig.m3-batches.tmp.json --pretty false` is currently blocked
by C-owned `lib/v2/migration/load/pipeline.ts:144`: `applyLoadPlan` now expects
five arguments and is called with four. C was sent that exact defect and the
new `withheld_settings` shape. B has no remaining local repair; any final
loader typecheck waits on C's call-site fix.

## 2026-09-12 — source-boundary closure

Replaced all raw NUL delimiter bytes in `reco-config.ts` with escaped `\\0`
source literals, preserving the same runtime delimiter while returning the file
to ordinary text tooling.

Replaced `legacy-operations.ts` retention timestamp construction through
`Number`/`Date` with `timestampFromEpochMicros` in `scalars.ts`. It uses the
existing exact BigInt civil-calendar formatter, preserves pre-epoch remainders,
and rejects a derived instant outside the scalar's supported year range rather
than emitting malformed timestamp text.

Focused validation completed:

```text
node --experimental-strip-types --test \
  lib/v2/migration/transform/scalars.test.ts \
  lib/v2/migration/transform/legacy-operations.test.ts
# 27 passed, 0 failed

npx eslint lib/v2/migration/transform/reco-config.ts \
  lib/v2/migration/transform/legacy-operations.ts \
  lib/v2/migration/transform/legacy-operations.test.ts \
  lib/v2/migration/transform/scalars.ts \
  lib/v2/migration/transform/scalars.test.ts
# passed, no findings

grep raw-NUL check on reco-config.ts
# 0 bytes found
```

The added regression derives a 14-day retention window from
`1969-12-18T23:59:59.999999Z` and proves its exact `1970-01-01` rollover;
the scalar regression separately proves pre-epoch formatting and rejects the
instant after `9999-12-31T23:59:59.999999Z`. B is closed pending only C's
independent pipeline typecheck call-site repair.

## 2026-09-12 — transferred loader integration boundary

Transferred from C with root authorization: B now owns only new
`lib/v2/migration/load/all-domains.ts` and `all-domains.test.ts`, plus this
checkpoint entry. The assembler will consume a staged verified run and supplied
run/snapshot decisions, establish identity and complete AppID maps first, call
every frozen source-domain transform across all 44 source relations, and return
`TransformOutcome` batches, exact per-source accounting, accumulated exception/
conflict/blocker counts, and explicit missing target-relation additions. It will
not load withheld streams or edit transform, SQL, manifest, or target-contract
files.

## 2026-09-12 — all-domain assembler complete

Added the isolated `load/all-domains.ts` assembler and its focused tests. It
requires the complete 44-relation export inventory exactly once, reads every
relation from one staged run, builds identity/account and AppID maps before
calling all frozen transforms, then coalesces contributions by target relation
for the one-batch-per-relation loader contract. It returns exact staged-relation
accounting, source dispositions (`transform` or derived `rebuild`), transform
batches, conflict/blocker totals, explicit target-contract additions, and
pre-commit exception counts. `reco.withheld_settings`, unrepresentable counters,
and withheld support records are never batches; they are durable nonzero gate
counts. Duplicate or unknown staged relations fail `loader_source_coverage`.

The assembler needs target specs for every emitted relation listed in
`targetContractAdditions` when a supplied target-relation allowlist lacks one;
it deliberately makes no contract, SQL, or manifest edit. Its concrete output
batches cover:

```text
app.accounts, app.steam_profiles, app.sessions, app.account_capabilities,
app.library_games, app.game_state, app.game_activity, app.retired_library_games,
app.library_legacy_measurements, app.game_state_legacy_measurements,
app.family_members, app.family_game_access, app.family_access_orphans,
app.playtime_daily, app.completion_events, app.purge_review_history,
app.collections, app.collection_games, app.pins, app.snoozes, app.vault_state,
app.vault_draws, app.vault_draw_events, app.account_preferences,
catalog.games, catalog.game_metadata, catalog.game_features, catalog.game_sightings,
catalog.offers, catalog.offer_prices, catalog.review_decisions,
catalog.provider_state, catalog.duration_estimates, catalog.duration_aliases,
catalog.duration_imports, catalog.appid_terminal_rejections, catalog.seed_runs,
reco.user_genre_preferences, reco.genre_preference_globals,
reco.game_preference_globals, reco.operator_weight_versions,
reco.warm_start_snapshots, support.retention_policy_decisions,
support.contact_messages, support.feedback_submissions, ops.legacy_worker_runs,
ops.abuse_cooldowns, ops.account_merges, ops.account_aliases,
migration.account_map, migration.session_map, migration.account_capability_evidence,
migration.library_row_map, migration.legacy_library_evidence,
migration.legacy_user_game_state_audit, migration.legacy_family_member_evidence,
migration.legacy_family_access_orphans, migration.unknown_completion_history,
migration.completion_event_registry, migration.legacy_purge_review_archive,
migration.collection_map, migration.collection_membership_evidence,
migration.draw_map, migration.legacy_account_preferences_evidence,
migration.legacy_import_freeze_report, migration.legacy_account_merge_audit,
migration.legacy_auth_intent_audit, migration.legacy_duration_job_archive,
migration.legacy_ingest_queue_archive
```

Focused validation completed:

```text
node --experimental-strip-types --test lib/v2/migration/load/all-domains.test.ts
# 6 passed, 0 failed

npx tsc --noEmit --pretty false
# passed, no diagnostics

npx eslint lib/v2/migration/load/all-domains.ts \
  lib/v2/migration/load/all-domains.test.ts
# passed, no findings

git diff --check -- lib/v2/migration/load/all-domains.ts \
  lib/v2/migration/load/all-domains.test.ts \
  docs/v2-m3-codex-remaining-checkpoint.md
# passed
```

Remaining integration action: C can add/evaluate the explicit target relation
specifications and wire `assembleAllDomains(staged, runIdentity, evidence)` as
its `PipelineInput.transform`; no further change is required in this ownership
batch.
