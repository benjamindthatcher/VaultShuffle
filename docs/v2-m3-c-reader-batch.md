# M3-C: verified artifact reader and lossless COPY decoding

Coordinator assignment, 10 September 13:46 UTC. This is the next local migration
tooling layer after the exporter gate, not permission to connect to production
or load any target. Reuse the persistent exporter/import worker at Luna max
while Claude allowance is exhausted.

## Ownership and objective

Own new `lib/v2/migration/read/**`, new reader contract/checkpoint docs, existing
`lib/v2/migration/export/**` and `shared/**` only for necessary compatibility.
Do not change database migrations, disposition manifests, package dependencies,
root ledger or plan. Sibling database/manifest workers retain their paths.

Build the production-use local reader needed by subsequent deterministic
transforms and independent parity. It consumes the accepted export run format
v2, preserves the exact source cell values, and fails before any caller may
claim a complete verified dataset when files or claims are inconsistent.

## Required contract

- Only a complete, expected source run can be accepted: version 2, expected
  project and relation/column set supplied explicitly by the caller, identical
  opening/closing snapshot, read-only repeatable-read, UTC settings and required
  row-security-off evidence. Distinguish synthetic fixture identity explicitly.
  Reject missing/duplicate/extra relations or columns, contradictory totals,
  malformed counts/digests and absent/unsupported evidence.
- Check the manifest digest against its exact file bytes and each relation's
  digest, byte length and row count against actual bytes. A digest is integrity
  against accidental corruption, not a signature or proof of source provenance.
  Never label a stream complete until all promised integrity checks succeed.
- Reject `.partial`, INCOMPLETE/FAILED markers, symlink/path traversal, duplicate
  file aliases and files outside the private run directory. Reuse private-fs
  safeguards and owner-only access. Bound manifest/field/row buffering with
  explicit limits and useful stable error codes. No credential or arbitrary
  source cell may appear in errors, logs or fixture reports.
- Decode PostgreSQL COPY text incrementally across arbitrary byte boundaries,
  including UTF-8, escapes, embedded controls, backslashes, empty string and
  literal backslash-N versus NULL. Check field counts and terminal framing;
  reject malformed/truncated input. Consult official PG17 COPY rules as needed.
  Keep cells as exact string or null. Do not parse bigint/decimal through Number,
  JSON parse/stringify values, normalize whitespace or convert timestamps via
  millisecond Date. Later typed transforms own interpretation.
- Expose a small documented API for verified run inspection and streaming rows;
  no direct database load, transform policy or network access. Explain how a
  caller must avoid committing rows from a subsequently failed stream and how
  the reader handles file mutation/replacement during verification/iteration.
  Prefer a straightforward bounded design over a new abstraction framework.

## Validation and return

Test adversarial truncated/corrupt/mismatched files, marker/version/identity
rejection, absent row-security evidence, path/symlink escape, columns/totals,
UTF-8 and escape splits, exact large integers/decimals/UTC/DST/civil dates,
NULL/empty/literal null marker, and private-sentinel-free diagnostics. Include
at least one actual clean local exporter→reader round trip using the existing
synthetic PG fixture; corruption must block verified completion. Measure a
large enough synthetic stream to demonstrate bounded processing.

Exporter baseline is now 81 unit / 29 real PG integration tests, independently
rerun by Claude parent, plus typecheck/lint. Root reviewed the new RLS guard and
accepts the **local exporter layer**. Remote authentication/pooler compatibility
remain unmeasured. Its current fixture is `/tmp/vs-m3x`, port 55441, data under
`node_modules/.cache/vaultshuffle-m3-export-data-20260910b`; this exporter scope
may reuse and clean up that fixture only. Complete PG17.6/PGMQ prefix is
`node_modules/.cache/vaultshuffle-pg17-20260910`, shared read-only.

Correct the documentation's overbroad “no version 1 manifest exists anywhere”
to “no real-source version 1 run exists”; earlier synthetic versions may exist
and this reader should explicitly reject them. This is not a schema migration.

Return exact files/API/commands, tests and measured limits. Save finished layers
to a new `docs/v2-m3-reader-checkpoint.md` before interruption. No source query,
credentials, source authentication mutation, remote apply/export/load, provider
activation, deployment, package install or commit. M3 remains incomplete.
