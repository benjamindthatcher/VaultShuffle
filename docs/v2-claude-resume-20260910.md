# Claude ownership return — 10 September 2026

> Superseded for ownership at **03:29 UTC**: Claude exhausted its allowance
> again and all native tasks stopped. Its task-specific auto-continue is
> disabled. The existing three max Luna workers now own their original paths.
> Keep the acceptance requirements below, but do not restart Claude workers
> until the coordinator returns ownership using the latest execution ledger.

Codex coordinator handoff at approximately 03:02 UTC. The user says Claude's
usage is back and wants Claude as the primary worker while allowance remains.
All three max Luna agents have now **errored at the Codex usage limit**. None
is actively editing. This supersedes the earlier queued message telling Claude
to wait for ownership: ownership is now returned as set out below.

Keep parent Opus 5 / Ultracode and native implementers Opus 5 / max. Reuse useful
context, but read the actual saved files before continuing: there has been
substantial work since your last session. Do not repeat the completed audit or
browser investigation. Use three bounded agents with these disjoint scopes and
let them debug/test autonomously. Bank finished layers and checkpoint them.

## Exporter

Own `lib/v2/migration/export/**`, `lib/v2/migration/shared/**`,
`docs/v2-export-contract.md`, `docs/v2-export-checkpoint.md`.

Baseline is now 58 exporter/shared unit tests passing, typecheck and targeted
lint passing. Synthetic TLS tests cover CA/hostname/plaintext rejection,
timeouts and SCRAM vector/proofs; an opt-in path-only CLI and real inventory
plan loader were added. The older PostgreSQL integration passed 19 tests, but
that predates the new mid-COPY failure case. The original shared fixture cluster
became unavailable; this does not block a new isolated fixture.

Complete these coordinator review requirements before returning:

1. Initialize a **new isolated local PG17 cluster**, data directory/socket/port
   under `/tmp`, and recreate the documented synthetic source/target fixtures.
   Allow explicit test path/port overrides if necessary. Do not stop or repair
   another worker's cluster or any M1/M2 evidence database. Run the final actual
   integration including mid-COPY failure and cleanup. No skipped gate.
2. Fix the authentication state machine. Current reviewed code accepted any
   `ReadyForQuery` without requiring `AuthenticationOk` or, once SCRAM starts,
   a verified `AuthenticationSASLFinal`. Async handlers were not serialized, so
   coalesced/out-of-order frames could race PBKDF2. Require ordered auth states;
   test premature/missing/bad proofs and coalesced messages. Do not settle auth
   success until the required protocol and server proof are complete.
3. Remove **all freeform PostgreSQL server error text** from runtime diagnostics
   and FAILED.json. `M` text can quote arbitrary private values; regex redaction
   of emails/tokens is not sufficient for a private note. Retain allowlisted
   SQLSTATE and stable local error messages. Test an arbitrary private sentinel
   in server M/detail/hint/context that cannot appear in output or failure files.
4. For real inventory plans, validate the **whole expected inventory scope inside
   the snapshot**, including newly added/removed tables, relation kinds,
   nullability and constraint drift, not only planned column names/types. An
   explicitly narrowed export must still validate the full disposition scope.
   Synthetic narrow fixture plans may be explicitly partial. Coordinate with
   the manifest agent's strengthened gate rather than inventing a conflicting
   schema representation.

Fix any additional concrete issue revealed by these tests. Do not assert that
custom PG wire code was intrinsically necessary: libpq can keep passwords out
of argv via private files, and raw COPY streams are available through libraries.
The existing implementation is accepted for continued validation, not for an
unproven security claim. Remote auth/pooler compatibility remain unmeasured.

## Physical database

Own `database/v2/M3-contract.md`, the single new migration
`database/v2/supabase/migrations/20260909214501_m3_preservation_schema.sql`,
`database/v2/tests/m3*.sql`, and `database/v2/M3-checkpoint.md`.

The migration is now **1,272 lines**, and `m3.sql`, `m3_replay.sql` and
`m3_security.sql` exist. Its checkpoint still incorrectly says the file is
empty: inspect actual files and finish the implementation/validation, do not
start again or generate a duplicate migration. No accepted final replay/hash
exists yet. Read all binding rulings in `docs/v2-m3-b-database-batch.md` and
`docs/v2-m3-capability-decision.md` (including new measured audit evidence).

Keep the stable project marker's schema value **m1**, as the existing foundation
contract specifies; migration history tracks applied schema advancement. Remove
the draft's widening/advance-to-m3 unless you present a concrete cross-domain
reason and all caller/test changes for coordinator review first. The root has
not approved that contract change. Avoid broad grants on all existing app
sequences; prove existing ACLs unchanged and scope any new grants to named new
objects. Finish meaningful constraints, RLS, deletion/retention, idempotency and
fresh replay tests as target-like NOSUPERUSER postgres on an isolated database.
Return exact final hash, contract and evidence, with remaining data decisions.

## Manifest/probes

Own `database/v2/migration/**` and `docs/v2-m3-probes-checkpoint.md`.

This worker saved a completed checkpoint despite its final turn hitting the
limit. It reports 20 probe-safety and 50 manifest tests passing, public probe
replay with adversarial synthetic rows, and correct strict final-load rejection
of 177 unresolved columns / 34 relations with open decisions. The fixture used
`/tmp/vaultshuffle-m3-probe-socket`, port 55434, database
`vaultshuffle_m3_probe_fixture_20260910`; database and temporary reader role were
removed, and cluster cleanup remains to be checked. Preserve that evidence.

The remaining task is to integrate destinations with the **actual completed
physical contract**, close decisions already settled by the plan/coordinator,
and retain only actual unresolved source-value/cutover checks. Review the code
and fixture evidence once; do not redo the broad source audit. Coordinate whole
snapshot schema coverage with the exporter. The final-load mode must remain
fail-closed until actual snapshot dispositions are all resolved.

## Standing boundaries and return

M1/M2 immutable. No source query/mutation, credentials, temporary source role
refresh, password reset, remote apply, real export, provider activation, package
changes, deployment, environment switch, paid resource or commit in this batch.
Root retains the architecture plan, execution ledger, remote operations and
integration signoff. Existing local-only synthetic testing is authorized, including
new isolated temporary PG clusters. No arbitrary additional permission barrier
is needed for that already-authorized work.

The Claude parent may continue updating its readiness report, M3-A checkpoint
and coordinator-feedback resolutions. These were never assigned to the Luna
workers. Source growth since the plan baseline is live drift, not evidence of
loss or a reason to rerun old audits; dated aggregates are observations and the
real snapshot must establish final parity.

`docs/v2-export-access-followup.md` closes the access investigation: management
audit access is not a PG streaming credential. A documented temporary read-only
CLI login is a possible later path, but it changes source authentication state
and has not been authorized or called. Do not repeat the browser/CLI audit or
claim a production-password reset is the only path.

Return the completed integrated batches, tests and exact remaining blockers.
Update each current checkpoint before any usage interruption. M3 is still
incomplete until real export, transforms, independent per-account parity,
reconciliation and storage measurement pass. Root is waiting patiently in
25-minute event-driven batches, per the user's explicit request.
