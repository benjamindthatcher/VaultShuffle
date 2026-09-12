# Claude parent coordination checkpoint — 11 September 2026

Owned by the Claude parent for the batches in
[the 11 September handoff](v2-claude-resume-20260911.md). Root owns the
architecture plan and [the execution ledger](v2-execution-status.md); this file
does not duplicate either. Shared interface contract:
[domain transforms](v2-claude-domain-transforms.md).

## Verified at dispatch

| Check | Result |
|---|---|
| Applied M3 SQL on disk | SHA-256 matches the handoff exactly |
| M1 and M2 | Unchanged, both original hashes intact |
| Migrations present | Three, M3 renamed to the applied `20260910232654` filename |
| Dirty user work | All three pre-existing modified files preserved |

```
605b72a3d9df1328ec27033c3420c1813a238f6e15bd8fc28f971cddaf30a24a  20260910232654_m3_preservation_schema.sql
```

**One discrepancy resolved, not carried.** The handoff states HEAD as
`79010ab3`. Actual HEAD is `b51dcd16`, "Align footer social links side by side".
The stated commit is its direct parent, so the user committed once more after the
handoff was written. Benign drift, and the user's footer work is preserved. No v2
commit or push was made.

## Root integration update, 11 September 01:47-01:49 UTC

Remote M3 schema and rollback fixtures pass: 92 tables and 991 columns exact,
all forced row-level security, browser access denied, and the runtime tenant test
passing with rolled-back membership. Evidence is
`database/v2/m3-target-validation-20260911.json`, which I confirmed records the
same migration hash, `production_changed: false`, `real_source_export: false`,
zero accounts and zero browser private privileges. No remote work is needed from
this side and none was done.

Root changed exactly one file, `database/v2/tests/m3_replay.sql`, replacing an
expired hardcoded recovery-hold date with a relative transaction clock plus
active and expired hold assertions. I verified the migration bytes are unchanged
and that relative-clock calls are now present, with the only remaining literal
timestamps being catalogue first-seen and last-seen fixture values rather than
the hold date.

**Fixture hash to record, not overwrite:**

```
ccd365080f0d1fce9d5bf6edf7bd1b984563479fea7a7a40fae049a0e7ad7719  database/v2/tests/m3_replay.sql
```

Two facts make this safe. That path is **not** in the catalogue agent's
ownership, so it cannot overwrite root's fix. And its brief regenerates the
sidecar and manifest from the files on disk, which already carry the corrected
version, so a recorded hash should match the value above. The parent verifies
this on return and raises a follow-up if the agent recorded a stale value.

Mid-flight relay to a running in-process subagent is not available in this
build; the only messaging tool addresses other sessions. This is why the value is
banked here rather than injected into the active agent.

## Three batches in flight

Disjoint file ownership, each Opus 5 at max effort, each with its own isolated
cluster on a distinct port under the shared read-only PostgreSQL 17.6 prefix.

| Batch | Owns | Task |
|---|---|---|
| Catalogue | `transform/games*`, `catalogue*`, `database/v2/migration/**` | Applied-state refresh, then one finished review |
| Library | `transform/library*`, `family*`, `history*` | Continue from saved files, finish tests and validation |
| Commitments | `transform/collections*`, `commitments*`, `draws*` | M3-G from current files, checkpoint first |

Complete and deliberately left stable: `accounts*`, `scalars*`, `sessions*`,
`capabilities*`, and the export and read modules. No agent may edit them.

### Applied-state refresh, pinpointed before dispatch

Five files still referenced the pre-apply filename `20260909214501` or the
superseded contract and SQL hashes, so the catalogue agent was given the exact
list rather than asked to search: the destination index builder with three
references, its generated sidecar with two, the manifest validator test with one,
and both the M3 contract and checkpoint documents. It regenerates at the
immutable applied hash and reruns the 119-test baseline. Relation and column
totals are verified locally rather than copied, because root records that the
first remote tally omitted the support schema and all six private schemas should
reach 92 relations and 991 columns.

### Dependency managed rather than serialized

The commitments batch consumes three interfaces it does not own: the game map
from the catalogue owner, the library-row map from the library owner, and the
catalogue exact-value helpers. Collections, pins, snoozes and vault state all
address a game by the legacy per-account library UUID rather than by AppID, so
the library-row map is its critical dependency. It codes against the published
interfaces immediately and must report explicitly if a concrete implementation
was unavailable, rather than substituting one of its own.

## Standing position

All migration SQL is immutable and applied. Every agent is told that a physical
gap is a finding for root, never permission to change SQL and never a reason to
fabricate a value so a row fits an immutable bound. No remote or source query,
export, snapshot, credential, auth mutation, target load or apply, provider
activation, application or deployment change, package change, commit or
production write is authorized in these batches, and none has occurred. The
Supabase connector may be absent; no callable access is assumed.

Dated source aggregates are treated as observations throughout, never as parity
and never as preconditions in code.

## Not complete

M3 remains incomplete. A consistent real export, all transforms, independent
per-account parity, reconciliation and checksums, and measured storage are all
outstanding. Later domains not in these batches: duration and provider evidence,
configuration, recommendation, support and operations transforms, the staged
loader, and the parity harness.
