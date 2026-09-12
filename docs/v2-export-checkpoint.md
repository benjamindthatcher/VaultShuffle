# M3-A export checkpoint

Exporter continuation checkpoint · 10 September 2026 · branch
`codex/v2-architecture`.

## Scope and preservation

This batch owns `lib/v2/migration/export/**`, `lib/v2/migration/shared/**`,
`docs/v2-export-contract.md` and this checkpoint. No production endpoint,
source row, source credential, remote export, deployment, package/runtime edit,
M1/M2 evidence database or sibling worker cluster was used. Root retains the
execution ledger and final M3 acceptance.

## Status

The row-security correctness gate is **closed**. The exporter now sets and
verifies transaction-local `row_security = off` before any source read, records
the effective setting in the manifest, and refuses a run it cannot prove saw
every row. Everything the previous checkpoint recorded still passes, re-run in
full on a newly built cluster. No real export was performed.

## Clean local integration fixture

The final integration used a newly initialized PostgreSQL 17.6 cluster from
root's restored, clean prefix. It was not copied from another data directory.
The server listened only on its private Unix socket; the TCP transport remains a
separate synthetic TLS/SCRAM test.

| Item | Value |
|---|---|
| Install prefix | `/Users/benthatcher/Documents/GitHub/VaultShuffle/node_modules/.cache/vaultshuffle-pg17-20260910` |
| Data directory | `/Users/benthatcher/Documents/GitHub/VaultShuffle/node_modules/.cache/vaultshuffle-m3-export-data-20260910b` |
| Socket directory | `/tmp/vs-m3x` (0700) |
| Port | `55441` |
| Server log | `/Users/benthatcher/Documents/GitHub/VaultShuffle/node_modules/.cache/vaultshuffle-m3-export-server-20260910b.log` |
| Source fixture | `vaultshuffle_m3_export_a` |
| Target fixture | `vaultshuffle_m3_export_target` |

The cluster was initialized with `--no-locale --encoding=UTF8
--auth-local=trust --auth-host=reject`, started with `listen_addresses=''`,
and loaded from `lib/v2/migration/export/fixture.sql` and
`fixture-target.sql`. The source fixture contains only the synthetic public
relations and hostile formatting defaults required by the fidelity tests. The
target carries the `app` schema used by the destination rejection test.

The prior cluster (`…-data-20260910`, `/tmp/vaultshuffle-m3-export-socket-20260910`,
port 55437) was already stopped and removed before this batch began; it was not
diagnosed, cloned or repaired, and no sibling or M1/M2 process was touched.

The integration coordinates are configurable through
`VAULTSHUFFLE_M3_EXPORT_PGHOST`, `_PGPORT`, `_PGUSER`, `_SOURCE_DB`,
`_TARGET_DB` and `_PSQL`. The suite refuses database names matching
`vaultshuffle_m1*` or `vaultshuffle_m2*` before issuing a statement.

## Completed implementation layers

- `WireConnection` requires TLS on TCP, verifies the configured CA and
  hostname, requires TLS 1.2 or newer, bounds TLS negotiation/handshake and
  PostgreSQL authentication time, and never falls back to plaintext.
- SCRAM-SHA-256 is serialized through explicit authentication phases. Startup
  succeeds only after a credential challenge, `AuthenticationOk`, and a
  verified server proof when SCRAM is used. Premature, missing, bad and
  coalesced frames are covered by the synthetic TLS peer tests.
- PostgreSQL `M`, `D`, `H`, `q`/`Q` and `W` error fields are discarded. Only an
  allowlisted SQLSTATE and stable local messages reach `ExportError` and
  `FAILED.json`; a private sentinel is tested through both the wire and actual
  integration paths.
- A real inventory plan carries the complete expected public schema: all 44
  relations and 486 columns, relation kind/RLS, column nullability and
  constraints. `streamSnapshot` validates that contract inside the opening
  repeatable-read transaction before copying any selected relation, so an
  explicit `include` list cannot hide drift in an excluded relation. Synthetic
  fixture plans remain deliberately partial and use per-relation shape checks.
