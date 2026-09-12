# Target-apply review packet: M3 legacy-preservation follow-up

For root's apply decision. Nothing in this packet has been applied to the
target `vbjtbwelnhbbdfrqczyf`, to the source `pfvblcopcmairdfeqdep`, or to any
database holding real rows. Every result below comes from a disposable local
PostgreSQL 17 cluster built for this review and stopped after verification.

## What is being asked

| | |
|---|---|
| File | `database/v2/supabase/migrations/20260911234500_m3_legacy_preservation_followup.sql` |
| SHA256 | `beecb95c25e87f1b239f11f16e807338ec496df19ac27deffa5fb49b0bda5f59` |
| Version | `20260911234500` — unused; later than M3's `20260910232654` |
| Prepared from | `database/v2/proposals/m3_legacy_preservation_followup.sql`, DDL unchanged |
| Index status | `applied: false`, and its two new columns appear under `pending_columns` |
| Applies to | M1 + M2 + M3 exactly as recorded; the three SHA256s are unchanged |

## The four changes, and why each exists

1. **`app.retired_library_games.access_lost_at` becomes nullable**, under a new
   CHECK (`retired_library_games_null_loss_instant_requires_legacy_label`) that
   accepts a null only for `loss_reason = 'unknown'` **and**
   `legacy_ownership = 'Wishlist'`. A legacy Wishlist row has no source instant
   recording when access ended; inventing `now()` would date a loss at
   migration time.
2. **`app.retired_library_games.legacy_ownership text`** (nullable, CHECK
   `in ('Owned','Wishlist')`). Carries the verbatim source literal so the
   retirement is not read as "never owned".
3. **`app.game_activity.legacy_last_played_at timestamptz`** (nullable, no
   CHECK). The legacy row carries two distinct last-played readings; the one
   that does not seed `last_played_at` previously survived only in
   30-day staging.
4. **`disposition` CHECK widened to add `'retired'`** on
   `app.family_access_orphans` and `migration.legacy_family_access_orphans`, so
   a source-recorded family revocation is not misfiled as an
   identity-resolution failure.

## Safety properties, each checked rather than asserted

**Forward DDL is additive or permissive.** One relaxed NOT NULL, two new
nullable columns, one new table CHECK, and two widened CHECKs. The migration
does not drop, narrow, or retype a column and contains no DML. Adding a nullable
column with no default is a catalogue-only operation in PostgreSQL 11+.
Replacing a CHECK still takes the relevant table lock and validates the new
constraint against whatever rows exist when the migration runs; the dated
target observation below is readiness evidence, not a guarantee about that
future execution instant.

**Drift-safe.** Both CHECK replacements match the exact frozen constraint name
*and* the exact frozen `pg_get_constraintdef` text, and `raise exception
'drift: …'` otherwise. Proven by running the migration's own `DO` blocks a
second time against the already-widened cluster: both raise `P0001` with a
`drift:` message instead of dropping whatever they find.

**NULL-safe.** The new CHECK cannot pass by SQL UNKNOWN: `loss_reason` is NOT
NULL, and the `legacy_ownership is not null` conjunct forces a null label to
FALSE rather than UNKNOWN. Verified in PostgreSQL, not only in reasoning —
Wishlist accepted; `Owned`, NULL label, invalid literal, and both runtime
`loss_reason` values rejected with `23514`; the `now()` default still applies
to a write that names no `access_lost_at`.

**Privacy, retention and deletion unchanged.** Both altered `app` relations are
already registered in `ops.data_retention_registry` as
`durable-account-lifetime` / `holds_personal_data` / `account_fk_column =
'account_id'` / `deletion_mode 'cascade'` / `export_scope 'account_export'`.
The new columns add no account UUID, so `account_uuid_columns` stays `{}` and
the registry's `de_identify` rule is untouched. No registry row changes. The
gate asserts both new columns hold values before an account delete and that
every relation this domain writes is empty after it.

**RLS unchanged.** The migration creates no relation, so no `enable row level
security` / `force row level security` statement or policy is added, removed or
altered. The altered relations keep the RLS state M1/M3 gave them.

## Rollback

Before any preserved rows are loaded, the following DDL mechanically returns
the schema to its M3 shape. It is **pre-load only**. After a load, dropping
`legacy_last_played_at` or `legacy_ownership` destroys the populated values;
re-narrowing `disposition` and restoring `access_lost_at NOT NULL` can also fail
when the newly accepted rows exist. A post-load reversal therefore requires a
reviewed export or conversion of those facts and must not run as an automatic
rollback.

```sql
begin;
alter table migration.legacy_family_access_orphans
  drop constraint legacy_family_access_orphans_disposition_check;
alter table migration.legacy_family_access_orphans
  add constraint legacy_family_access_orphans_disposition_check
  check (disposition in ('quarantine', 'manual_review', 'resolved'));

alter table app.family_access_orphans
  drop constraint family_access_orphans_disposition_check;
alter table app.family_access_orphans
  add constraint family_access_orphans_disposition_check
  check (disposition in ('quarantine', 'manual_review', 'resolved'));

alter table app.game_activity drop column legacy_last_played_at;

alter table app.retired_library_games
  drop constraint retired_library_games_null_loss_instant_requires_legacy_label;
alter table app.retired_library_games drop column legacy_ownership;
alter table app.retired_library_games
  alter column access_lost_at set not null;
commit;
```

