# VaultShuffle v2 M1 database foundation

The M1 migration is a clean, private PostgreSQL 17 foundation for the v2
target. It creates the `app`, `catalog`, `reco`, `ops`, and `migration` schemas,
but the Supabase API configuration intentionally exposes only `public`; the
private schemas are not browser/Data API schemas.

The generated migration is:

`supabase/migrations/20260906093036_m1_private_foundation.sql`

It creates `NOLOGIN`, `NOSUPERUSER`, `NOBYPASSRLS` group roles
`vault_app` and `vault_worker` when they do not already exist. An existing role
with unsafe login, owner, replication, database-creation, role-creation, or
RLS-bypass attributes causes the migration to fail closed. Login roles,
passwords, session secrets, and membership provisioning remain outside the
migration.

The account/session foundation keeps an internal integer account key alongside
the preserved public UUID. Accounts are `manual` or `steam`; a verified Steam
profile has the only unique Steam identity claim, while unverified public
profiles may share a Steam ID. Sessions store only a 32-byte digest and have a
kind, expiry, revocation timestamp, and account FK. `app.resolve_session(bytea,
text)` is the only session resolver: it uses the database statement clock,
requires the expected `manual` or `verified_steam` branch, checks the account
kind and verified profile, and returns the minimum principal fields.

Tenant tables use forced RLS with a fail-closed transaction-local
`app.account_id`; both `USING` and `WITH CHECK` are present. The runtime group
has narrow reads and mutation grants. Identity/verification, session digest,
and import-owned library columns have no direct runtime write grant. The
worker can read shared catalogue rows and the marker helper, but has no blanket
private or session access. `ops.auth_intents` permits an anonymous OpenID nonce
before a session exists and requires an exact `(account_id, session_id)` pair
for promotion. Merge audit rows use `promote` for an in-place account and
`merge` for distinct source/target accounts; both account FKs cascade so
deletion does not block or retain private derivatives.

The locally prepared 12 September follow-up replaces the old Sleep fields with
`app.game_state.blacklisted boolean`: an undated permanent exclusion cleared
only by explicit Reactivate. It retires Sleep-only timestamps and audit fields;
`app.snoozes.until_at` remains a separate timed Vault feature. Active library
rows remain compact, observations retain `observed_at`, retired rows retain the
last observation and a bounded loss reason, and daily observed minutes use
`bigint`. Family candidate JSON is bounded and the five-member cap serializes
on the parent account row. The trigger performs a same-value parent update so
concurrent `REPEATABLE READ` and `SERIALIZABLE` writers receive a PostgreSQL
serialization failure instead of committing a sixth member.

The migration conditionally revokes execute access on the exact existing
`public.rls_auto_enable()` helper if that helper is present and owned by the
migration role. It does not alter the event trigger or the helper body. Global
and per-schema default privileges revoke implicit `PUBLIC`, `anon`, and
`authenticated` access before private functions are created. The SQL fixture
also creates a disposable post-migration function to verify that default ACL.

For a clean local PG17 replay, use an empty database and the direct client for
that cluster. The following uses the supplied local server; it does not apply
anything to Supabase:

```sh
/tmp/vaultshuffle-pg17/bin/psql \
  -h /tmp/vaultshuffle-pg17-socket -p 55432 -U postgres -d vaultshuffle_m1 \
  -X -1 -v ON_ERROR_STOP=1 \
  -f database/v2/supabase/migrations/20260906093036_m1_private_foundation.sql
```

The migration is intended for one clean replay. To rehearse again, create a
separate empty database on the same PG17 cluster and run the same command with
that database name. Do not run `DROP DATABASE` or a blanket truncate as part of
the application procedure. The role block validates existing runtime roles;
it never changes unsafe role attributes through a non-superuser migration
owner. On PG17, the role creator may have `ADMIN` without the `SET` membership
option, so any login used to exercise `SET ROLE` needs an explicit membership
grant from the role administrator.

Run the pure SQL fixture only against a disposable rehearsal database:

```sh
/tmp/vaultshuffle-pg17/bin/psql \
  -h /tmp/vaultshuffle-pg17-socket -p 55432 -U postgres -d vaultshuffle_m1 \
  -X -v ON_ERROR_STOP=1 -f database/v2/tests/m1.sql
```

The fixture grants `vault_app` and `vault_worker` to its current test operator
with the PG17 `SET` option inside its transaction, then rolls that grant and
all generated rows back. It never truncates or deletes pre-existing rows. It
covers malformed/missing/negative/overflow principals, kind/expiry/revocation,
verified and unverified identity uniqueness, cross-account RLS and compound
FKs, denied sensitive writes, nested rollback, worker access, browser ACLs,
the marker, sparse-state bounds, family limits, intent binding, and account
deletion cascades.

Run the elapsed statement-clock regression separately through a direct psql
session:

```sh
/tmp/vaultshuffle-pg17/bin/psql \
  -h /tmp/vaultshuffle-pg17-socket -p 55432 -U postgres -d vaultshuffle_m1 \
  -X -v ON_ERROR_STOP=1 -f database/v2/tests/m1_session_clock.sql
```

This file must be sent as separate protocol statements because it inserts a
session with a one-second expiry, waits in a separate `pg_sleep` statement,
then resolves it. A management `execute_sql` request that wraps the entire
file as one server query cannot provide that statement-time boundary. The
main `m1.sql` fixture keeps the already-expired-session assertion and remains
safe for management execution.

Run the separate concurrency harness after the migration and fixture checks:

```sh
python3 database/v2/tests/m1_family_concurrency.py \
  --psql /tmp/vaultshuffle-pg17/bin/psql \
  --host /tmp/vaultshuffle-pg17-socket --port 55432 \
  --user postgres --database vaultshuffle_m1
```

