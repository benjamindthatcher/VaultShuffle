# VaultShuffle v2 verified artifact reader

This document defines the local reader for an accepted v2 export run. It is a
file reader only: it opens an already completed private run directory, verifies
its claims and bytes, and streams rows to a caller. It does not connect to
PostgreSQL, accept credentials, perform transforms or load a destination.

## Acceptance boundary

The caller supplies both the source identity and the complete expected relation
and column set. The reader accepts a run only when all of the following hold:

- `manifest_version` is exactly `2` and `status` is `complete`.
- The manifest digest matches the exact UTF-8 bytes of `manifest.json`, and the
  sidecar has the exact `sha256sum` form for that file.
- The expected source matches the manifest. A real source requires the named
  project reference, database and user, TCP transport and a recorded TLS
  protocol. A synthetic fixture is a separate explicit expectation and
  requires Unix-socket transport, no project reference and no TLS protocol.
- The snapshot is `repeatable read`, read-only, has identical opening and
  closing snapshot text, and records the required UTC formatting settings:
  `TimeZone=UTC`, `DateStyle=ISO, YMD`, `IntervalStyle=iso_8601`,
  `extra_float_digits=3`, `bytea_output=hex`, `client_encoding=UTF8` and
  `synchronize_seqscans=off`.
- `snapshot.row_security` exists and records `setting=off` and
  `setting_at_close=off`. The role attributes may be `null` when the catalog
  was unreadable; they are never invented by the reader.
- Every expected relation appears exactly once with the expected ordered
  columns, and there are no other relation files. Relation counts, byte
  lengths and SHA-256 values are well formed and the manifest totals agree.

No real-source version 1 run exists in this project. Earlier synthetic version
1 fixtures may exist; the reader rejects every version other than v2 explicitly
instead of treating an old fixture as a compatible contract. A digest protects
against accidental corruption and substitution of bytes. It is not a
signature, provenance proof or evidence that the manifest came from a named
source.

## Filesystem safety

The final run directory contains only `manifest.json`, `manifest.sha256` and
`relations/`. An `INCOMPLETE` or `FAILED.json` marker, a `.partial` directory,
an extra relation file or a missing expected file blocks acceptance. The run and
relations directories must be owner-only directories. Artifact files must be
owner-readable regular files with no group or other permission bits, and the
reader rejects symlinks and hard-linked aliases. Relation paths are derived
from validated PostgreSQL identifiers as
`relations/<schema>.<relation>.copy`; a manifest path traversal is invalid.

The reader opens each file with `O_NOFOLLOW|O_NONBLOCK`, checks the descriptor's
owner, mode, regular-file type and link count, then reads that descriptor. It compares
the descriptor and path identity before and after the read. `inspectRun` hashes
and decodes every relation before resolving. A later `streamRelationRows` call
repeats the checks and compares the file fingerprint captured during
inspection, so replacement or mutation between the two phases fails with
`reader_artifact_changed`.

## API

The small public surface is in
`lib/v2/migration/read/reader.ts`:

```ts
import { inspectRun } from "./lib/v2/migration/read/reader.ts";

const verified = await inspectRun(runDirectory, {
  source: {
    kind: "synthetic-fixture",
    database: "vaultshuffle_m3_export_a",
    user: "vault_local_admin",
    label: "m3-c synthetic exporter-reader roundtrip",
  },
  relations: [
    { schema: "public", name: "exp_scalars", columns: ["id", "label"] },
  ],
});

await verified.streamRelationRows("public.exp_scalars", async (row) => {
  // row is readonly (string | null)[]; do not parse or normalize cells here.
  await stageRow(row);
});
```

`inspectRun` performs the complete verification pass before returning. The
stream method reads one relation with a 64 KiB file read buffer and emits one
frozen row at a time. Its promise resolves only after terminal LF framing, the
decoder row count, raw byte length, SHA-256 and file identity all agree with the
manifest. The callback can be asynchronous, and the next row is not delivered
until it settles.

Rows may have been delivered before a later integrity failure is discovered.
The callback must therefore stage rows in a transaction or private replacement
area and commit only after `streamRelationRows` resolves. On rejection it must
roll back or delete the staged data. The reader cannot undo a side effect made
by a caller's callback. If the caller needs all relations atomically, it should
stage every relation under one transaction and commit after every stream has
completed.

## PostgreSQL COPY text

`lib/v2/migration/read/copy-text.ts` provides the incremental decoder used by
the reader. It accepts arbitrary `Uint8Array` boundaries and uses a fatal
streaming UTF-8 decoder. It recognizes PostgreSQL text COPY escapes `\b`,
`\f`, `\n`, `\r`, `\t`, `\v` and `\\`. A field whose complete wire value is
`\N` is `null`; an escaped slash makes `\\N` the literal two-character
string `\N`. Empty fields remain `""`. Rows require LF terminal framing and
the exact expected field count. PostgreSQL emits `\b`, `\f`, `\n`, `\r`, `\t`
and `\v` for those controls and emits the other nonzero ASCII controls as raw
bytes; the reader preserves both forms. NUL is impossible in PostgreSQL text
values and is rejected, as are unsupported escapes, dangling slashes, invalid
UTF-8 and truncated rows.

These are the v2 text-format rules used by the exporter; the reference is the
[PostgreSQL 17 COPY documentation](https://www.postgresql.org/docs/17/sql-copy.html).
The exporter emits the canonical COPY-TO forms; the reader rejects non-canonical
octal, hexadecimal and unknown escapes rather than silently changing a cell.

Cells are returned as exact strings or `null`. The reader never converts
bigints, decimals, floats, JSON, UTC instants, timestamps or civil dates through
`Number`, `JSON.parse`/`JSON.stringify` or `Date`; later typed transforms own
those interpretations. Whitespace and Unicode normalization are untouched.

The default upper bounds are deliberately finite. Callers may lower them but
cannot raise the decoder's safe maxima:

| Buffer or count | Bound |
| --- | ---: |
| Input byte chunk | 1 MiB |
| One decoded field | 8 MiB |
| One decoded row | 32 MiB |
| Columns in a row | 4,096 |
| `manifest.json` | 8 MiB by default, 64 MiB hard maximum |
| `manifest.sha256` | 4 KiB by default, 64 KiB hard maximum |
| Relation files in one run | 4,096 |

The decoder holds only the current row and field. The live roundtrip streams
the synthetic `exp_bulk` relation, which is over 12 MiB and 60,000 rows, into a
counter without collecting its rows.

## Stable diagnostics

Reader failures use stable `ExportError` codes such as
`reader_manifest_digest_mismatch`, `reader_schema_mismatch`,
`reader_copy_malformed`, `reader_artifact_changed` and
`reader_row_security_missing`. Messages contain local fixed text and do not
include manifest paths, PostgreSQL error text or arbitrary source cells. A
caller may log the code and message; it must not log the row values supplied to
its callback.
