# M3-D identity transform checkpoint

Status: bounded pure scalar/account identity layer implemented and tested. No
M3 completion claim and no target/source action was performed.

The completed layer covers:

* exact signed integer and finite decimal parsing with explicit bounds, source
  text retention, and stable non-finite/overflow codes;
* UTC/fixed-offset PG17 timestamptz parsing through six microseconds, exact
  comparable epoch values, NULL preservation, canonical UTC rendering, and
  independent civil-date/leap validation;
* explicit run/snapshot identity validation and optional row identity checks;
  required run and snapshot hash fields reject absent/non-string values before
  regex evaluation, with stable redacted failures;
* complete `app_accounts`/`app_users`/`manual_steam_profiles` union validation;
  deterministic `(created_at, UUID)` numbering; exact Steam ID round-trip;
  separate login/visit instants; target default revisions; and unique map
  directions;
* profile-less manual roots, shared unverified manual Steam IDs, verified
  collision failures, metadata blockers, and redaction-safe stable errors;
* deleted `merged_existing` source tombstones with required provenance,
  deterministic placement, `lifecycle_status = 'deleted'`, no profile and no
  verification; a tombstone map preserves the deleted UUID with
  `source_kind = 'unknown'` rather than claiming a live `app_accounts` row; and
  private merge evidence for the later ops writer.
* independent scalar regressions for signed numeric bounds, zero/fraction
  comparisons, pre-epoch microseconds, UTC day/year crossings, and 1900/2000
  leap behavior.

Files owned by this checkpoint:

* [`scalars.ts`](../lib/v2/migration/transform/scalars.ts)
* [`accounts.ts`](../lib/v2/migration/transform/accounts.ts)
* [`scalars.test.ts`](../lib/v2/migration/transform/scalars.test.ts)
* [`accounts.test.ts`](../lib/v2/migration/transform/accounts.test.ts)
* [`v2-m3-identity-transform-contract.md`](v2-m3-identity-transform-contract.md)

Validation completed on 2026-09-10:

```text
node --experimental-strip-types --test lib/v2/migration/transform/scalars.test.ts lib/v2/migration/transform/accounts.test.ts
20 tests passed, 0 failed

npx eslint lib/v2/migration/transform/scalars.ts lib/v2/migration/transform/accounts.ts lib/v2/migration/transform/scalars.test.ts lib/v2/migration/transform/accounts.test.ts
passed

npx tsc --noEmit --pretty false --target ES2020 --module ESNext --moduleResolution bundler --strict --skipLibCheck --esModuleInterop --allowImportingTsExtensions --types node lib/v2/migration/transform/scalars.ts lib/v2/migration/transform/accounts.ts lib/v2/migration/transform/scalars.test.ts lib/v2/migration/transform/accounts.test.ts
passed
```

The repository-wide typecheck passes on the current shared tree. The identity
files also pass the targeted strict typecheck above. The downstream sessions
adapter must still treat an `account_map` row with `source_kind = 'unknown'`
as a deleted-source tombstone rather than as a live `app_accounts` root; that
cross-domain adjustment remains with the session worker.

Remaining integration work is downstream: the loader must pass the verified
export manifest identity, load these records before foreign-keyed phases, and
write the later capability/profile evidence and merge audit destinations. The
actual export must rerun profile presence, verified identity, and tombstone
checks. No current source counts are treated as a freeze/export result. The
current physical proposal is bound by the manifest checkpoint's SQL hash
`605b72a3d9df1328ec27033c3420c1813a238f6e15bd8fc28f971cddaf30a24a` and
contract hash
`46e9b982395cb2800da1247d22afc43de0e1cc3e99df1fc632a7b032142a3577`; those
hashes are recorded here for coordination and do not claim a source export or
final cutover.
