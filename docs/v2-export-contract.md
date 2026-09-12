# V2 M3 export contract

The snapshot exporter: what it guarantees, what it requires, what it writes, and
how each claim is evidenced.

Claude M3-A export subagent · 10 September 2026 · branch `codex/v2-architecture`.
Companion to [the access findings](v2-export-access.md) and
[the M3-A assignment](v2-m3-a-batch.md). Implementation lives in
`lib/v2/migration/export/**` and `lib/v2/migration/shared/**`.

**No production data has been exported. No connection of any kind has been made
to the production project.** The snapshot and value tests use a disposable local
PostgreSQL 17.6 cluster holding synthetic rows. The TCP transport tests use a
separate synthetic TLS-wrapped PostgreSQL protocol peer; live remote TLS,
SCRAM and pooler compatibility remain unproven.

---

## 1. What this is

A single-purpose tool that reads the legacy source database once, at one instant,
**in full**, and writes the bytes to local disk with enough recorded evidence
that a later reader can tell whether the output is trustworthy without re-running
it. "In full" is a separate guarantee from "at one instant" and needs its own
mechanism: see [§2.4](#24-completeness-a-snapshot-of-some-of-the-rows-is-not-a-snapshot).

It is not a general dump tool, not incremental, and not resumable. Those are
deliberate: see [§7](#7-failure-semantics).

### Transport choice

`pg_dump` would give the same consistency guarantee. This implementation uses
the small `wire.ts` transport so raw `COPY` payloads can flow directly into the
bounded sink while the exporter owns the TLS, SCRAM and profile-path policy.
That is an implementation choice, not a claim that another vetted client could
never meet the contract:

| Requirement | How this implementation meets it |
|---|---|
| Digest over the bytes the **server** sent | `copyOut` forwards each raw `COPY` payload to the file and digest without decoding or re-encoding values |
| No credential in `argv` or the environment | The profile is opened by path and the password stays in `Secret` until SCRAM computation; no connection string is accepted |
| TLS we control | The TCP path uses Node TLS with required verification and no plaintext fallback ([§4.3](#43-tls-is-the-clients-responsibility)) |

So `lib/v2/migration/export/wire.ts` implements the PostgreSQL v3
frontend/backend protocol directly, over Node's own TLS stack, with SCRAM-SHA-256
and mutual authentication.

---

## 2. The consistency guarantee

**One transaction, opened `REPEATABLE READ, READ ONLY`, is the only thing that
makes the output a snapshot.** Every relation is streamed inside it. Nothing
committed by anyone else after that transaction takes its snapshot can appear in
any file of the run.

### 2.1 This is exactly what `pg_dump` does by default

A correction worth stating plainly, because an earlier draft of the access
findings had it wrong:

> PostgreSQL 17 `pg_dump` opens **one** transaction whose **default** mode is
> `REPEATABLE READ, READ ONLY`.
>
> The deferrable form `SERIALIZABLE, READ ONLY, DEFERRABLE` is used **only** when
> the optional `--serializable-deferrable` flag is passed.

Verified at source in `/tmp/postgresql-17.6/src/bin/pg_dump/pg_dump.c`:

- line 1336 — `ExecuteSqlStatement(AH, "BEGIN");`
- line 1346 — `if (dopt->serializable_deferrable && AH->sync_snapshot_id == NULL)`
- line 1349 — the deferrable form, inside that branch
- line 1353 — `"REPEATABLE READ, READ ONLY"`, the `else` branch and therefore the default

**Do not describe the default as repeatable-read-deferrable.** It is neither
deferrable nor serializable unless the flag is given. This exporter takes the
same default and does not offer the deferrable mode; the deferrable mode's only
advantage is avoiding serialization anomalies for a *concurrently writing*
serializable workload, which a read-only dump does not have.

### 2.2 The claim is proven, not asserted

Four independent mechanisms, all in `snapshot.ts`:

1. **Read back the isolation level.** The `BEGIN` we sent is not evidence the
   server honoured it. `assertTransactionDiscipline` reads
   `current_setting('transaction_isolation')` and `transaction_read_only` from
   inside the transaction and refuses anything but `repeatable read` / `on`.
2. **Record the watermark from inside.** `pg_current_snapshot()` (the full
   `xmin:xmax:xip_list`), its `xmin`, the WAL LSN, `transaction_timestamp()`,
   `statement_timestamp()` and the backend PID.
3. **Re-read the watermark after the last relation** and require it to be
   *identical*. If the snapshot changed mid-run, the files span two points in
   time and the run fails with `snapshot_changed_mid_export` rather than
   producing a manifest.
4. **Count rows off the wire independently.** In `FORMAT text` a data newline is
   escaped as `\` `n`, so a raw `0x0A` byte is always a row terminator. The count
   derived from the bytes must equal the server's `COPY n` tag, or the run fails
   `copy_row_count_mismatch`. This is the one corruption a digest alone cannot
   distinguish from a legitimately short relation.

### 2.3 Evidence

The integration test writes to the source *while the snapshot is open*, between
two relations, and proves the writes are invisible:

- 50 rows inserted, 10 deleted and 10 updated in `exp_concurrent` after
  `exp_bulk` has streamed and before `exp_concurrent` streams
- the test then confirms from a **separate session** that the writes really
  committed (count goes 100 → 140), so the race is genuine and not a no-op
- the exported file still contains exactly the 100 pre-write rows
- neither `DURING-EXPORT-` nor `MUTATED-DURING-EXPORT` appears anywhere in it
- **the 10 deleted rows are still present**, because they existed in the snapshot

That last point is what separates a real snapshot from "we happened to read
first".

### 2.4 Completeness: a snapshot of *some* of the rows is not a snapshot

Everything in 2.2 constrains *when* the rows were read. None of it constrains
*how many* of them the reader was allowed to see.

With PostgreSQL's default `row_security = on`, a `SELECT` or `COPY` issued by a
role that is not the relation's owner and does not hold `BYPASSRLS` returns only
the rows that relation's policies admit. There is **no warning, no notice and no
marker on the wire.** A policy-filtered subset and a genuinely small relation are
byte-for-byte the same COPY stream. Every other check in this document is
satisfied by it: the wire row count matches the server's `COPY n` tag, the digest
is internally consistent, the schema matched, the snapshot is stable — and the
run seals a manifest saying `"status": "complete"` about a fraction of a table.

**Checking `pg_class.relrowsecurity` is not a substitute.** That flag says a
relation *has* row security, not that this role's reads are being filtered by it,
and comparing a flag is a claim the exporter makes about itself.

So `streamSnapshot` issues **`SET LOCAL row_security = 'off'` as the first
statement inside the export transaction** — before the watermark, before the
schema contract, before any relation — and then reads `current_setting` back and
refuses to continue (`row_security_not_disabled`) unless the server reports
`off`.

This does **not** bypass row-level security. A role with no bypass privilege
cannot grant itself one. It changes what PostgreSQL does when a policy *would*
apply: instead of quietly filtering, the planner raises `42501 query would be
affected by row-level security policy for table "…"` and the transaction aborts.
`pg_dump` sets it for exactly this reason.
See [PG17 row security](https://www.postgresql.org/docs/17/ddl-rowsecurity.html)
and [pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html).

Three further properties:

- **`SET LOCAL`, not `SET`.** A session left with `row_security = off` would make
  ordinary filtered application queries raise instead of filtering, long after
  the export ended. The setting dies with the transaction, and an integration
  case asserts that it does.
- **Re-read after the last relation.** The value is checked again alongside the
  closing watermark; a change mid-run fails `row_security_changed_mid_export`
  and the run produces no manifest, because relations read after the change
  could have been filtered.
- **The role's own bypass state is recorded, not assumed.** `pg_roles.rolsuper`
  and `rolbypassrls` for `current_user` go into the manifest. For such a role
  `row_security = off` has nothing to catch: the export is still complete, but it
  is complete because of a granted privilege rather than because this run
  verified anything, and the manifest has to let a reader tell those apart. The
  exporter neither requires nor requests `BYPASSRLS`.

#### Evidence, not intent

`export-snapshot.integration.ts` builds real roles
(`NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`) and
real policies, **measures the subset each one actually sees first**, and then
requires the export to fail rather than publish it:

| Case | What the role really sees with `row_security = on` | Exporter |
|---|---|---|
| Selective policy, non-owner reader | 40 of 100 rows | fails `pg.42501`, 0-byte relation file, no manifest |
| Default deny (RLS on, no policy) | 0 of 25 rows | fails `pg.42501`; an empty export cannot finalize |
| `FORCE ROW LEVEL SECURITY`, the relation's **owner** | 12 of 30 rows | fails `pg.42501` |
| Mixed plan: one clean relation then one filtered | 64 rows, then 40 of 100 | whole run fails; the completed relation does **not** get sealed |
| No row security at all, same restricted reader | 64 of 64 rows | **completes**, 64 rows, manifest records `row_security` |

The last row is the control: without it the guard could be refusing everything
and the table above would look identical.

The hole was also demonstrated directly. With the `SET LOCAL` and its refusal
removed from `snapshot.ts`, the selective-policy run **succeeded**: directory
renamed out of `.partial`, `"status": "complete"`, `"manifest_version": 2`,
`totals.rows: 40` against a source relation holding 100, a valid manifest
SHA-256 over it, and not one `hidden` row in the file. The guard restored, the
same run fails with `pg.42501` and writes no manifest.

---

## 3. Value fidelity

A snapshot of the wrong *rendering* of a value is still wrong. The exporter pins
seven session settings and **reads every one of them back** before reading a row,
failing `session_setting_rejected` on any mismatch — `SET` succeeding is not proof
the session holds the value.

| Setting | Value | What it prevents |
|---|---|---|
| `TimeZone` | `UTC` | Instants rendered in the server's local zone, which shifts across DST |
| `DateStyle` | `ISO, YMD` | `03/09/2026`, which a US parser reads as 9 March |
| `IntervalStyle` | `iso_8601` | `@ 1 day 2 hours`, which only PostgreSQL parses |
| `extra_float_digits` | `3` | Doubles silently rounded on the way out |
| `bytea_output` | `hex` | `escape` form, ambiguous with a text backslash sequence |
| `client_encoding` | `UTF8` | Mojibake, or a server-locale-dependent byte stream |
| `synchronize_seqscans` | `off` | A scan starting at whatever block another backend is reading, so two reads of one relation in one snapshot differ in row order and therefore in digest |

### 3.1 These tests cannot pass vacuously

A value-fidelity test is worthless if the server would have produced the right
answer anyway. `lib/v2/migration/export/fixture.sql` therefore sets **hostile
per-database defaults**, so the exporter's session pinning is what produces the
expected output:

```sql
ALTER DATABASE ... SET TimeZone = 'America/New_York';
ALTER DATABASE ... SET DateStyle = 'SQL, DMY';
ALTER DATABASE ... SET IntervalStyle = 'postgres_verbose';
ALTER DATABASE ... SET bytea_output = 'escape';
ALTER DATABASE ... SET extra_float_digits = -3;
```

Measured against the fixture, this is what a reader that did *not* pin the
session would get, beside what the exporter actually writes:

| Value | Unpinned (server default) | Exported |
|---|---|---|
| `civil_date` | `29/03/2026` | `2026-03-29` |
| `instant` | `04/07/2026 08:34:56.789012 EDT` | `2026-07-04 12:34:56.789012+00` |
| `approx_double` | `1.23456789012` — **precision lost** | `1.2345678901234567` |
| `span` | `@ 0` | `PT0S` |
| `raw` | `\000` | `\x00` |

The suite also asserts *that the fixture is hostile* — a dedicated subtest fails
if the defaults are ever made friendly, so the block below it can never quietly
become vacuous.

### 3.2 What is covered

- **Signed bigint bounds**: `-9223372036854775808` and `9223372036854775807`
  export exactly. The test also asserts these are *not* representable as
  JavaScript numbers, which is why the exporter never parses a value — it moves
  bytes.
- **Wide numerics**: `1234567890123456789012345678.0123456789` survives; so does
  `9007199254740993` (2^53+1, the smallest integer a double cannot hold).
- **Null vs empty string vs zero** stay three different things: `\N`, an empty
  field, and `0.0000000000` at the declared scale.
- **Civil dates stay civil**: a `date` has no zone, so `2024-02-29`,
  `2026-03-29`, `2026-10-25`, `2026-03-08` and `2025-12-31` must not shift and
  must not gain a time — including across a leap day and both hemispheres' clock
  changes.
- **UTC across both DST boundaries**: values stored as a local wall clock in
  `Europe/London` and `America/New_York` on the days the clocks move come back as
  the correct UTC instant. Every non-null instant in the fixture is asserted to
  end `+00`. Sub-second precision, a far-future date (2999) and a pre-epoch date
  (1969) are included.
- **A naive `timestamp` must not acquire a zone** and must not shift.
- **Text escapes** round-trip: tab, newline, carriage return, backslash, leading
  and trailing spaces, non-BMP emoji, Cyrillic — and a literal two-character
  `\N`, which must not decode back to a null.
- **Reproducibility**: two runs over unchanged data produce identical wire
  digests, byte counts included.

---

## 4. Prerequisites for a run against the real source

None of this has been performed. It is what a real run would require.

### 4.1 Connection mode

| Mode | Approved | Why |
|---|---|---|
| Direct | **Yes** | The source's direct endpoint is **IPv6-only** on this project; the dedicated IPv4 add-on is disabled |
| Session pooler | **Yes** | The documented IPv4 fallback, and a session-mode backend holds session state across statements |
| Transaction pooler | **No** | A workflow decision, not an impossibility claim |

On the transaction pooler: a pooled backend **is** retained for the duration of
an open transaction, so a long repeatable-read transaction is not inherently
impossible there. The reason it is excluded is narrower and sufficient —
transaction pooling does not reliably give session state across statements, and
this exporter's correctness depends on `SET` values persisting from the moment
they are applied through every subsequent `COPY`. Use direct or session mode.

### 4.2 No platform backup exists

There is no snapshot-consistent platform backup on this plan, so a **client-side
logical dump is the only route** to a consistent copy. That is what this exporter
is.

### 4.3 TLS is the client's responsibility

**"Enforce SSL on incoming connections" is OFF on the source.** A non-TLS
connection would therefore succeed, silently, with no warning at either end.
Nothing on the server side will stop a plaintext export of production.

Two consequences:

1. **The local client at `/tmp/vaultshuffle-pg17` must never be pointed at
   production.** Verified: `pg_config --configure` reports
   `'--prefix=/tmp/vaultshuffle-pg17' '--without-readline' '--without-icu'
   '--without-zlib'` — no `--with-openssl` — and `otool -L` shows no OpenSSL
   linkage in `psql`. It cannot negotiate TLS at all, and against a server that
   does not require it, that failure is invisible.

2. **No second TLS-capable `psql` was built; this exporter does not need one.**
   *Stating the prerequisite was the option taken, not building a second client.* The exporter
   does not use libpq: `wire.ts` speaks the protocol over Node's TLS stack, where
   TLS is **not negotiable** — there is no `prefer` mode and no plaintext
   fallback. On a TCP transport it sends `SSLRequest`, aborts with `tls_refused`
   if the server answers anything but `S`, and then requires
   `rejectUnauthorized: true`, `minVersion: TLSv1.2` and a verified hostname.
   `run.ts` additionally refuses to proceed if a TCP connection reports no
   negotiated TLS protocol (`tls_missing`).

   The local pg17 client is used **only** to build and inspect the local fixture
   over a Unix socket, where no network hop exists to protect.

3. **The project CA certificate is public connection material, not a secret.**
   Downloading it requires no credential handling. It is supplied to the exporter
   by path via `tls.ca_certificates_pem_path`.

### 4.4 Credentials

The exporter's **only** credential input is a `0600` JSON profile file the
operator writes by hand, passed as a path. Nothing comes from an environment
variable, a command-line argument, or a prompt.

- `ps` shows a path, never a secret; shell history cannot capture one
- the profile file is opened and `fstat`-checked **through the same descriptor it
  is read from**, closing the check-then-open race; any group or other permission
  bit is rejected
- `assertNoCredentialInProcessArguments` asserts the plaintext is absent from
  `argv` — belt and braces, because a password in `argv` is invisible in the
  output but readable by every local process
- the password is wrapped in a `Secret` that survives neither interpolation, nor
  `JSON.stringify`, nor `console.log`, nor `util.inspect`; `reveal()` is the only
  way through, so every handling site is greppable

### 4.5 Identity, checked before a single row is read

`assertSourceIdentity` fails closed on every check — there is no warn-and-continue,
because an export from the wrong database that *looks* successful is worse than no
export, being the input to a migration nobody re-checks.

- `current_database()` and `current_user` must match the profile
- `pg_control_system().system_identifier` must match when the operator recorded
  one; being unable to read it when one is declared is itself a failure
- declared schemas must be present
- **declared schemas must be absent** — this is the destination guard. A profile
  must name at least one schema that exists only in the v2 target, or it is
  refused outright, because without it "pointed at the destination" is not
  detectable. Tested: it fails `identity_destination_detected` before any
  relation is read.
- for TCP, the project ref must appear in the host or the user

### 4.6 Schema drift

The export plan is an **input**, not something discovered at export time.
Discovering the schema at export time would make drift invisible: a column added
since the disposition manifest was written would simply appear in the output and
the loader would meet a column nobody has dispositioned.

Before each relation is read, its `relkind`, column count, and every column's
ordinal, name and `format_type` are compared to the plan. Added column, dropped
column, retyped column, changed relkind and missing relation all fail closed
(`schema_drift`, `relation_kind_drift`, `relation_missing`). All four are tested.

---

## 5. Output

```
<output-root>/
└── 20260909T213904Z-c9b47441/          0700   run id: UTC instant + 4 random bytes
    ├── manifest.json                   0600
    ├── manifest.sha256                 0600
    └── relations/                      0700
        ├── public.exp_bulk.copy        0600   COPY ... TO STDOUT (FORMAT text)
        └── ...
```

- Relation files are the **raw wire bytes** of
  `COPY (SELECT <planned columns>) TO STDOUT (FORMAT text, ENCODING 'UTF8')`,
  columns explicitly listed in plan order rather than `SELECT *`.
- The output root **must already exist**, be a directory, be owner-only and be
  owned by the caller. Creating it implicitly is how an export ends up in a home
  directory or a synced folder by typo.
- Writing inside a git working tree is **refused** unless explicitly overridden,
  and the override is recorded in the manifest. A snapshot of production rows one
  `git add -A` away from a commit is a class of accident no `.gitignore` entry
  reliably prevents, because the entry only has to be missing once.
- Modes are forced by `chmod` after creation, so a permissive `umask` cannot
  widen them. Tested at `0700`/`0600` end to end, and under `umask 0` in the unit
  tests.

### 5.1 The manifest

The manifest is the only durable claim about what an export is. Every field is
**evidence recorded from the run**, never a restatement of what the operator
asked for. Keys are sorted before serialization so the digest is a property of
the content, not of the code path that assembled it.

It records: manifest version, run id, status; the tool, Node version and code
revision; the source label, transport, host, port, database, user, project ref,
negotiated TLS protocol, and the full identity evidence (server version, system
identifier, recovery state, schemas found); the snapshot's isolation, read-only
flag, opening and closing snapshot, `xmin`, WAL LSN, transaction and statement
start in explicit UTC, backend PID, the seven verified session settings and the
row-security evidence below; output modes and git-worktree status; per relation
the schema, name, file, column list, both row counts, byte count, SHA-256 and
duration; totals; and timing.

`snapshot.row_security` is why the run may claim it saw every row (§2.4):

```json
"row_security": {
  "setting": "off",
  "setting_at_close": "off",
  "role_is_superuser": false,
  "role_bypasses_row_security": false
}
```

`setting` and `setting_at_close` are `off` on every manifest that exists, because
a run that could not hold that never gets one. The two role attributes are
`null` where the `pg_roles` row was unreadable — never a quietly reassuring
`false`. **`manifest_version` is `2`**; version 1 lacked this object. No
real-source version 1 run exists in this project, although earlier synthetic
version 1 fixtures may exist. A reader must reject version 1 and treat a
missing `row_security` as a manifest that cannot claim complete row visibility.

`manifest.sha256` carries the digest of `manifest.json` in `sha256sum` format.
The test verifies the recorded digest against the bytes actually on disk, and
each relation's digest against its file.

> Digests are assembled from typed values, never passed through the redactor.
> The redactor masks any 32+ character hex run, because that is what a session
> token looks like — it is applied to *messages*, not to manifest fields.

---

## 6. Security properties

- **No user record or credential may reach a log, a manifest or a transcript.**
  Every outbound string passes through `redact`, which masks URI userinfo (greedy
  to the last `@`, so an unencoded `@` in a password cannot print its tail as a
  host), keyed secrets, `Bearer`/`Basic` values, JWTs, Supabase key prefixes,
  32+ character hex digests and email addresses, then truncates.
- **PostgreSQL error fields are dropped, not redacted.** `M` (primary message),
  `D` (detail), `H` (hint), `q`/`Q` (the failing query) and `W` (context) can
  quote row values, and a row value is a user record. The parser keeps only an
  allowlisted SQLSTATE; diagnostics and `FAILED.json` use a stable local
  message. A private sentinel in all three user-controlled error fields is
  covered by the wire and integration tests.
- **Stacks are dropped** from reported failures: they add file paths and no
  diagnostic value the code and message do not already carry.
- **Read-only is enforced at the server, not just intended.** Tested: `CREATE
  TABLE` inside the exporter's transaction fails SQLSTATE `25006`, and the
  relation does not exist afterwards.
- **SCRAM is mutual.** The server's signature is verified in constant time.
  Skipping it would let anything answering on the port impersonate the source.
  MD5 and cleartext-over-TCP are refused outright.
- **Row-level security is never bypassed, and never silently applied.** The
  exporter does not hold, request or want `BYPASSRLS`. It sets transaction-local
  `row_security = off` so that a read a policy *would* filter raises `42501`
  instead of returning a subset (§2.4). A restricted source role therefore
  produces a failed run, never a short one — and never gains a row it was not
  already entitled to read.

---

## 7. Failure semantics

**A run is complete or it is evidence. It is never resumable.**

An export writes to `<run-id>.partial` and is renamed to `<run-id>` only after
the manifest is written and fsynced. Two independent signals mark an unfinished
export, so a reader that checks neither — and simply globs the root for run
directories — still never sees a partial one:

1. the `.partial` directory-name suffix
2. an `INCOMPLETE` sentinel file, written **before anything else**, so there is
   no instant at which a populated run directory lacks the marker

On failure the directory keeps its suffix, keeps the sentinel, gains a sanitized
`FAILED.json`, and the error is rethrown. **Nothing is cleaned up**: a failed run
is evidence, and deleting it is how a silent retry loop ends up looking like a
success. Partial relation bytes are left in place for inspection but carry no
manifest, so they cannot be mistaken for a finished export.

**A restart takes a new snapshot.** `createPrivateDirectory` refuses to reuse an
existing run directory outright, because combining files from two snapshots is
not a snapshot. Tested: two runs get different run ids, different directories and
**different `pg_current_snapshot()` values**, and the second sees a row inserted
between them while the first does not.

Directory fsyncs are taken after creation, after the manifest and after the
rename, so a run cannot look complete in the page cache and be missing its
manifest after power loss — which is the "unmistakably incomplete" property
inverted.

**A relation the source will not show in full fails the whole run, not just its
own file.** The failure arrives as `pg.42501` from the server, or as
`row_security_not_disabled` / `row_security_changed_mid_export` from the guard in
§2.4. In every case the run keeps `.partial`, keeps `INCOMPLETE`, writes
`FAILED.json` and produces no manifest — including when earlier relations in the
plan had already streamed completely, which is tested.

### 7.1 Memory

A relation larger than memory is never held in memory. `COPY` payloads go
straight to the file; when the file cannot keep up, the socket is paused until it
drains. Tested: streaming a 12.7 MB relation grows the heap by far less than the
relation's own size.

---

## 8. How to run it

### 8.1 Build the local fixture

The test never creates, drops or recreates a database. Build a disposable local
cluster once. Every coordinate is overridable through the environment; the
example below is the clean PostgreSQL 17.6 prefix used for the final run:

```bash
PG=/absolute/path/to/node_modules/.cache/vaultshuffle-pg17-20260910/bin
DATA=/absolute/path/to/node_modules/.cache/vaultshuffle-m3-export-data-20260910
export PGHOST=/tmp/vaultshuffle-m3-export-socket-20260910 PGPORT=55437 PGUSER=vault_local_admin
$PG/initdb -D "$DATA" --no-locale --encoding=UTF8 --auth-local=trust --auth-host=reject
$PG/pg_ctl -D "$DATA" -l /absolute/path/to/vaultshuffle-m3-export-server.log \
  -o "-k $PGHOST -p $PGPORT -c listen_addresses=''" start
$PG/createdb vaultshuffle_m3_export_a
$PG/createdb vaultshuffle_m3_export_target
$PG/psql -v ON_ERROR_STOP=1 -d vaultshuffle_m3_export_a      -f lib/v2/migration/export/fixture.sql
$PG/psql -v ON_ERROR_STOP=1 -d vaultshuffle_m3_export_target -f lib/v2/migration/export/fixture-target.sql
```

The fixture role uses local `trust` only inside this disposable cluster. The
server listens on a Unix socket (`listen_addresses=''`); the TCP exporter path
is tested separately against the synthetic TLS/SCRAM peer.

### 8.2 Run the tests

```bash
# credential-safety and private-filesystem unit tests
node --experimental-strip-types --test lib/v2/migration/shared/*.test.ts

# the snapshot integration suite (opt-in; skips without the variable)
VAULTSHUFFLE_M3_EXPORT_INTEGRATION=1 \
VAULTSHUFFLE_M3_EXPORT_PGHOST=/tmp/vs-m3x \
VAULTSHUFFLE_M3_EXPORT_PGPORT=55441 \
VAULTSHUFFLE_M3_EXPORT_PSQL=/absolute/path/to/node_modules/.cache/vaultshuffle-pg17-20260910/bin/psql \
node --experimental-strip-types --test \
  lib/v2/migration/export/export-snapshot.integration.ts

# exporter unit tests, including inventory, profile, CLI and TLS/SCRAM seams
node --experimental-strip-types --test \
  lib/v2/migration/export/*.test.ts lib/v2/migration/shared/*.test.ts

# static checks
npm run typecheck
npx eslint lib/v2/migration/export lib/v2/migration/shared
```

The integration suite is idempotent: it resets the mutable part of the fixture on
the way in, so a run killed part-way through does not poison the next one. The
row-security block additionally creates its own roles and policy tables and drops
both in a `finally`, then asserts that neither remains, so the source fixture
goes back to exactly what `fixture.sql` builds.

### 8.3 Opt-in source entry point

The real-export wrapper is deliberately an explicit command rather than a package
script. From the repository root, after reviewing the profile, inventory and
output root, an operator can run:

```bash
node --experimental-strip-types lib/v2/migration/export/cli.ts \
  --confirm-read-only-source \
  --connection-file /absolute/path/source-read-only.json \
  --output-root /absolute/path/owner-only-export-root \
  --inventory database/v2/source-schema-inventory-20260909.json \
  --schema public
```

The profile must be a private `0600` JSON file with role
`source-read-only`, explicit source identity expectations and at least one
destination-only schema in `identity.expect_schemas_absent`. A TCP profile must
include a password and a project reference, and always negotiates TLS with
certificate and hostname verification. `tls.ca_certificates_pem_path` may name
an absolute PEM bundle; the exporter bounds and validates that file before
connecting. The command has no password, DSN or environment credential option.
`--confirm-read-only-source` is required on every invocation, and the output root
must already exist with mode `0700`.

---

## 9. Verification evidence

Run on 10 September 2026 against PostgreSQL 17.6 on the local disposable
cluster, plus the synthetic TCP peer described above. The row-security
continuation re-ran everything on a **newly initialized** cluster from the
restored shared prefix (data directory
`node_modules/.cache/vaultshuffle-m3-export-data-20260910b`, socket
`/tmp/vs-m3x`, port `55441`).

| Command | Result |
|---|---|
| `node --experimental-strip-types --test lib/v2/migration/shared/*.test.ts` | **30 pass, 0 fail** |
| `VAULTSHUFFLE_M3_EXPORT_INTEGRATION=1 VAULTSHUFFLE_M3_EXPORT_PGHOST=/tmp/vs-m3x VAULTSHUFFLE_M3_EXPORT_PGPORT=55441 VAULTSHUFFLE_M3_EXPORT_PSQL=.../vaultshuffle-pg17-20260910/bin/psql node --experimental-strip-types --test lib/v2/migration/export/export-snapshot.integration.ts` | **29 pass, 0 fail** against a fresh isolated PostgreSQL 17.6 source/target fixture — the 21 prior cases plus the 7-case row-security block and its group |
| `node --experimental-strip-types --test lib/v2/migration/export/export-snapshot.integration.ts` (no variable) | **1 skipped** — correctly opt-in |
| `node --experimental-strip-types --test lib/v2/migration/export/*.test.ts lib/v2/migration/shared/*.test.ts` | **81 pass, 0 fail** — the prior 74 plus 7 row-security cases (the TCP listener run used the approved elevated local test path) |
| `npm run typecheck` | **Passes** |
| `npx eslint lib/v2/migration/export lib/v2/migration/shared` | **Clean** |

The row-security unit cases were checked against three deliberate mutations of
`snapshot.ts`, each reverted immediately (the file's SHA-256 was compared before
and after):

| Mutation | Result |
|---|---|
| `SET` instead of `SET LOCAL` | 1 fail — the guard would outlive the transaction |
| Guard moved after the formatting settings and the watermark | 1 fail — a guard applied after a read proves nothing about that read |
| Guard records the setting but does not refuse | 3 fail |
| Guard removed entirely (integration suite) | 5 fail, including the positive full-visibility case |

The earlier checkpoint records the repeated integration runs that found the
backpressure defects. This continuation's final aggregate unit run includes
the deterministic RFC SCRAM vector, a synthetic TLS success path, server proof
verification, ordered/coalesced authentication failures, untrusted-CA and
hostname rejection, plaintext refusal, bounded TLS negotiation and bounded
PostgreSQL authentication timeouts. The 21-case integration suite passed on a
fresh isolated fixture, including the mid-COPY failure case and a PostgreSQL
`M`/`D`/`H` sentinel that never reached `FAILED.json`.

---

## 10. Defects found and fixed

Both were found by running the integration suite for the first time. Both had
silently consumed two earlier attempts at this batch.

### 10.1 The export hung forever after the first relation

`FileHandle.createWriteStream({ autoClose: false })` takes a reference on the
`FileHandle`, and `FileHandle.close()` waits for every reference to be released.
The stream releases its reference when it is **destroyed**, not when it is
*ended* — and `autoClose: false` also implies `autoDestroy: false`, so ending it
was never enough. `handle.close()` therefore never settled.

The failure had no error, no output and no timeout: the run directory was
created, `INCOMPLETE` was written, `relations/` stayed empty, and the process sat
there. Two prior runs of this batch were lost to it, one for 4 h 55 m.

Measured in isolation:

| `autoClose` | destroy before close | `handle.close()` |
|---|---|---|
| `false` | no | **never returns** |
| `false` | yes | returns |
| `true` | n/a | `handle.sync()` fails `EBADF` first |

The third row is why `autoClose: true` is not the fix — the descriptor must stay
open for the fsync. `finish()` now fsyncs, then destroys the stream and waits for
its `close`, then closes the handle.

### 10.2 A backpressure wait could wedge the connection

Fixing 10.1 exposed a race. `#onData` parses a whole socket chunk, which may hold
hundreds of `CopyData` messages, and `socket.pause()` does not stop that loop —
so a drain waiter was being registered per message, hundreds at a time, tripping
Node's `MaxListenersExceededWarning` on every burst.

Collapsing that to one outstanding wait then created a worse failure: if a COPY
ended while a wait was outstanding, `finish()` destroyed the stream, a destroyed
stream never emits `drain`, and the wait never settled — leaving the socket
paused with nothing left to resume it. Every relation after that one stalled.

This reproduced roughly one run in three, which is exactly why the suite is now
run repeatedly. Fixed on both sides:

- `whenDrained` settles on `close`, `finish` and `error` as well as `drain`, and
  returns immediately for a stream that has already ended
- backpressure is released when the command completes (`ReadyForQuery`) and when
  the connection fails, because backpressure belongs to the COPY that caused it

---

## 11. Not covered

Honest limits of what is evidenced.

1. **Nothing has been run against the real source.** Every database result here
   is from synthetic local data. Row counts, durations, byte volumes and any
   behaviour specific to the production server or the pooler are unmeasured.
2. **TLS and SCRAM are untested against a live server.** The local PostgreSQL
   cluster authenticates with `trust` over a Unix socket. A separate synthetic
   TLS-wrapped PostgreSQL protocol peer now exercises the TCP path: it checks the
   client SCRAM proof, the client verifies the server proof, and the suite covers
   the RFC 7677 vector, trusted-CA/hostname success, untrusted-CA rejection,
   hostname rejection, plaintext refusal, bounded TLS negotiation and bounded
   PostgreSQL authentication timeouts.
   Those tests prove the local Node transport seams, not compatibility with the
   real endpoint, its certificate chain, its password verifier or its pooler.
3. **The session pooler is untested.** The claim that session mode preserves
   session state across statements is from documentation, not measurement.
4. **Full-disk and killed-process behaviour are not covered.** The mid-COPY
   runtime case now passes against a fresh PostgreSQL fixture: a sink failure
   after bytes arrive closes the stream and leaves the partial file,
   `INCOMPLETE` and sanitized `FAILED.json` with no manifest. Filesystem-full
   and process-kill recovery still require a separate rehearsal.
5. **`--serializable-deferrable` is not offered**, and the exporter has no
   parallel or multi-connection mode, so exported-snapshot handoff
   (`pg_export_snapshot`) is unexercised.
6. **The plan loader is tested against the captured inventory file, not a live
   source.** `loadExportPlanFromInventoryFile` validates the captured
   `database/v2/source-schema-inventory-20260909.json` (44 public relations and
   486 columns in the current file), checks the project reference, fixed order,
   identifiers, ordinals, nullability, relation kinds and constraints, and
   keeps the complete contract when `include` narrows output. Unit tests cover
   added/missing relations and kind/RLS, nullability and constraint drift inside
   `assertSchemaContract`; the synthetic fixture separately covers planned
   relation-shape drift. A live production inventory remains unmeasured.
7. **The CLI is opt-in and unperformed.** `lib/v2/migration/export/cli.ts` now
   provides a path-only `--connection-file` entry point with an explicit
   `--confirm-read-only-source` gate. Its argument/profile/inventory validation
   is unit-tested, but no real profile or source connection was supplied.
8. **The row-security guard is proven locally, not against the real source.**
   The policies, roles and refusals in §2.4 are synthetic and were built,
   measured and dropped inside the disposable fixture cluster; no remote role,
   policy or table was inspected or modified. Whether the real source's read
   role is a superuser, holds `BYPASSRLS`, owns the relations, or meets a
   relation whose policies would filter it is **unknown** and will be answered
   by the manifest of the first real run — which will either finalize with the
   role's bypass state recorded, or fail `pg.42501` naming nothing. A pooler
   that resets session state between statements would also surface here, as a
   `row_security_not_disabled` or `row_security_changed_mid_export` refusal
   rather than as a short export; that behaviour is unmeasured either way.
9. **The custom PostgreSQL wire implementation remains accepted for continued
   validation, not proven necessary.** Nothing in this batch measured remote
   authentication or pooler compatibility, and the guard above is orthogonal to
   that question: it would be equally required of any client.

## 12. Open items for the coordinator

1. **A real run needs a password the user must place themselves.** No subagent
   may extract or store a credential, including into a private local file. The
   steps for the user are in [the access findings](v2-export-access.md).
2. **A real endpoint rehearsal still needs review.** The operator must supply a
   private profile containing the source password, expected identity values and
   the project CA PEM path. The rehearsal must verify the negotiated TLS
   protocol, hostname/CA chain, SCRAM server proof, source identity and actual
   read-only behaviour before any export is accepted. The temporary access
   endpoint remains explicitly unproven and requires source auth-state mutation,
   which this work did not perform.
3. **The disposition manifest is owned by the schema batch.** This exporter
   consumes a plan; it does not decide what to export. The real inventory loader
   is ready, but coordinator disposition and a source-specific plan review are
   still required before a real run.
