# M3 source probes — count-only, for coordinator review

**No probe in this directory has been run against the source project.** These
are proposed read-only queries for coordinator review. No source data has been
read by this bundle, so **no violation in this milestone has been MEASURED**.
The local fixture runner executes the public files only against synthetic rows
when validating SQL; that result is a test of compilation and detection, not
source evidence. Everything the readiness report and the disposition manifest
call a conflict is a **potential** conflict derived from schema metadata and
repository code. The whole purpose of these probes is to turn potential into
measured during the authorized export.

## The rules these files obey

1. **Counts and aggregates only.** Every statement returns `count(*)`, a
   `min`/`max`/`sum`, a bounded `GROUP BY` over a low-cardinality column, or a
   boolean. No statement returns a row of user data.
2. **No personal data leaves a probe.** No email address, no display name, no
   note text, no message body, no session or token digest, no `key_hash`, no
   Steam ID, no URL, no raw `date_added` string, no JSON *value*. Where a
   grouping key could itself be identifying, the probe groups by a bucketed or
   hashed-and-discarded expression instead, or counts without grouping.
3. **`vault.secrets` is never read.** Not counted, not described, not touched.
   The same applies to any decrypted view over it.
4. **Platform objects are optional and isolated.** `platform-optional.sql` is
   run only after its `@requires` relation preflight succeeds. It reports fixed
   schema/status buckets and aggregate bounds. The `command` column of a cron
   job can contain an `Authorization:` header, so it is never selected. `P02c`
   returns only booleans, lengths and counts needed to plan schedule fencing.
5. **Read-only.** No DDL, no DML, no `SELECT ... FOR UPDATE`, no function that
   writes. These are safe to run inside `SET TRANSACTION READ ONLY`.
6. **`LIMIT` is not a safety mechanism.** A probe that would need `LIMIT` to be
   safe is not count-only and does not belong here.

## Files

| File | Covers |
|---|---|
| `p01-p04-inventory-and-access.sql` | readiness 10 items 1–4 |
| `p05-p06-playtime-and-staging.sql` | readiness 10 items 5–6 |
| `p07-constraint-conflicts.sql` | readiness 10 item 7, plus readiness 4 and 14 |
| `p08-code-books.sql` | readiness 10 item 8 |
| `px-value-domains.sql` | value-domain distributions this batch added |
| `platform-optional.sql` | optional auth, cron, queue, storage and migration metadata |

`readiness 10 item 9` (byte accounting) is **not a source probe**. It requires a
real load into the target and is a gate on the M3 rehearsal, not a question the
source can answer. It is listed here only so the nine items stay accounted for.

## How to run them (when authorised)

Not authorised yet. When they are, run them in one read-only transaction against
the source, capture only the returned counts, and paste those counts into the
conflict report — never the queries' inputs.

```
-- illustrative only; not run in this batch
begin;
set transaction read only;
set local statement_timeout = '120s';
\i p07-constraint-conflicts.sql
commit;
```

Each probe is written to be independently runnable and independently reviewable.
Several are deliberately expensive (full scans of `user_games`); they are meant
for a one-off freeze-time measurement, not for repeated execution against a live
production database serving users.
