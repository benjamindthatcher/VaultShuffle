# M3 real-preflight gate corrections

Updated: 13 September 2026

This packet records the correction batch following completed offline preflight
11. It authorizes no remote migration, real-data target load, final freeze or
cutover.

The stale state codebooks, Wishlist retirement rows, family import counters and
purge-complete reviews are preservation-complete under the root rulings in
`docs/v2-m3-rehearsal-evidence.md`. Raw stale codes remain opaque durable
evidence and never become active state. Wishlist loss instants remain unknown.
Historical family counters remain independent of current access counts. Purge
complete actions remain durable review history only; existing completion events
and undo state remain authoritative.

The verified P05 population closes active playtime precedence for this snapshot:
owned exact minutes are authoritative, legacy hours remain separate evidence,
and family measurements are never attributed to the borrower. The final freeze
must repeat the population check. The export-bound view-definition sidecar
closes the live-view observation for this snapshot; the final freeze must bind
the definitions again.

The real settings population contains three non-credential compatibility keys.
Repository history identifies their concepts as current vault selection,
snoozed game identifiers and wishlist pin identifiers, each now represented by
a normalized source relation. Private comparison found all three parseable but
none equal to the corresponding normalized snapshot state. They therefore
cannot be dropped as redundant or copied into runtime preferences. The private,
value-free finding is
`/private/tmp/vaultshuffle-m3-export-20260913/preflight-settings-analysis.json`.

The existing schema has no durable evidence-only home for those settings or for
the three unknown-subject family recency measurements. The review-only proposal
`database/v2/proposals/m3_real_preflight_evidence_followup.sql` supplies two
account-scoped tables with deletion, export, RLS and ACL handling. The family
table fixes subject attribution to `unknown` and has no route into personal
activity, recommendations or access. The compatibility-settings table requires
JSON string values and is not a runtime preference store. Transform wiring waits
for root schema review.

`database/v2/supabase/migrations/20260913220031_m3_reco_game_precision.sql`
is a separate locally prepared, unapplied correction. It changes `positive`,
`total` and `total_hours` on `reco.game_preference_globals` from
`numeric(30,12)` to unconstrained `numeric`, after the real snapshot proved all
three fields need the extra fractional precision. Exact finite source text is
parsed without a JavaScript-number round trip, existing nonnegative/order
checks remain, and a new target check excludes nonfinite numeric values. Other
recommendation numeric columns do not change.

For a future isolated local real-data rehearsal, cooldown rows and in-flight
imports remain named production-activation holds in the report. A rehearsal
purpose may ignore only those two activation hold codes after verifying their
rows are preserved, while every data-preservation exception, unresolved
conflict, missing target relation and other blocker remains fatal. The ordinary
loader and final-load purpose stay strict. M6/M7 must rerun the final freeze and
require zero active imports plus an approved cooldown window before publication.
