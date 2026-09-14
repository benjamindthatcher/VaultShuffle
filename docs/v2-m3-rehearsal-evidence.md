# M3 rehearsal evidence decisions

13 September 2026. Coordinator decisions for the approved read-only source
export and offline rehearsal. These decisions provide transformation inputs;
they do not declare a production freeze, authorize source writes, or clear
unmeasured data-integrity failures.

- Use the completed export's transaction watermark as the observation/freeze
  instant for this rehearsal. Preserve UTC instants without geographic offsets.
- Name the imported recommender snapshot from the completed export run identity,
  with schema version `1`, source project `pfvblcopcmairdfeqdep`, actual captured
  instant and actual manifest SHA256. This identifies a frozen copy of the
  source counters; it does not fabricate an earlier source version.
- Name the imported operator configuration `legacy-import-<export-run-id>`.
  Its `effective_at` is the same snapshot observation instant, meaning effective
  for this imported configuration copy. Preserve source row update instants.
- Attribute legacy prices to `legacy_catalog_games`. For the isolated rehearsal,
  supply an explicit retention limit of snapshot observation plus 30 days.
  This is a coordinator-selected rehearsal policy, not a source timestamp.
  Preserve each actual price observation instant; a later source observation
  than this limit is an error to inspect, not a timestamp to clamp. No cleanup
  job or production price expiry is activated by this input.
- Cooldown observation is the same snapshot instant. The legacy algorithm is
  the existing fixed-window counter. Window lengths vary by caller and are not
  stored per source row, so do not supply a fabricated universal window length.
  Preserve unknown expiry where the existing transform requires it. Final
  active cooldown bridging remains an M6/M7 gate.
- Keep support retention `pending` as required by the existing physical model.
  Do not choose a message/email deletion period to make a migration pass. The
  actual pending blocker remains visible in preflight; its milestone handling
  will be decided at rehearsal integration, separately from production policy.
- Keep in-flight imports as a report, never resumable jobs. This snapshot's
  affected population is rehearsal evidence; the actual final freeze must
  measure it again before cutover.
- P05 playtime precedence and purge/completion projection need the actual
  snapshot findings. Preserve both represented source facts until that review;
  no max, guessed authorship, rounding away, or invented completion is allowed.

Supplementary live view definitions are captured inside the export transaction
and stored in an adjacent private sidecar bound to run identity, watermark and
manifest hash. The v2 row-export manifest/reader contract stays unchanged. These
definitions inform the replacement read model; they do not replace row hashes
or count reconciliation.

## Decisions from the first completed real snapshot

The verified run `20260913T130404Z-130c2ad9` contains 378,513 personally owned
library rows. All have exact observed minutes, with zero mismatches against the
legacy JavaScript rounded-hours writer. All 1,796 family rows have unknown
minutes and zero legacy hours. For this rehearsal, exact observed minutes are
the owned runtime fact; family minutes remain unknown. Both existing evidence
representations remain preserved. These counts close the P05 uncertainty for
this snapshot, not for a future final freeze.

The first transform attempt found that real `catalog_games.tags` is the
runtime's numeric tag-name map, while the applied V2 column requires an array.
The coordinator approves a deterministic, reversible adapter from an object to
an array of `{tag, weight}` entries, ordered by exact tag name. Keep numeric
tokens exact without conversion through JavaScript Number; keep tag strings
unchanged. Reject malformed/non-numeric weights or duplicate keys without
dropping values. Existing array inputs remain unchanged. Reconstruction of the
object must preserve JSON semantics; the protected export retains wire bytes.
No extra archive column or modification to an applied migration is needed.

There are 404 purge reviews with action `complete`, of which nine have no
matching *active* completion event. That aggregate alone cannot distinguish a
missing historical completion from one the user deliberately undid. Inspect
the presence of any historical/undone event and current game state before
deciding whether the old review needs a completion-feed projection. Preserve
the separate purge history in either case; do not manufacture a completion.

Nine in-flight imports and 90 cooldown rows are observed. Retain the existing
freeze report and unknown expiry representation; this rehearsal activates no
imports or cooldown policy.

Dedicated `catalog_game_sightings` overlaps 24,769 of 28,178 catalogue rows;
3,409 are catalogue-only and none are dedicated-only. Every overlapping import
count agrees. Their first-seen instants differ on all overlaps and last-seen
instants on 1,066. These source timelines already have separate destinations:
`catalog.games` retains the catalogue row's first/last-seen instants, while
`catalog.game_sightings` can retain the dedicated sighting row's instants.
Use the dedicated row for sightings when present and the catalogue fallback
otherwise. Do not min/max either timeline. Keep conflicting import counts as
a hard error because there is only one counter destination. This resolves the
timestamp mismatch without dropping facts or adding schema.

