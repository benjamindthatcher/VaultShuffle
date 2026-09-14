# M3 local loader contract

Updated: 13 September 2026

## Boundary

The loader consumes a run returned by the terminally verified export reader and
can connect only to an explicitly supplied local PostgreSQL Unix socket. It has
no URL, TCP host, project reference, environment-profile, credential lookup,
authentication, DDL, or remote execution path. The caller supplies the local
socket directory, port, database, user and vetted absolute `psql` path.

This implementation is a rehearsal/load primitive. It does not authorize a
real export or cutover. Synthetic evidence is labelled
`synthetic-fixture` and cannot satisfy a real-source gate.

The reviewed physical inputs are pinned separately from the live catalogue:

| Migration | SHA-256 |
| --- | --- |
| `20260906093036_m1_private_foundation.sql` | `54fe0a7defd029e91568b78d51393670ac7ca6edcf915919670c7f64c2476389` |
| `20260907163356_m2_jobs_quota_publish.sql` | `f09d7ca900f3cdaaee81eff0f507adc5869865f16eb7f340eeb1729223bc5aba` |
| `20260910232654_m3_preservation_schema.sql` | `605b72a3d9df1328ec27033c3420c1813a238f6e15bd8fc28f971cddaf30a24a` |
| `20260911234500_m3_legacy_preservation_followup.sql` | `beecb95c25e87f1b239f11f16e807338ec496df19ac27deffa5fb49b0bda5f59` |
| `20260912193000_blacklist_semantics.sql` | `a20e75cbca19918d4a5d8cb2778a98f50bf98641b7594c4c067abe58a8c9cca6` |

The current physical destination index SHA-256 is
`43ccbf57288ec8d40314d2d5ea266280c4b6c520ef99c26a9524f8a040918dc7`.

## Ordered execution

`runLoaderPipeline` performs these phases in order:

1. Stage every allowlisted reader relation in an owner-only directory.
2. Invoke the pure same-run domain transforms.
3. Bind explicit target-shaped batches to the local physical catalogue and
   compare it with a fingerprint supplied independently by the reviewed run
   packet.
4. Evaluate every precommit gate.
5. Apply all rows, identity-sequence repairs and bookkeeping in one transaction.
6. Reconcile typed rows before commit and value-free digests after commit.
7. Return the report as published only after every comparison passes.

No `migration.runs` row is created before step 5. A failed reader, exception,
unresolved conflict, missing source or target coverage, missing decision, or
schema mismatch therefore leaves the target untouched.

## Private staging

`stageVerifiedRun` requires an absolute new directory under an owner-only
parent. It creates the directory as `0700` and one `0600` NDJSON spool per
relation. Each relation has hard row, cell and byte limits. Its device, inode,
size, modification time and link count are sealed and checked on every read.
The reader's terminal row count and digest must agree before transform access.
Partial stages are recursively deleted on every failure and all stages are
deleted after a successful run.

This closes the reader-callback boundary: a callback may receive rows before a
truncated final chunk is detected, but those rows can only reach disposable
staging, never the target.

## All-domain assembly

`assembleAllDomains` requires all 44 frozen `public.*` relations exactly once.
It builds identity first, then the complete AppID union, and passes the same run
identity/account/game maps to session, capability, catalogue, library,
legacy-state, family, history, collection, commitment, draw, recommendation,
support, operations, duration and provenance transforms.

The adapter names every physical output relation. Source-only helper fields are
removed explicitly, camel-case transform records are mapped to target column
names, offer identities are shared with price rows, and the recommendation
snapshot identity is written explicitly and stamped on its children. Any
adapted field absent from PostgreSQL, or any required physical column absent
from the batch, fails `loader_target_coverage`. Nonloadable streams such as
withheld settings, counters and support records never become load batches and
remain precommit exceptions.