- **Complete row visibility is proven, not assumed.** `SET LOCAL row_security =
  'off'` is the first statement inside the export transaction — before the
  watermark, the schema contract and every relation — and the value is read back
  and required to be `off` (`row_security_not_disabled` otherwise). It is
  re-read after the last relation and a change fails
  `row_security_changed_mid_export`. This does not bypass RLS and requests no
  privilege: it makes a read a policy would filter raise `42501` instead of
  returning a subset, which is what `pg_dump` relies on. `SET LOCAL`, so the
  setting cannot outlive the transaction. `pg_roles.rolsuper` and `rolbypassrls`
  for `current_user` are recorded alongside it, because for such a role the
  guard has nothing to catch and completeness rests on a granted privilege
  instead. See contract §2.4.
- COPY bytes stream directly to owner-only files with bounded backpressure and
  an incremental digest. A sink failure after bytes arrive closes the stream,
  retains the partial relation evidence, leaves `INCOMPLETE` and sanitized
  `FAILED.json`, and never writes a manifest.
- `cli.ts` is an explicit path-only opt-in entry point. It requires
  `--confirm-read-only-source`, a private profile, an existing owner-only
  output root and explicit inventory; it accepts no password, DSN or credential
  environment option.

### Manifest change

`MANIFEST_VERSION` moved from **1 to 2**, adding `snapshot.row_security`
(`setting`, `setting_at_close`, `role_is_superuser`,
`role_bypasses_row_security`). No real-source version 1 run exists in this
project, although earlier synthetic version 1 fixtures may exist. The field is
required rather than optional, and a missing `row_security` object identifies a
manifest that cannot claim complete row visibility. Nothing outside
`lib/v2/migration/export/**` reads this manifest; the separate
`manifest_version` in `database/v2/migration/manifest/` belongs to the
disposition manifest and was not touched.

## Final validation

All commands were run from the repository root on 10 September 2026 against the
cluster above. The loopback listener tests used the approved elevated local
execution path.

| Command | Result |
|---|---|
| `node --experimental-strip-types --test lib/v2/migration/export/*.test.ts lib/v2/migration/shared/*.test.ts` | **81 pass, 0 fail** (the prior 74, unchanged, plus 7 new) |
| `VAULTSHUFFLE_M3_EXPORT_INTEGRATION=1 VAULTSHUFFLE_M3_EXPORT_PGHOST=/tmp/vs-m3x VAULTSHUFFLE_M3_EXPORT_PGPORT=55441 VAULTSHUFFLE_M3_EXPORT_PSQL=/Users/benthatcher/Documents/GitHub/VaultShuffle/node_modules/.cache/vaultshuffle-pg17-20260910/bin/psql node --experimental-strip-types --test lib/v2/migration/export/export-snapshot.integration.ts` | **29 pass, 0 fail** (the prior 21, unchanged, plus a 7-case row-security block and its group) |
| `npm run typecheck` | **Pass** |
| `npx eslint lib/v2/migration/export lib/v2/migration/shared` | **Clean** |

The 21 pre-existing integration cases prove repeatable-read visibility across a
concurrent write, exact bigint/decimal/null/UTC/DST/civil-date and text/COPY
values, bounded streaming, between-relation and mid-COPY abort cleanup,
fresh-snapshot restart behavior, destination and source identity rejection,
planned schema drift, runtime read-only enforcement, and server-error
sanitization. The mid-COPY case crossed 100,000 bytes before abort and verified
the partial file was smaller than the complete fixture.

### The row-security cases

Real roles (`NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION
NOINHERIT`, asserted from `pg_roles`) and real policies, built and dropped
inside the disposable fixture. Each case measures the subset the role actually
sees **first**, over the exporter's own client, so none of them can pass
vacuously:

