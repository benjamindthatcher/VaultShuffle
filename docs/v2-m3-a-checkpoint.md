# M3-A delta checkpoint

Claude batch lead · 9 September 2026 · branch `codex/v2-architecture`.
Companion to [the M3-A assignment](v2-m3-a-batch.md) and
[the readiness audit](v2-claude-m3-readiness.md). This file records only the
delta since the assignment; it is not a second ledger and does not replace
[the execution status](v2-execution-status.md), which remains untouched.

## Current state

Rewritten 10 September after ownership returned from the Luna workers. M3-A is
closed; M3-B is in flight. Run 1 and run 2 history is at the foot of this file.

| Deliverable | Owner | State |
|---|---|---|
| Readiness report, 15 sections | Batch lead | **Complete**, corrected twice |
| Access findings and follow-up | Closed | Management audit access is not a streaming credential |
| Disposition manifest, 44 relations / 486 columns | Manifest agent | Complete, destinations being integrated |
| M3 migration, 1,272 lines / 48 relations | Database agent | Written, **two known defects**, unapplied |
| Physical contract, SQL tests | Database agent | In flight |
| Exporter | Exporter agent | **Complete and independently verified** |

The M3 migration exists at
`database/v2/supabase/migrations/20260909214501_m3_preservation_schema.sql`,
1,272 lines creating 48 relations. It has been applied nowhere. Two defects were
located by the batch lead and handed to the database agent with exact lines: the
draft widens the project marker check and advances it to `m3` at lines 18-22 and
1270-1271, which the root has not approved and which must stay `m1`; and line 1259
grants on **all** existing sequences in schema `app`, where every new grant must be
scoped to named new objects with existing ACLs proven unchanged.

Both frozen migration hashes were reverified unchanged at handoff.

## Exporter accepted, 10 September

Re-run by the batch lead rather than accepted on report: 81 unit tests pass, 29
real PostgreSQL integration tests pass against the fresh cluster, typecheck clean.
The earlier 74 and 21 are preserved inside those totals; no prior case was dropped.

The gate it closed was a genuine silent-loss hole, and the agent demonstrated it
instead of describing it. With the guard removed, an export run by a non-owner
without bypass rights against a table carrying a selective policy **finalized
successfully**: a sealed, internally consistent run manifest marked complete,
reporting 40 rows of a 100-row relation with a matching checksum. Nothing in the
output would have revealed the loss.

The fix sets `row_security = off` transaction-locally as the first statement of the
export transaction, ahead of the watermark and every copy, reads the value back
from the server rather than assuming it, and refuses with `row_security_not_disabled`
unless the server confirms it. It re-reads at close and refuses with
`row_security_changed_mid_export` if it moved. This does not bypass row security;
it converts a silently filtered read into an error, which is why PostgreSQL uses
the same setting for complete backups. The effective setting and the role's
superuser and bypass attributes are recorded in the run manifest, as `boolean | null`
so an unreadable attribute never reports a reassuring false.

Six real scenarios pass, each measuring the true filtered subset first so none can
pass vacuously: selective policy, default deny, forced row security against the
owner, a mixed plan where an already-completed relation is left unsealed, a
positive full-visibility control, and guard lifetime after commit. Mutation testing
confirmed the tests bite: weakening `SET LOCAL` to `SET`, moving the guard after the
watermark, recording without refusing, and removing it entirely each produced
failures.

Verified by the batch lead directly: no role mutation exists in exporter runtime
code. The only superuser and bypass references read `pg_roles` attributes into the
manifest. No source role was granted bypass rights and no remote role, policy or
table was touched.

Run manifest version moved from 1 to 2, with the row-security object required
rather than optional. No version 1 manifest exists anywhere, since the exporter has
never touched a real source. This is the exporter's run manifest and is distinct
from the disposition manifest under the migration tooling directory.

## Measured source evidence, 9 September

Dated aggregates from read-only transactions, no row values returned. These are
observations, **not** parity proof: the source is live and account count has drifted
from 630 at the plan baseline to 684, so the real snapshot must recheck all of it.

Measured **zero**: orphan lender links; over-cap families, maximum four; decoded
digest collisions across both session tables; unresolved completion identities;
invalid session hex or expiry ordering; required merge tombstones, all five merge
rows retain their source accounts.

Measured **non-zero**: exactly one collection with duplicate positions; two manual
accounts missing profiles, confirming the discrepancy the audit raised; 183 accounts
whose account-side and profile-side visibility triples disagree, with 271 differing
checked-at times.

Playtime resolved cleanly: all 365,610 owned library rows carry exact minutes and
none disagrees with the decimal hours formula; all 1,563 family rows have unknown
minutes and zero hours; all 62 pin baselines convert to whole minutes. The authored
`hours_played` write path the audit found is real, but its divergent population is
currently empty.

Stale staging holds 24,428 rows with measured completion and recency discrepancies.
It remains reconciliation evidence and never transform authority.

## Corrections applied to the readiness report

Beyond the twelve the verification pass found, two more from coordinator rulings:

1. **`algorithm_weights`** is hand-tuned operator configuration, not learned
   warm-start evidence. The plan's original grouping was right.