Source accounting is one row per staged source relation. It distinguishes
normal rebuild inputs, archives, withheld/conflict rows and ordinary loaded
dispositions. A deterministic guest-pool rebuild is not an exception. Only
conflicts whose transform status is `unresolved` count against publication.

## Exact target load

Target scalars are encoded by declared PostgreSQL kind. Integers and numerics
remain decimal text; timestamps become UTC with microseconds; bytea snapshot
hashes are decoded from exact 32-byte hex; JSON source text is validated without
rounding numeric tokens through JavaScript; booleans and COPY control characters
use PostgreSQL text-COPY encodings.

The loader opens one transaction, takes a run-scoped advisory lock, locks every
planned target relation, and verifies immutable run metadata before inserting a
row or changing `current_phase`. It copies into typed temporary tables, checks
existing applied-step checksums, inserts in foreign-key order, repairs every
explicit identity sequence with transactional `ALTER SEQUENCE ... RESTART
WITH max(id)+1`, and performs bidirectional `EXCEPT ALL` between the typed stage
and target. Any target constraint or comparison failure rolls back rows,
sequence restart state, run metadata, steps and counts together.

An identical replay is a no-op. Reusing a run id with a different snapshot key,
source hash, start time, schema, manifest, transform, staging fingerprint,
relation count or step checksum fails before target mutation.

The current transaction contract assumes the target relations are empty at the
start of a migration run. Exact reconciliation deliberately rejects unrelated
pre-existing rows rather than hiding them with an upsert.

## Reconciliation and privacy

Reconciliation includes ordered per-relation, per-column and per-account
digests plus row counts. Fixed-scale numeric spellings compare by exact numeric
value, nullable booleans remain null, timestamps keep microseconds and JSONB is
canonicalized for read-back comparison. The transaction's typed `EXCEPT ALL`
is the authoritative equality proof.

The report contains relation/account keys, counts, digests, fingerprints,
synthetic storage measurements and mismatch classifications. It contains no
support text, authored notes, email, setting values, session digests or source
row payloads. `writePrivateReconciliationReport` requires an owner-only parent,
creates a new `0600` file, verifies the report digest and refuses overwrite.

## Frozen schema evidence

The accepted local PG17 rehearsal applied these five migrations in order:

- `20260906093036_m1_private_foundation.sql`
- `20260907163356_m2_jobs_quota_publish.sql`
- `20260910232654_m3_preservation_schema.sql`
- `20260911234500_m3_legacy_preservation_followup.sql`, SHA256
  `beecb95c25e87f1b239f11f16e807338ec496df19ac27deffa5fb49b0bda5f59`
- `20260912193000_blacklist_semantics.sql`, SHA256
  `a20e75cbca19918d4a5d8cb2778a98f50bf98641b7594c4c067abe58a8c9cca6`

The final 69-relation all-domain fixture fingerprint is
`1558351531a10a8ebfd5ec932cc56a21e434c883e7e46a2bdfb950fd96a208b8`.
The generated physical index SHA256 is
`43ccbf57288ec8d40314d2d5ea266280c4b6c520ef99c26a9524f8a040918dc7`.
The final index reports 92 physical relations, 988 columns and no pending V2
addition or drop.

The representative synthetic fixture gives every one of the 44 source
relations a nonempty row. Its support rows intentionally retain the transform's
pending retention-policy blocker. The PostgreSQL physical-adapter rehearsal
waives that one blocker inside the test callback only; `assembleAllDomains`
returns it unchanged for every production caller.

The final PG17 rehearsal passed 1/1 with that 44-nonempty fixture, and the
targeted PG17 fault suite passed 13/13. The final adapters preserve the SQL
default for an omitted `catalog.review_decisions.source_payload` by supplying
`{}`, assign explicit completion and unknown-history identities, and bind each
completion registry row to its resolved or unknown history identity before COPY.
The targeted suite confirms that identity-sequence repair uses transactional
`ALTER SEQUENCE ... RESTART WITH max(id)+1` and rolls back if a later
reconciliation failure aborts the transaction.
