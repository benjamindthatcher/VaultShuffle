# M3-E session and capability review

Review date: 10 September 2026. This is a read-only review of the completed
M3-E transforms against the M3-E batch/contract, the M1 session and capability
schema, the M3 capability binding, the M3-D identity result, and the legacy
session writers/readers in `lib/auth.ts` and `lib/manual-profile-security.ts`.
No source or remote operation was performed.

## Verdict

The session and capability transforms are acceptable for the reviewed M3-E
boundary: valid deleted merge tombstones join as inactive, unverified manual
owners; they produce no session row or capability observation, while a session
or capability row aimed at one fails closed. The focused session/capability
suite passes 20/20, targeted strict TypeScript passes, and targeted ESLint
passes.

## Findings

### M3-E-1 — deleted merge tombstones abort the capability phase (resolved)

`transformIdentityBatch` deliberately emits a deleted merge source as an
`app.accounts` tombstone with `lifecycle_status = 'deleted'`, no profile, and a
map row with `source_kind = 'unknown'` (see
`docs/v2-m3-identity-transform-contract.md`, “Deleted merge sources”). The
session adapter now accepts that proven shape and correctly carries the
deleted lifecycle into its `AccountMap`.

`transformCapabilities` now requires an active source row only for active map
entries. The adapter carries a proof marker for a deleted tombstone, and the
capability index rejects deleted entries without that proof. Proven tombstones
are omitted from compact capability and evidence output; an account or profile
row aimed at one returns the stable
`capability_deleted_tombstone_row` code. This preserves absence without
fabricating a tuple or source observation.

The corrected synthetic integration (identity output is used to build the map)
now produces compact output only for the active account:

```text
map [
  { id: 1, lifecycle: 'active', kind: 'steam' },
  { id: 2, lifecycle: 'deleted', kind: 'manual' }
]
capabilities { accounts: 1, accountEvidence: 1, profileEvidence: 0 }
deleted-target row rejected CapabilityTransformError capability_deleted_tombstone_row
```

The identity-to-adapter-to-capability regression proves a mixed active plus
deleted run produces output only for the active account, and rejects both row
shapes aimed at the tombstone.

### M3-E-2 — null or undefined account maps escape as raw `TypeError` (resolved)

Both transforms now validate the input and account-map containers before
reading `.run`. A malformed artifact with `accountMap: null`,
`accountMap: undefined`, or an array returns the documented stable map error
instead of a raw `TypeError`.

The focused regressions cover all three malformed containers:

```text
sessions session_account_map_invalid
capabilities capability_account_map_invalid
```

The guard keeps the coordinator on a machine-readable reconciliation path and
inside the transform error/redaction boundary.

## Reviewed areas with no additional blocker

* Session digests are decoded from the exact 64-hex source value into 32 bytes;
  collisions are checked across both source tables after lowercasing, so
  case variants collide. Errors contain neither digest nor source sentinel.
* Legacy cookie semantics match `lib/auth.ts`: `vault_session` is retained,
  the `manual.` prefix selects `manual_profile_sessions`, and the complete raw
  cookie is the HMAC input. Manual rows remain `session_kind = 'manual'` and
  require an active, unverified manual owner; they cannot gain Steam
  verification through a reused Steam ID or profile link. The short-lived
  `vault_profile_security` intent flow is not treated as a browser session.
* Session source UUIDs, owner mappings, target numbering, created/last-seen/
  expiry/revocation instants, and source snapshot hashes are retained. The
  shared PG timestamp parser compares exact microseconds and no wall clock is
  read by either transform. Expiry and revocation ordering is rejected rather
  than repaired.
* Capability precedence follows the binding: the account-side five-cell tuple
  is authoritative as a unit; true projects to visible and false/NULL to
  unknown; profile tuples are retained with source precedence, raw flags,
  count, checked time, snapshot hash, and labelled capture time; profile-only
  dated, profile-newer, and equal-time/undated conflicts fail closed. No
  legacy false flag becomes hidden/private.

No additional correctness or security blocker was found in this review. The
20-test focused gate covers the two resolved findings; no source-value or
remote gate is claimed here.
