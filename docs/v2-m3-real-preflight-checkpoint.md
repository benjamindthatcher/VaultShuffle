# M3 real-snapshot offline preflight checkpoint

Updated: 14 September 2026

## Scope and boundary

`lib/v2/migration/load/real-preflight.ts` is a reusable offline preflight for a
completed real export on private local disk. It uses the accepted terminal
reader, private staging and `assembleAllDomains`. It has no source connection,
target descriptor, PostgreSQL client, target write or publication path.
Staging is destroyed on every exit. The report parent must already be owner
only; the work directory is `0700` and the create-once report is `0600`.

The driver refuses `.partial`, `INCOMPLETE`, unexpected relation files,
manifest/source/schema mismatch, row/count/hash mismatch, and a supplementary
view sidecar that is not owner only and bound to the same run, UTC transaction
watermark and manifest SHA256. Reports contain fixed relation names, aggregate
counts and stable error classes, with no row payloads or private identifiers.

The default staging ceiling remains 256 MiB. This real preflight explicitly
uses the approved configurable 1 GiB ceiling. Rebuild-only source views are
verified, hashed, counted and staged without reconstructing their unused rows,
so the 495 MiB view neither escapes accounting nor exceeds V8's string limit.
The transform fingerprint uses the existing framed streaming checksum rather
than building a million-row JSON string.

## Actual completed-snapshot result

The final grouped run used the immutable completed export and its bound view
sidecar at the export transaction watermark. The private report is:

`/private/tmp/vaultshuffle-m3-export-20260913/preflight-13/real-preflight-report.json`

The reader verified **44 relations, 486 columns, 1,048,426 rows and all 44
file hashes**. Both public view definitions were verified. The all-domain
transform completed, emitted 60 diagnostic target batches totalling 2,090,426
candidate rows, found no missing target relation, and performed zero writes.

The real-source diagnostics remain stable:

- P05 has 378,513 owned rows with exact minutes and zero disagreements with
  the legacy JavaScript rounding path. The 1,796 family rows have unknown
  personal minutes and are never attributed to the borrower.
- All 68 pin baselines are finite, nonnegative and exactly convertible. Of
  13,401 completion rows, 401 have null hours, 772 have null estimates, 401
  have null prices, 401 non-null hours are not whole minutes, and none is
  nonfinite.
- All 404 purge-complete reviews remain review history. Nine lack an active
  completion event: four have undone-only event history and stay undone; five
  have no event ever. The five eventless reviews split into the already
  measured current library status aggregate without creating events.
- The snapshot contains 657 imports, including nine in flight. It contains 90
  cooldown rows whose expiry cannot be computed because the caller-specific
  window duration is absent.
- All 24,769 dedicated catalogue sighting rows overlap catalogue rows. Import
  counts agree; the two independent timestamp timelines differ systematically
  and are preserved in their separate destinations under the settled rule.

Settled representation and preservation corrections now pass the real
population: numeric tag objects, independent sighting timelines, dismissal
hours converted exactly to target minutes while raw hours remain evidence,
duration-import `completed` mapped to target `succeeded`, opaque stale
codebooks, unknown wishlist loss instants, historical family import counters,
and purge review history without synthetic completion events.

The recommendation transform now preserves every one of the 24,757 global
game rows. Preflight 12 proved that `numeric(30,12)` could not retain exact
float8 text for 12,418 `positive` values and 3,847 `total` values, with 3,592
rows overlapping and zero order conflicts. Together with the earlier
`total_hours` finding, this justifies the new unapplied migration
`20260913220031_m3_reco_game_precision.sql`. It widens only those three columns
to unconstrained numeric, retains nonnegative and ordering checks, and adds an
explicit finite-value check. The exact parser and comparison do not use a
JavaScript number.

After that correction, recommendation withheld counters are zero. The only
unresolved transform conflict is the three-row family playtime population
whose subject cannot be assigned safely. The only preservation blocker is the
three unverified compatibility-setting rows. A review-only additive proposal
at `database/v2/proposals/m3_real_preflight_evidence_followup.sql` provides
separate durable, account-scoped evidence homes for those two populations;
transform wiring waits for root schema review.

The remaining two blocker classes are production activation holds: 90 cooldown
rows with unknown expiry and nine imports in flight. The proposed isolated
rehearsal purpose may continue to report and ignore only these two holds after
their rows are proven preserved. The ordinary/final-load purpose remains
strict, and M6/M7 must remeasure the final freeze. This purpose distinction is
documented for review and is not implemented or used here.

Explicit remaining gates are:

- review and apply the local recommendation precision migration before any
  target load;
- review the two-table evidence proposal, then wire the three family and three
  compatibility-setting rows to it;
- settle support retention;
- review the narrow isolated-rehearsal activation-hold contract;
- perform a new final freeze with an approved cooldown duration and zero
  in-flight imports before publication.

## Verification

- Focused transform/loader tests: 164 passed, 0 failed.
- PostgreSQL 17 migration replay: the five immutable migrations plus the new
  correction applied successfully in a disposable local database. Two focused
  integration regressions passed, proving exact long-decimal/exponent storage,
  nonfinite and inverted-counter rejection, unconstrained types, forced RLS,
  two foreign keys, two indexes and the existing read policy. The disposable
  database was removed afterward.
- Manifest validator regressions: 100 passed, 0 failed. Destination index and
  disposition manifest build and check cleanly at 44 source relations / 486
  columns; the precision migration remains explicitly unapplied.
- TypeScript and focused ESLint pass; `git diff --check` passes.

Replay into a fresh owner-only report directory with:

```sh
node --experimental-strip-types lib/v2/migration/load/real-preflight.ts \
  --run-directory /absolute/private/completed-run \
  --view-sidecar /absolute/private/completed-view-sidecar.json \
  --work-directory /absolute/new/private/preflight-directory
```

Success prints only the transform state and zero target writes. Nothing in this
checkpoint claims a final freeze, remote migration application, load approval,
target parity, zero production holds or cutover approval.