Of the nine purge completions with no active matching event, four have only
undone matching events and five have never had an event. Never recreate the
four undone completions. The aggregate current-state split is three Completed
and six other; the eventless subset still needs its own split before deciding
any historical feed projection.

The legacy completion-dismissal writer at
`app/api/games/completions/route.ts:49` stores `game.hours_played` directly.
Therefore `user_games.completion_suggestion_dismissed_playtime` is hours;
the earlier manifest's "minutes-or-unspecified" assumption is incorrect.
The V2 `app.game_state.completion_dismissed_playtime` contract is minutes.
Convert decimal hours times 60 exactly, requiring an integral nonnegative
int32 result. Do not round or clamp. Keep the original decimal-hours text in
existing `migration.legacy_library_evidence`, independently of the converted
runtime baseline. Stale `user_game_state` comparison must use consistent units
without changing its audit-only authority. Nonintegral-minute/overflow values
remain explicit failures if observed; no timestamp or migration change is needed.

The one real `catalog_duration_import_runs` row uses terminal status `completed`,
as written by legacy migration `20260825153000`. Map this to the equivalent
V2 `catalog.duration_imports.status='succeeded'`, retaining its original
completion instant and source evidence. Existing accepted labels remain
unchanged; unknown labels still fail.

The preflight worker may resolve further directly proven representation
mismatches autonomously when both the source writer and target contract make
the mapping unambiguous and every source fact survives. Record the evidence
and focused regression. Ambiguous authored state, lossy conversion, missing
physical storage, security changes and new schema still require coordinator
review. Routine label adapters do not need another approval loop.

## Grouped review of completed preflight 11

The complete transform ran with no missing physical destination relations and
no target writes. Its remaining groups require these specific resolutions,
not a blanket exemption from validation:

- The 21,899 stale smallint-code occurrences are already preserved verbatim in
  durable `app.game_state_legacy_measurements` and never supply active state.
  Keep them as opaque evidence. Interpreting that abandoned staging model is
  unnecessary to preserve the authoritative `user_games` state. Record the
  preservation resolution without decoding or deleting a raw code.
- Five Wishlist tombstones already fit the applied preservation follow-up's
  explicit unknown-loss-instant shape. Remove the obsolete proposal-pending
  conflict; keep the loss instant NULL.
- Six historical family import counters are preserved independently of current
  reconstructed access counts. Keep both instead of claiming recomputability.
- All 404 purge-complete reviews remain in durable purge-review history. Do not
  manufacture completion-event rows. Existing events and their undo state stay
  authoritative. M5 must expose the five eventless historical review actions as
  legacy review history, without treating them as current completion or
  inventing an event/undo instant. This settles D-PRG preservation and avoids
  duplicate completion totals. The four undone events remain undone.
- P05 and live-view observation decisions are settled for this verified run.
  The final freeze must remeasure snapshot-dependent populations.
- The 13,232 withheld recommendation records fail only on
  `reco.game_preference_globals.total_hours`. A new additive migration may widen
  that specific column from `numeric(30,12)` to unconstrained `numeric`, retaining
  constraints/access controls and finite-source validation. Preserve the exact
  source numeric value without rounding. Other numeric columns stay unchanged
  unless a real failure demonstrates a need. This is approved for preparation
  and local validation; remote application is a separate integration step.
- Three unverified settings require source-key/read-write provenance review;
  neither copying credentials into preferences nor dropping values is allowed.
- Three family recency observations require a durable home that retains unknown
  subject/provenance. Never attribute them to the borrower merely to fill an
  activity row. Prefer an existing evidence destination; propose a minimal
  additive change if none fits.
- The nine import and 90 unknown-expiry cooldown rows already have preservation
  destinations. They impose production-activation holds. A proposed explicit
  isolated-rehearsal purpose may retain and report those holds while allowing a
  local copy; strict final-load/cutover checks must remain the default. Review
  that narrow gate distinction before performing any real-data target load.

The current correction batch owns these resolutions and related focused tests,
manifest/contract updates and additive SQL preparation. It must rerun real
preflight after the coherent changes and report any remaining concrete issue.

## Precision extension from preflight 12 — 14 September

After fixing `total_hours`, 12,673 of 24,757 real recommendation rows still
exceed the 12-digit fractional limit on `positive` and/or `total`: 12,418
positive, 3,847 total, 3,592 both. There are zero counter-order conflicts.
This is the same exact float8-decimal preservation issue, now demonstrated on
two additional columns. The coordinator approves widening those two columns
alongside `total_hours` in the new, still-unapplied correction migration.
Retain nonnegative/order checks, foreign keys, grants and RLS; explicitly reject
nonfinite numbers on the widened columns and keep exact parser/comparison
regressions. No other columns are in scope without further evidence. All five
already-applied migrations remain immutable. Remote application and the actual
real-data load remain separate integration gates.