2. **Visibility booleans.** The report guarded only NULL. A legacy `false` also
   means no positive hours or no reported last-played value, not provider privacy,
   so `false` and NULL both project unknown while only `true` projects visible.
   Treating `false` as hidden would manufacture a privacy assertion the source never
   made. Visibility precedence is resolved from the actual writer and reader paths,
   not by taking the newer row.

## Tests

Real results, run by the batch lead on 9 September:

| Command | Result |
|---|---|
| `node --experimental-strip-types --test lib/v2/migration/shared/*.test.ts` | **30 pass, 0 fail** |
| `npm run typecheck` | **Passes** after one fix |
| `python3 database/v2/migration/manifest/build_manifest.py --check` | **exit 0**, 44 relations / 486 columns up to date |
| `python3 database/v2/migration/validate/validate_manifest.py` | **exit 0**, every column dispositioned |
| `python3 -m unittest discover -s database/v2/migration/tests` | **58 pass, 0 fail** |

All five re-run independently by the batch lead, not accepted on the agent's report.
Both frozen migration hashes reverified unchanged after the run.

Column coverage is 44/44 relations and 486/486 columns, summing exactly: preserved
50, transformed 59, derived-retirement 101, audit-archive 99, unresolved-decision
177. Coverage is generated from the inventory, so a missing decision is a build
error with no default path. A negative control with one disposition key deleted
fails with exit 1 and names both the column and the resulting total mismatch.

Probe safety was audited directly rather than trusted: no DDL or mutation keyword
appears anywhere in the probe directory, and the two fragments that select columns
are both safe. The digest-collision probe wraps an `INTERSECT` of the two session
tables inside `count(*)`, so no digest is ever returned. The playtime probe is a
bucketed aggregate grouped by access source with no per-row values. All ten
non-public schemas carry an assessed disposition.

The 30 exporter tests cover the credential-safety layer: that a secret survives
neither interpolation, nor `JSON.stringify`, nor `console.log`, nor `util.inspect`;
that redaction masks URI userinfo, keyed secrets, JWTs, key prefixes, hex digests
and emails, and truncates oversized driver output; that errors never carry a
credential; and that private-mode enforcement rejects non-owner permission bits.

One defect found and fixed during integration: `export-snapshot.integration.ts`
passed a `spawnSync` env object omitting `NODE_ENV`, which this project's augmented
`ProcessEnv` requires, breaking typecheck. Fixed in place with the minimal-env
rationale preserved as a comment.

**The integration test has never been executed.** Its 566 lines are unproven, and
no claim about snapshot isolation, abort behaviour, permissions, bigint bounds,
UTC/DST or civil dates is yet evidenced.

**No probe has ever been parsed by PostgreSQL.** They are validated only by the
safety tests, so a syntax error would not yet have surfaced. No source data has been
read, so every conflict count in readiness sections 4 and 14 remains potential
rather than measured, and the conflict report is empty. No DDL has been compiled,
applied or tested anywhere; every proposed column exists only as text in the
contract.

## Stopped at, and next action

M3-A is closed. M3-B is in flight with three native implementers at Opus 5 / max,
on disjoint paths: the physical database agent owns the migration, contract, SQL
tests and its checkpoint; the exporter agent owns the export and shared modules and
their contract and checkpoint; the manifest agent owns the migration tooling
directory and its checkpoint. The batch lead owns this file, the readiness report
and the coordinator-feedback resolutions, and touches none of the three scopes.

One sequencing dependency is managed rather than avoided: the manifest agent must
link dispositions to destination names that the database agent is rewriting right
now, so it does that step last and records the gap rather than guessing.

## Standing constraints observed

Production read-only throughout; no connection of any kind was made to it. No
credential reset, source-role provisioning, deploy, environment or configuration
change, or paid resource. `cli_login_postgres` was not refreshed, provisioned,
granted, reset or altered, and no Supabase CLI command was run against the source.
No secret, session digest, email address or user row has entered a file, a log or a
transcript. The frozen migrations, architecture plan, main execution ledger, package
files, existing runtime and import contracts and every pre-existing dirty user file
remain untouched.

One standing narrowing: no subagent may extract or store a credential, including
into a private local file. The access document tells the user what to place and how.

## History: run 1 (superseded, retained for context)

| Subagent | Model / effort | Terminated by | Files produced |
|---|---|---|---|
| Export | Opus 5 / max | Session rate limit (429) | 3 files, 425 lines |
| Schema and manifest | Opus 5 / max | Stall, no progress for 600s | none |
| Browser and access | Opus 5 / max | Session rate limit (429) | none |
| Report verification | Opus 5 / max | Session rate limit (429) | none (read-only by design) |

None of these were logic failures. Three hit the account session limit and one
stalled on a stream watchdog.

**Resume handles are dead.** The parent session restarted after the failures, so
the run-1 agent identifiers are unreachable; `ListAgents` reports no reachable
agents. Continuation is by fresh spawn pointed at the saved files, not by
resuming a handle. Run-2 agents are briefed to read what run 1 left and extend
it rather than rewrite it.

