# M3 local loader checkpoint

Updated: 11 September 2026

## 12 September resume and delegated file boundary

Root's acceptance review found the pre-commit, immutable-schema, source-count,
run-replay and sequence-proof defects in the initial loader. Batch C retains
ownership of staging, target transactions, gates, reconciliation and the PG17
harness. To shorten the all-domain integration critical path, the completed B
worker is assigned the independent new files
`lib/v2/migration/load/all-domains.ts` and
`lib/v2/migration/load/all-domains.test.ts` only: it will assemble every frozen
A/B transform into target batches, complete source accounting and blocker/
withheld streams. It may propose contract additions in its return but must not
edit other loader files. This transfer is mirrored in B's checkpoint before it
starts.

## Scope and safety boundary

Batch C owns only `lib/v2/migration/load/**`, its synthetic fixtures/harnesses,
this checkpoint, `docs/v2-m3-loader-contract.md`, and
`docs/v2-m3-local-runbook.md`. Existing exporter, verified reader, transforms,
SQL migrations, manifest files, and package scripts remain read-only.

This work is local and synthetic only. Real and remote execution, implicit
environment/profile/secret discovery, target DDL, commits, and pushes are not
authorized. Synthetic evidence can never satisfy a real-source or cutover gate.

## Completed phase: contract discovery and foundation freeze

- Read the complete 11 September dispatch, architecture migration sections,
  verified-reader contract and implementation, export contract/plan, applied M3
  bookkeeping schema, transform public interfaces, and existing PG17 harnesses.
- Confirmed the reader may emit callback rows before detecting terminal stream
  corruption. The loader will therefore stage to a private disposable directory
  first, delete it on any stream failure, and start target mutation only after
  every staged relation is verified.
- Froze an explicit execution boundary: callers must provide a local Unix-socket
  target descriptor and every fingerprint/evidence value. There will be no URL,
  environment, profile, credential, project-ref, or remote transport fallback.
- Requested the frozen preservation/provider schema and output contract from A.
- Received B's frozen high-level entry points: `transformRecoConfigBatch`,
  `transformSupportOpsBatch`, and `transformLegacyOperationsBatch`, all using the
  same run identity/account map and GameMap as applicable and returning sorted
  target records plus `conflicts` and `blockers`. Exact field integration awaits
  B's committed files/contract.

## Next exact action

Implement and unit-test the private verified staging store, strict target/COPY
contract, local-only transactional psql adapter, run/fingerprint/replay guards,
and canonical reconciliation accumulators. Then add the concrete legacy program
and actual PG17 end-to-end/fault-injection harness, integrating A/B only after
their contracts are frozen.
