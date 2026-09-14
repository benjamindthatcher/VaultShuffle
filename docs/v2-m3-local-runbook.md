# M3 local loader runbook

Updated: 13 September 2026

## Purpose and hard boundary

This runbook rehearses the verified-reader to all-domain PostgreSQL load on a
disposable local PostgreSQL 17 cluster. Use fabricated data only. Do not supply
a TCP host, database URL, Supabase project reference, source credential or
production target. The loader refuses a target that is not an absolute local
Unix-socket directory.

## Prerequisites

- The reviewed five V2 migrations listed in
  `docs/v2-m3-loader-contract.md` are present at their frozen hashes.
- `node_modules/.cache/vaultshuffle-pg17-20260910/bin` contains PostgreSQL 17
  binaries.
- The cluster directory and staging/report parent are private (`0700`).
- The target is disposable and empty.

Use a task-specific directory, port, role and database. The commands below show
the accepted fixture values; choose another unused port if needed.

```sh
M3L_ROOT="$(mktemp -d /tmp/vs-m3-loader.XXXXXX)"
chmod 700 "$M3L_ROOT"
mkdir -m 700 "$M3L_ROOT/socket"
PGBIN="$PWD/node_modules/.cache/vaultshuffle-pg17-20260910/bin"
"$PGBIN/initdb" -D "$M3L_ROOT/data" -U vsm3loader --auth=trust --no-locale --encoding=UTF8
"$PGBIN/pg_ctl" -D "$M3L_ROOT/data" -l "$M3L_ROOT/postgres.log" \
  -o "-k $M3L_ROOT/socket -p 55507 -c listen_addresses=''" start
"$PGBIN/createdb" -h "$M3L_ROOT/socket" -p 55507 -U vsm3loader vs_loader_c
```

Replay the five migrations in timestamp order with `ON_ERROR_STOP=1`. Use the
actual filenames under `database/v2/supabase/migrations`; do not edit a frozen
migration or add fixture DDL.

```sh
for migration in \
  database/v2/supabase/migrations/20260906093036_m1_private_foundation.sql \
  database/v2/supabase/migrations/20260907163356_m2_jobs_quota_publish.sql \
  database/v2/supabase/migrations/20260910232654_m3_preservation_schema.sql \
  database/v2/supabase/migrations/20260911234500_m3_legacy_preservation_followup.sql \
  database/v2/supabase/migrations/20260912193000_blacklist_semantics.sql
do
  "$PGBIN/psql" -h "$M3L_ROOT/socket" -p 55507 -U vsm3loader \
    -d vs_loader_c -v ON_ERROR_STOP=1 -q -f "$migration"
done
```

## Focused verification

Run the loader TypeScript and unit gates once:

```sh
npx tsc --noEmit --pretty false
node --experimental-strip-types --test \
  lib/v2/migration/load/loader.test.ts \
  lib/v2/migration/load/all-domains.test.ts
```

Run the representative 44-source all-domain load and targeted fault suite:

```sh
export VS_M3L_PGHOST="$M3L_ROOT/socket"
export VS_M3L_PGPORT=55507
export VS_M3L_PGUSER=vsm3loader
export VS_M3L_PGDATABASE=vs_loader_c
export VS_M3L_PSQL="$PGBIN/psql"

node --experimental-strip-types --test \
  lib/v2/migration/load/all-domains.integration.ts
node --experimental-strip-types --test \
  lib/v2/migration/load/loader.integration.ts
```

The all-domain gate must report 44 nonempty `migration.relation_counts` rows and
a succeeded run. Its target assertions cover verified and manual identities,
sessions, collections, pins, snoozes, draws, history, family evidence,
duration/provider queues, recommendation/configuration, support, worker/import/
cooldown/merge/audit outputs, exact 32-byte snapshot hashes, exact playtime and
`app.game_state.blacklisted=true` derived from legacy `Slept`. The fixture
waives only the synthetic support retention-policy blocker in its callback so
the physical support adapter can run; the real gate remains mandatory.
The fault gate must pass terminal-reader cleanup, precommit blockers, complete
transaction rollback, immutable replay, pinned-schema drift, large integer,
microsecond timestamp, COPY escaping, successful identity-sequence repair,
rollback of a transactional sequence restart after a later failure, report
privacy and remote-target refusal.

## Completed final local evidence

On 13 September 2026, the final fixture was run against the disposable local
PG17 cluster described here. `all-domains.integration.ts` passed 1/1, loading
and reconciling all 44 nonempty source relations and recording 44 nonempty
`migration.relation_counts` rows. `loader.integration.ts` passed 13/13,
including the transactional sequence-restart rollback regression. The matching
`tsc`, focused loader ESLint and loader/all-domain unit checks also passed
(23/23 units).

Stop only the disposable server started above:

```sh
"$PGBIN/pg_ctl" -D "$M3L_ROOT/data" stop -m fast
```

## Interpreting a refusal

- `loader_stage_failed`, `loader_stage_changed`, `loader_stage_limit`: discard
  the stage and fix the verified artifact or bound. No target mutation occurred.
- `loader_publication_refused`: inspect the value-free gate report. A transform
  exception, unresolved conflict, source/target coverage gap, missing supplied
  decision or fingerprint mismatch remains. Do not override it.
- `loader_run_mismatch` or `loader_replay_mismatch`: never reuse that run id for
  changed evidence. Correct the run packet or allocate a new run.
- `loader_target_failed`: inspect the local PostgreSQL log for the constraint or
  SQLSTATE. The complete transaction was rolled back.
- `loader_reconciliation_failed`: preserve the private report and discard the
  disposable target. Do not publish from a count-only comparison.

## Real-data gates still open

Local synthetic success is necessary evidence for the loader implementation,
not permission to run it on real data. A real run still requires:

- a fresh consistent export from the real source using a separately authorized
  credential, verified TLS and proof of full row visibility;
- the real manifest and source snapshot hashes;
- the independently pinned target schema fingerprint and migration hashes;
- source-dependent cutover observations and freeze decisions, including V13;
- zero withheld settings/counters/support rows, zero unresolved transform
  conflicts and zero provider physical gaps, or an approved resolution without
  data loss;
- an empty rehearsed target, measured real-data storage, a private reconciliation
  report, and operator approval after every precommit gate passes.

No synthetic row, fixture storage figure or local success can satisfy any item
in this list.
