# M3 follow-up target behavioral rollback check

Prepared 12 September 2026 for root's later, separately approved rehearsal-target
execution. It does not authorize a target connection or execution.

Fixture: `database/v2/tests/m3-followup-target-rollback.sql`.

It is a single transaction that first requires the immutable target marker
(`vbjtbwelnhbbdfrqczyf`, schema marker `m1`) and the recorded
`supabase_migrations.schema_migrations` version `20260911234500`. It rejects
all prerequisite relations that the post-apply evidence reported empty, uses
explicit high synthetic IDs with `OVERRIDING SYSTEM VALUE`, and ends with an
unconditional `ROLLBACK`. A final metadata-only query proves no fixture IDs
survived. It contains no schema rollback DDL and does not mutate migration
metadata.

The fixture checks the applied follow-up behavior:

- only `legacy_ownership = 'Wishlist'` with `loss_reason = 'unknown'` permits a
  null `access_lost_at`; missing ownership, `Owned`, and another reason reject;
- ordinary retirement retains `access_lost_at`'s `now()` default;
- the two raw legacy play instants remain distinct in `app.game_activity`;
- `retired` is accepted by both durable and staging family-orphan relations;
- account deletion cascades all four follow-up evidence row kinds.

Reference evidence is
`database/v2/m3-followup-target-validation-20260912.json`: target marker,
version and expected zero-row prerequisite inventory are copied from its
postcheck. The immutable migration is
`database/v2/supabase/migrations/20260911234500_m3_legacy_preservation_followup.sql`,
SHA-256 `beecb95c25e87f1b239f11f16e807338ec496df19ac27deffa5fb49b0bda5f59`.

Local validation attempt:

```text
node_modules/.cache/vaultshuffle-pg17-20260910/bin/initdb \
  -D /private/tmp/vs-followup-rollback-pg -U vsfollowup -A trust \
  --encoding=UTF8 --locale=C
# blocked: PostgreSQL 17 bootstrap could not create a SysV shared-memory
# segment in this sandbox (EPERM); initdb removed the partial directory.

git diff --check -- database/v2/tests/m3-followup-target-rollback.sql
# passed
```

No escalation was requested because the assigned task only asks local PG
validation when the sandbox permits it. Root owns a later approved rehearsal
execution and should record its exact `psql` command/result here before closing
the target behavioral gate.

Root review corrected the four orphan inserts to override their own identity
columns too, added the empty `migration.runs` precondition, and populated the
two new preservation columns in the cascade fixture. These edits are also
awaiting actual PostgreSQL execution; this packet is prepared, not validated.
