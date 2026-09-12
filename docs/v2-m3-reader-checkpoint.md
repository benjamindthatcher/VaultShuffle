# M3-C reader checkpoint

Updated 10 September 2026 after the local reader and live roundtrip gate.

## Completed layers

- `lib/v2/migration/read/copy-text.ts` implements a fatal UTF-8, arbitrary-byte
  boundary PostgreSQL COPY text decoder. It preserves cells as exact
  `string | null`, including a leading BOM, distinguishes `\N`, empty fields
  and literal `\\N`, checks field counts and LF framing, preserves PostgreSQL's
  raw nonzero ASCII controls alongside its canonical escapes, and rejects only
  impossible NUL data, unsupported escapes, invalid UTF-8 and truncation.
- `lib/v2/migration/read/reader.ts` implements `inspectRun` and its alias
  `inspectVerifiedRun`. It verifies the exact manifest sidecar digest, v2
  snapshot/UTC/row-security evidence, explicit source identity and relation
  columns, private filesystem shape, relation bytes/digests/row counts and
  contradictory totals before returning a `VerifiedRun`.
- `VerifiedRun.streamRelationRows` reopens each relation with no-follow,
  owner-only descriptor checks, a 64 KiB read buffer and a callback that is
  awaited row by row. It rechecks the manifest evidence and descriptor/path
  identity at completion, returning a result only after all integrity checks
  pass. Replacement or mutation is `reader_artifact_changed`; rows delivered
  before that error must be staged and rolled back by the caller.
- `lib/v2/migration/read/reader-roundtrip.integration.ts` provides the opt-in
  actual exporter-to-reader test against the disposable Unix-socket fixture,
  plus a direct PG17 `COPY TO STDOUT` control-byte stream through the reader.
- `lib/v2/migration/read/copy-text.test.ts` and `reader.test.ts` cover malformed
  framing/escapes/UTF-8, exact bigint/decimal/UTC/DST/civil-date strings,
  NULL/empty/literal-null, digest/count/totals corruption, v1 and evidence
  rejection, source and schema identity, markers, symlink/path traversal,
  hard-link aliases, private modes, FIFO nonblocking, sentinel-free diagnostics,
  mutation and a 50,000-row incremental stream.
- `docs/v2-reader-contract.md` records the API, safety boundary, limits and
  caller staging rule. Exporter wording was corrected in
  `lib/v2/migration/export/manifest.ts`, `docs/v2-export-contract.md` and
  `docs/v2-export-checkpoint.md`: no real-source v1 run exists, while earlier
  synthetic v1 fixtures may exist and are rejected by this reader.

## Bounded design

The decoder's safe maxima are a 1 MiB input chunk, 8 MiB decoded field, 32 MiB
decoded row and 4,096 columns. The reader defaults to an 8 MiB manifest, 4 KiB
digest sidecar and 4,096 relation files; hard maxima are 64 MiB, 64 KiB and
4,096 respectively. Callers may lower these values. The reader retains only the
current row and field; the live bulk test does not collect its rows.

## Evidence

From the repository root:

```text
node --experimental-strip-types --test \
  lib/v2/migration/read/copy-text.test.ts \
  lib/v2/migration/read/reader.test.ts
```

Result: **45 reader tests passed** after the BOM, raw-control and bounded FIFO
cases were included.

```text
VAULTSHUFFLE_M3_READER_INTEGRATION=1 \
VAULTSHUFFLE_M3_EXPORT_PGHOST=/tmp/vs-m3 \
VAULTSHUFFLE_M3_EXPORT_PGPORT=55441 \
VAULTSHUFFLE_M3_EXPORT_PGUSER=vault_local_admin \
VAULTSHUFFLE_M3_EXPORT_SOURCE_DB=vaultshuffle_m3_export_a \
node --experimental-strip-types --test \
  lib/v2/migration/read/reader-roundtrip.integration.ts
```

Result: **2 live tests passed** against PostgreSQL 17.6 in the isolated local
`vaultshuffle_m3_export_a` fixture. The exporter created a v2 run for
`public.exp_bulk` (60,000 rows, over 12 MiB) and `public.exp_scalars` (30
rows). The reader verified both raw relation digests and streamed all 60,000
bulk rows without collecting them, while scalar assertions checked exact
large integers, a wide decimal, floats, UTC instants, civil dates and both
NULL and empty values. A second test sent every ASCII codepoint 1 through 31
through PostgreSQL 17's live `COPY TO STDOUT` protocol and verified the
decoded value byte-for-byte, including the server's escaped controls.

```text
npx tsc --noEmit --pretty false
npx eslint lib/v2/migration/read lib/v2/migration/export/manifest.ts
```

Result: **typecheck and targeted lint passed**.

The fixture uses only the existing synthetic Unix socket at `/tmp/vs-m3` and
was not pointed at a remote service, source credentials or M1/M2 evidence. The
cluster data directory is
`node_modules/.cache/vaultshuffle-m3-export-data-20260910b`; it remains
available for the coordinator's review, and its server log records the
restart. No database objects were created, changed or dropped by this reader
batch.

## Remaining boundary

The reader verifies local artifact integrity and the exporter-produced local
contract. It does not establish remote TCP/TLS/SCRAM interoperability,
production provenance, source authentication, typed migration transforms,
destination loading, parity or cutover safety. Those remain later M3 gates.