| Case | Role really sees | Exporter |
|---|---|---|
| Selective policy, non-owner reader | 40 of 100 | `pg.42501`, 0-byte relation file, no manifest |
| Default deny (RLS on, no policy) | 0 of 25 | `pg.42501`; an empty export cannot finalize |
| `FORCE ROW LEVEL SECURITY`, the relation's owner | 12 of 30 | `pg.42501` |
| Mixed plan: clean relation then filtered relation | 64, then 40 of 100 | whole run fails; the completed relation is not sealed |
| No RLS, same restricted reader (**positive control**) | 64 of 64 | completes; manifest records `row_security` all-`off`, both role attributes `false` |
| Guard lifetime | — | `row_security` is `on` again after `COMMIT`; the filtered read works normally on that session |

### The hole, demonstrated

With the `SET LOCAL` and its refusal removed from `snapshot.ts`, the
selective-policy run **succeeded**: directory renamed out of `.partial`,
`"status": "complete"`, `"manifest_version": 2`, `totals.rows: 40` against a
source relation holding 100 rows, relation SHA-256
`37e309a3e89ff746a35753b2d20306df1a037904645f220f7172da05c437c26a`, a valid
manifest digest over it, and not one `hidden` row in the file. With the guard
restored the same run fails `pg.42501` and writes no manifest.

Four mutations were used to confirm the new tests are not vacuous; each was
reverted immediately and `snapshot.ts` was SHA-256 compared before and after
(`5b684c508a3937d6783d66c121ecffc9f7ca63484e5eeabcace854bc8a2bba3d`):

| Mutation | Result |
|---|---|
| `SET` instead of `SET LOCAL` | 1 unit fail |
| Guard moved after the formatting settings and watermark | 1 unit fail |
| Guard records the setting but does not refuse | 3 unit fails |
| Guard removed entirely | 5 integration fails, including the positive control |

## Remaining measured limits

- No real source connection, source row read, credential handling or remote
  export has occurred. The documented temporary CLI login path remains unused
  because it would mutate source authentication state.
- **The row-security guard is proven locally only.** No remote role, policy or
  table was inspected or modified, and no source role was granted anything.
  Whether the real source read role is a superuser, holds `BYPASSRLS`, owns the
  relations, or meets a relation whose policies would filter it is unknown; the
  first real run's manifest answers it, or the run fails `pg.42501`. A pooler
  that resets session state between statements would surface as
  `row_security_not_disabled` or `row_security_changed_mid_export` rather than
  as a short export — unmeasured either way.
- TLS and SCRAM are proven against the synthetic Node TLS peer, including CA
  trust, hostname mismatch, plaintext refusal, password proof and mutual
  server proof. Compatibility with the live endpoint, its certificate chain,
  password verifier and pooler is unmeasured. The local PostgreSQL fixture uses
  Unix-socket `trust` and is not evidence for remote authentication. The custom
  wire implementation remains accepted for continued validation, **not** proven
  to be a security necessity.
- Filesystem-full and killed-process recovery are not covered. Failed runs are
  intentionally retained for inspection.
- The complete inventory contract is metadata-only and unit-tested against the
  captured inventory. A real source-specific plan and final disposition remain
  owned by the schema/manifest batch and require coordinator review before any
  source export.

## Cluster disposition

The fixture cluster above was left **running** at the end of this batch so the
integration evidence is immediately reproducible by the coordinator. To stop and
remove it:

```bash
PREFIX=node_modules/.cache/vaultshuffle-pg17-20260910
"$PREFIX/bin/pg_ctl" -D node_modules/.cache/vaultshuffle-m3-export-data-20260910b -m fast stop
rm -rf node_modules/.cache/vaultshuffle-m3-export-data-20260910b /tmp/vs-m3x
```

The server log is retained as bounded diagnostic evidence. The source fixture
holds no `exp_rls_*` relation and the cluster holds no `exp_rls_*` role: the
integration block asserts both after tearing its fixture down.