It opens two independent `psql` connections for `READ COMMITTED`,
`REPEATABLE READ`, and `SERIALIZABLE`, expects the second writer to fail, and
checks that five members remain. Each synthetic account is deleted in a
`finally` block. The harness uses only Python's standard library and stores no
credentials.

The deployment marker is readable through the narrow helper only:

```sql
select * from app.read_project_marker();
```

The expected result is `VaultShuffle2`, project ref
`vbjtbwelnhbbdfrqczyf`, and schema version `m1`. The coordinator owns review
and target apply. Promotion/merge execution, profile mutation functions,
import normalization/application, page repositories, and product parity remain
later milestones; this migration supplies their M1 relational primitives.

## M2 job, quota, and publication rehearsal

M2 is the additive migration
`supabase/migrations/20260907163356_m2_jobs_quota_publish.sql`.
The local implementation was replayed after the immutable M1 migration in the
fresh PG17.6 database `vaultshuffle_m2_capability_rebuild`; its SHA-256 is
`f09d7ca900f3cdaaee81eff0f507adc5869865f16eb7f340eeb1729223bc5aba`.
The coordinator applied this exact migration to VaultShuffle2 and signed off
M2 on 9 September; see `M2-checkpoint.md`. These commands are local rehearsal
examples only and must use an empty database for a fresh replay:

```sh
/tmp/vaultshuffle-pg17/bin/psql \
  -h /tmp/vaultshuffle-pg17-socket -p 55432 -U vault_local_admin \
  -d vaultshuffle_m2_capability_rebuild -X -1 -v ON_ERROR_STOP=1 \
  -f database/v2/supabase/migrations/20260906093036_m1_private_foundation.sql \
  -f database/v2/supabase/migrations/20260907163356_m2_jobs_quota_publish.sql
```

The M2 migration installs the available default PGMQ extension version and
creates `vault_interactive` and `vault_background`. It does not pin an
extension version, grant direct PGMQ or `ops` table access to runtime roles, or
store provider credentials/bodies. `vault_app` and `vault_worker` remain
`NOLOGIN`, non-owner, and `NOBYPASSRLS`. The pure SQL fixtures grant temporary
`SET ROLE` membership inside their rollback transaction. The Python and Node
harnesses instead require an explicitly supplied local setup/admin login that
can execute `SET LOCAL ROLE vault_app` and `SET LOCAL ROLE vault_worker`; they
never grant or revoke cluster role memberships. Provider mode is disabled by
default; fixture mode is enabled only by an explicit local rollback fixture,
and live network calls are never made by these tests.

Run the management-compatible fixture and the adversarial lease/replay/fence
fixture against a disposable replay:

```sh
/tmp/vaultshuffle-pg17/bin/psql \
  -h /tmp/vaultshuffle-pg17-socket -p 55432 -U vault_local_admin \
  -d vaultshuffle_m2_capability_rebuild -X -v ON_ERROR_STOP=1 \
  -f database/v2/tests/m2.sql

/tmp/vaultshuffle-pg17/bin/psql \
  -h /tmp/vaultshuffle-pg17-socket -p 55432 -U vault_local_admin \
  -d vaultshuffle_m2_capability_rebuild -X -v ON_ERROR_STOP=1 \
  -f database/v2/tests/m2_adversarial.sql
```

Both SQL fixtures are one rollback-only transaction. They contain no psql
variables inside dollar-quoted blocks, no `TRUNCATE`, and no blanket cleanup;
the first covers tenant/RLS, canonical publication, aliases, quota, ACL, and
default privileges, while the second covers expired lease reclaim, stale
token/message fencing, deferred acknowledgement, typed terminal outcomes,
manual unverified profiles, both pinned/full observation orderings, positive
last-played epoch enforcement, and capability visibility transitions for
complete-zero, all-null, private, and transient error results.

The two-connection quota and observation harness uses only Python's standard
library. It tests duplicate attempt serialization and the full/pinned fence,
then deletes its own account and catalogue game in `finally`:

```sh
python3 database/v2/tests/m2_concurrency.py \
  --psql /tmp/vaultshuffle-pg17/bin/psql \
  --host /tmp/vaultshuffle-pg17-socket --port 55432 \
  --admin-user vault_local_admin \
  --database vaultshuffle_m2_capability_rebuild
```

The real TypeScript normalizer and SQL adapter benchmark is explicitly local
and opt-in. It creates a 10,000-game fixture, publishes it twice, checks the
exact canonical text digest, and restores provider mode, quota, roles, and all
synthetic rows:

```sh
M2_ADMIN_USER=vault_local_admin PGUSER=vault_local_admin PGDATABASE=vaultshuffle_m2_capability_rebuild \
M2_ADMIN_USER=vault_local_admin \
node database/v2/tests/m2_10k_local.mjs
```

The final local run produced a 1,737,832-byte canonical document and a
5cac4a392b56f5b94ea48313280b0eedb39a40c5bf5a5277c612fde87780f68c digest.
The first publish took 630.72 ms and changed 10,000 library rows, 9,999
sparse activity rows, and queued 10,000 deduplicated Store outbox rows. The
second identical publish took 446.74 ms and changed zero library/activity
rows or outbox rows. Both acknowledged atomically and stayed below the five
second transaction budget. The post-run check found zero accounts, fixed
catalogue games, fixed outbox rows, provider charges, and jobs.

The exact review mapping and checkpoint are in
[`M2-checkpoint.md`](M2-checkpoint.md). M2 remains a private foundation: Store
enrichment is a disabled, account-independent outbox class, and background
consumer wiring, retry cleanup, and live provider policy remain later
integration work.
