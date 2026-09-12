# M3-E: session and capability transforms

Coordinator assignment, 10 September. The local reader review fixes are
accepted: 45 reader units / 2 actual PG roundtrips passed; root reran combined
exporter/shared/reader units, **126 passed**, and reviewed BOM/control-byte/FIFO
fixes. No remote/source interoperability or real-data gate is claimed.

The persistent export/reader worker owns new
`lib/v2/migration/transform/sessions*`, `transform/capabilities*`, their tests,
a concise contract and `docs/v2-m3-session-capability-checkpoint.md`. Retain
reader/exporter/shared only for necessary compatibility. The identity worker
owns `transform/accounts*` and `scalars*`; coordinate their API rather than
duplicate scalar parsing or edit those files. Database owns physical SQL.

Implement pure transforms from verified exact source cells and an explicit
same-run account map to records against the actual M1/M3 contract and reviewed
column disposition. No SQL writes, source connection, credentials or runtime
application changes. Source counts in old audits are not preconditions.

Sessions: union verified and manual source tables without conflating kinds;
decode valid 64-hex digests to exact 32-byte values; detect collisions across
both tables on decoded bytes including upper/lower case; preserve original
session IDs through map records, account ownership, created/expiry/last-seen
and revoked semantics where actually present. Respect actual expiry-order and
revocation constraints without silently repairing source values. Determine
target session IDs deterministically from an explicit sorted union before
numbering, accounting for source UUID collisions. Never grant a manual source
session verified powers through a profile link or a reused Steam ID. Missing,
merged/deleted or wrong-kind owners must fail reconciliation as appropriate to
the agreed account contract. Preserve the established cookie/HMAC/digest
meaning by reading legacy session writers/readers; do not rehash digests,
rotate tokens or expose token/digest values in errors or reports. Expired or
revoked source sessions require explicit documented disposition; no real purge.

Capabilities: implement the binding `docs/v2-m3-capability-decision.md` and
structured manifest rule. Account-side flags/time/count travel together as a
tuple; preserve differing profile tuple provenance in the actual durable
`app.account_capability_evidence` shape. true→visible, false/NULL→unknown unless
separate validated privacy evidence exists; this legacy phase must never infer
hidden from absence. Reject profile-only/profile-newer/equal-time conflicting
cases identified by the binding snapshot guard rather than inventing newer-row
precedence. Keep missing/unknown times/counts explicit and use a supplied
snapshot observation instant only where it is labelled as capture time.
Repeated input produces the same semantic records without wall-clock defaults.

Return typed records plus count/code-only reconciliation failures; never include
private source text, UUIDs or session digests in public diagnostics. Bound
input/map sizes explicitly. Ensure snapshot/run identity cannot be mixed among
reader inputs, account map and output. Retain the full original source evidence
through the verified artifact until the later accepted load; this phase must
not silently drop a row merely to satisfy a destination check.

Adversarial tests: decoded collisions/case variants, malformed digest, duplicate
session IDs, missing owners, kind/verification confusion, shared manual Steam
ID, expired/revoked/ordering boundaries, microsecond instant preservation,
permutation-stable numbering, each false/NULL/true capability, account/profile
precedence exceptions, raw-tuple retention, mixed-run rejection and arbitrary
private-sentinel-free failures. Use independent expected outputs and legacy
compatibility evidence, not only round-tripping the same transform. Typecheck,
targeted lint and current checkpoint before interruption. Do not change source
or target roles, M1/M2/M3 SQL, root plan/ledger, package files, providers,
deployment or production. Overall M3 remains incomplete.
