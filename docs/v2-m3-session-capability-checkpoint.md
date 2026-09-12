# M3-E session and capability transform checkpoint

Checkpoint started 10 September 2026. This file records the bounded pure
transform work owned by the export/reader worker. It does not claim M3
completion or a real source export.

## Completed layers

### Shared run/account-map boundary

Implemented in `lib/v2/migration/transform/sessions.ts`:

* explicit `TransformRunIdentity` using `runId`, identity-worker-compatible
  `snapshotHash`, and labelled `observedAt`;
* case-insensitive UUID joins with bounded account/target uniqueness checks;
* exact snapshot hash decoding and same-run checks;
* `accountMapFromIdentityResult`, which consumes the identity worker's
  `run_identity`, `accounts`, `steam_profiles`, and `account_map` result without
  duplicating account numbering or scalar parsing, including the identity
  worker's explicit deleted-source tombstone (`source_kind: "unknown"`) map
  provenance and an explicit proof marker on the deleted map entry;
* stable `SessionTransformError` codes with no UUID, timestamp, digest, or
  arbitrary source text in messages/details.

Focused evidence at this layer:

```text
npx tsc --noEmit --pretty false --target ES2017 --module esnext \
  --moduleResolution bundler --allowImportingTsExtensions --strict \
  lib/v2/migration/transform/sessions.test.ts \
  lib/v2/migration/transform/capabilities.test.ts \
  lib/v2/migration/transform/sessions.ts \
  lib/v2/migration/transform/capabilities.ts \
  lib/v2/migration/transform/scalars.ts
```

Passed for the owned transform files. A repository-wide
`npx tsc --noEmit --pretty false` rerun reports one unrelated existing diagnostic in
`lib/v2/migration/transform/library.test.ts:481` (a widened literal run id in
the sibling library transform); no diagnostic references the owned files.

### Session transform

Implemented `transformSessions` and `sessions.test.ts`:

* verified sessions retain exact source times and 32-byte decoded HMAC digest;
* manual sessions are validated in the union and retain the legacy browser
  cookie's exact decoded digest as `app.sessions.session_kind = 'manual'` under
  the fixed `migrate-cookie` disposition; the former `expire-at-cutover`
  branch was removed after reconciling the implementation with the legacy
  reader/writer and plan 14.2/14.3;
* source-id collisions, decoded digest collisions including case variants,
  malformed digests, missing/wrong-kind/unverified/inactive owners, expiry and
  revocation ordering, explicit disposition, bounds and mixed-run cases fail
  closed;
* target bigint numbering is stable under source-array permutations;
* errors serialize without the private digest or a source sentinel.
* identity-to-adapter tests accept a proven deleted tombstone when no session
  references it, reject arbitrary active `unknown` provenance, and reject a
  deleted-source session at the lifecycle gate;
* malformed map containers fail with `session_account_map_invalid` before any
  `.run` dereference, including `null`, `undefined`, and arrays.

The continuity requirement follows the legacy application contract rather than
the short-lived linking flow. `lib/auth.ts:9,21-23,67-80,153-189,327-347,407-437`
uses the `vault_session` cookie; the `manual.` prefix selects
`manual_profile_sessions`; `hashToken` computes HMAC-SHA256 over the complete
raw cookie; manual sessions are issued for 365 days, refreshed on stale visits,
and written back with a refreshed expiry. Ordinary Steam sessions use the same
cookie name, a 30-day lifetime, and the `sessions` relation. The separate
`manual_profile_security_intents` callback record is paired with the
`vault_profile_security` callback cookie (`lib/manual-profile-security.ts:17`)
and is a 10-minute writer token (with a 15-minute database ceiling) used only
for OpenID promotion. Its pending rows can expire/restart at freeze; it does
not authorize retiring a persistent manual session. The test derives synthetic
full-cookie HMACs independently with `node:crypto` for both cookie kinds and
verifies that the migrated rows preserve the digest, kind, owner and map.

The prior checkpoint wording described an `expire-at-cutover` manual-session
alternative. That policy was based on conflating `manual_profile_sessions` with
`manual_profile_security_intents`; it is corrected here. The physical manifest
owner has been notified to carry the same disposition, and this checkpoint does
not claim that sibling manifest changes are complete.

### Capability transform

Implemented `transformCapabilities` and `capabilities.test.ts`:

* account-side five-cell tuples remain atomic and project `true` to visible and
  `false`/`NULL` to unknown;
* profile-side evidence retains its raw tuple and provenance without feeding the
  compact projection;
* profile-only, profile-only-dated, profile-newer and equal-time/undated
  conflicting guards fail closed; older and undated non-conflicting evidence
  remains auditable;
* raw counts, microsecond times, repeated permutations, wrong kinds, missing
  accounts, invalid booleans, bounds, row-run mismatches and private sentinels
  are covered.
* identity-proven deleted tombstones are omitted from compact capabilities and
  both source-evidence outputs; any account/profile capability row aimed at a
  tombstone fails with `capability_deleted_tombstone_row`;
* deleted map entries require the adapter's explicit proof marker, malformed
  marker shapes fail closed, and null/undefined/array map containers return
  `capability_account_map_invalid` before `.run` access.

Focused runtime evidence:

```text
node --experimental-strip-types --test \
  lib/v2/migration/transform/sessions.test.ts \
  lib/v2/migration/transform/capabilities.test.ts
```

The focused transform command now reports **20 passed, 0 failed** (eight
capability cases and twelve session/adapter cases). Targeted ESLint for both
modules and tests passes. The repository-wide `npm run lint` also passes with
the existing 24 application warnings and no errors.

The earlier read-only findings in
[`docs/v2-m3-session-review.md`](v2-m3-session-review.md) are resolved by the
proof-carrying tombstone path and the pre-dereference map guards. The review
integration cases are part of the 20-test focused gate above.

## Remaining gates and limits

The combined owned transform tests and targeted strict typecheck pass after the
policy correction. Repository lint passes with the pre-existing application
warnings described above. Repository-wide typecheck remains limited by the
unrelated sibling library-test diagnostic recorded above; this batch does not
edit that worker's files.
The accepted reader/exporter combined baseline was previously rerun by root
(126 unit tests passed) and is preserved; no reader rerun is needed for this
pure batch. No SQL, source connection, credentials, provider call, package
change, deployment, or remote TLS/auth claim is part of this checkpoint.
