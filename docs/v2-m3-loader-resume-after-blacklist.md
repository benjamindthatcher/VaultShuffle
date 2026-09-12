# M3 loader resumption after Blacklist

Root coordination packet, 12 September 2026. Resume only after the permanent
Blacklist schema, transforms, runtime and UI gates finish. This packet records
known acceptance gaps; it is not a claim about the current partial code.

## Assignment and boundary

Assign one Sol agent with high effort to the existing
`lib/v2/migration/load/**` implementation, its local synthetic tests, and the
loader checkpoint/contract/runbook. Maximum two active agents; no worker may
delegate. The old `m3_local_loader` stopped on allowance. Reuse it if available,
otherwise give its on-disk work to one replacement. Preserve completed Claude
and Codex changes and the user's `0b2c934` baseline.

No production writes, remote load, implicit credentials/environment discovery,
source CLI authentication, commits or pushes. Read the completed Blacklist
database checkpoint first and integrate its final physical contract. Existing
exporter, verified reader, transforms and immutable SQL are read-only unless a
concrete cross-domain defect is returned to root.

## Known gaps from the last completed root review

1. `pipeline.ts` wrote `migration.runs` and called `applyLoadPlan` before
   `evaluateGates`. Validate the complete verified stage and every blocker
   before committing target data; prove failure leaves no target mutation.
2. The expected schema fingerprint was derived from the target being checked.
   Pin independent expected schema/migration evidence and prove drift fails.
3. Per-target counts summed every staged source relation. Account for each
   source relation's actual preserved, archived, retired, withheld and blocked
   dispositions, including many-to-one and one-to-many outputs.
4. Replay upserted the current phase without checking immutable run identity.
   Reject different source/schema/transform fingerprints for the same run.
5. The integration fixture manually called `setval`. Prove the loader itself
   resets identities correctly after explicit identity values are loaded.
6. The integration run preseeded accounts and loaded only a subset. Build a
   nonempty all-domain fixture through the real assembler/loader into fresh
   PostgreSQL 17, without bypassing the loader to seed required domain rows.
7. Reader callbacks can occur before terminal stream verification fails.
   Stage privately with bounded memory, verify every complete stream, and
   delete failed stages. A corrupt final chunk must not leave committed rows.

## Assembler defects already sent to the stopped worker

`all-domains.ts` and its tests were a draft transferred from B; its six mostly
empty-inventory tests were not acceptance evidence. Check whether the partial
code already repaired each issue before changing it:

- `account_capability_evidence`, `unknown_completion_history` and
  `completion_event_registry` are in `app`, not `migration`.
- Use `migration.legacy_collection_membership_evidence`; the draft named a
  nonexistent alternative. `migration.draw_map` does not exist.
- `loadedRows = sourceRows`, zero archives and zero conflicts conceal actual
  transform dispositions. Count unresolved conflicts by their resolution.
- Normal derived guest-pool rows are not exception blockers.
- Remove casts/dynamic collectors that conceal incompatible output shapes or
  silently drop fields. Validate every required physical target column.
- Build the complete AppID mapping union, not only one source spelling.
- Exercise all 44 source relations with nonempty meaningful rows and exact
  scalar/bytea/JSONB handling, account capability boundaries, real COPY
  identity override, per-account sets/checksums, rollback and replay faults.

## Accepted work to reuse

The exporter and terminally verified reader already have actual PostgreSQL
round-trip evidence. Preservation/provider and remaining-domain transforms
have completed unit/integration gates. Reuse their public contracts and exact
scalar helpers. `timestampFromEpochMicros` avoids lossy JavaScript Date
retention calculations. Credential-like/unknown settings remain nonloadable
withheld evidence and mandatory blockers. Never silently round overflowing
numeric counters or drop provider evidence without a durable disposition.

## Completion evidence and next external prerequisite

Update the loader checkpoint early, at meaningful phase completion, and before
stopping. Record commands, result counts, actual tested failure boundaries,
remaining defects and the next exact action. Root reviews a completed batch,
not repeated intermediate diffs.

Local synthetic success is not M3 completion. A real consistent export still
requires an explicitly supplied private PostgreSQL credential with verified
TLS and full row visibility. Only legacy HTTP credentials have been found;
do not repeat broad secret searches or provision a source login role. Real
export, source-dependent decisions, rehearsal parity and measured storage are
still separate gates. Both source Ireland and target Virginia use UTC; no
geographic timestamp offset is appropriate.