Even the pre-load rollback must run only after confirming the two new columns
are empty and no row uses the widened values. `DROP COLUMN` itself does not
fail closed when values exist; it removes them.

## Dated target precheck and apply procedure

The read-only target review captured on **12 September 2026** is stored in
`database/v2/m3-target-advisors-20260912.json`. At that observation time:

* `VaultShuffle2` (`vbjtbwelnhbbdfrqczyf`, `us-east-1`) was healthy and its M1
  marker named the expected project ref;
* only M1, M2, and M3 were recorded as applied, so this follow-up remained
  unapplied;
* `accounts`, `games`, and migration `runs` each contained zero rows;
* unforced-RLS and browser-table-grant checks both returned zero; and
* the advisors had no WARNING or ERROR findings. The 58 INFO
  RLS-without-policy findings describe private deny-by-default relations. The
  67 uncovered-FK and 14 unused-index INFO findings remain a workload,
  deletion, and retention measurement gate; an empty rehearsal is not evidence
  to add or remove those indexes.

Those facts are deliberately dated. Immediately before an authorized apply,
repeat the target identity, applied-version, drift, row-shape, and security
prechecks. Run this one-shot file through a migration path that guarantees a
transaction for the whole file; if the chosen runner does not provide that
guarantee, wrap the file in one transaction. A constraint replacement must not
be allowed to leave its old CHECK dropped after a later statement fails.

## Rebuild from empty

A fresh cluster replaying `20260906093036` → `20260907163356` →
`20260910232654` → `20260911234500` in that order reaches the same schema;
this is how every result in this packet was produced. The migration is not
idempotent by design: a second run raises the drift exception rather than
re-applying, which is the desired behaviour for a one-shot DDL step.

## Evidence

Local PostgreSQL 17, fresh disposable cluster, four files replayed in order.
`vsm3h` was a superuser only inside this throwaway cluster so the replay could
own and exercise every private relation:

```text
PGBIN=node_modules/.cache/vaultshuffle-pg17-20260910/bin
$PGBIN/initdb -D node_modules/.cache/vaultshuffle-m3-pres-final-20260912/data -U vault_local_admin -A trust --encoding=UTF8 --locale=C
$PGBIN/pg_ctl -D node_modules/.cache/vaultshuffle-m3-pres-final-20260912/data -o "-p 55503 -k /tmp/vs-m3-pres-final-20260912 -c listen_addresses=" start
$PGBIN/psql -h /tmp/vs-m3-pres-final-20260912 -p 55503 -U vault_local_admin -d postgres -c 'create role vsm3h login superuser;'
$PGBIN/createdb -h /tmp/vs-m3-pres-final-20260912 -p 55503 -U vault_local_admin -O vsm3h vaultshuffle_m3_pres_final
$PGBIN/psql -h /tmp/vs-m3-pres-final-20260912 -p 55503 -U vsm3h -d vaultshuffle_m3_pres_final -v ON_ERROR_STOP=1 -f database/v2/supabase/migrations/20260906093036_m1_private_foundation.sql
$PGBIN/psql -h /tmp/vs-m3-pres-final-20260912 -p 55503 -U vsm3h -d vaultshuffle_m3_pres_final -v ON_ERROR_STOP=1 -f database/v2/supabase/migrations/20260907163356_m2_jobs_quota_publish.sql
$PGBIN/psql -h /tmp/vs-m3-pres-final-20260912 -p 55503 -U vsm3h -d vaultshuffle_m3_pres_final -v ON_ERROR_STOP=1 -f database/v2/supabase/migrations/20260910232654_m3_preservation_schema.sql
$PGBIN/psql -h /tmp/vs-m3-pres-final-20260912 -p 55503 -U vsm3h -d vaultshuffle_m3_pres_final -v ON_ERROR_STOP=1 -f database/v2/supabase/migrations/20260911234500_m3_legacy_preservation_followup.sql
```

* Library/preservation gate: **27 passed, 0 failed**
  (`lib/v2/migration/transform/library-constraints.integration.ts`).
* Provider/legacy-catalogue gate: **17 passed, 0 failed**
  (`lib/v2/migration/transform/provider-constraints.integration.ts`), including
  metadata, duration, and tags rows coexisting for one game/provider under the
  physical composite key.
* Migration SHA256s unchanged: M1 `54fe0a7d…`, M2 `f09d7ca9…`, M3 `605b72a3…`.

## Remaining gates root still owns

* **Remote apply.** Not performed and not authorized here. The index, the
  migration header and the manifest all say `applied: false`; nothing may be
  reported as closed on the strength of a pending column.
* **Remote schema/security/rollback verification** for the target after any
  apply, which is root's own gate and is not implied by a local replay.
* **Real-source evidence.** Everything here runs on synthetic fixtures. The
  five source-dependent relation decisions and the exact-hours blocker in the
  manifest stay open; none of them is closed by this migration, and none may
  be closed from a historical aggregate audit instead of the real export.
* **Ordering with the load.** Apply before the first load. After preserved rows
  are populated, rollback becomes a data migration and the pre-load SQL above
  is destructive.
