# M2 implementation checkpoint

Updated 2026-09-09. M2 is complete and applied only to the authorized
VaultShuffle2 development/rehearsal target. M1 and M2 are immutable. No
production database, deployment, environment or provider worker was changed.

Coordinator's final independent evidence is recorded in
`../../docs/v2-execution-status.md`: exact fresh replay and base/adversarial/
concurrency tests in `vaultshuffle_m2_coordinator_gate`; actual 10k publish
652.05 ms / no-op 467.70 ms; a separate durable TypeScript integration on fresh
`vaultshuffle_m2_import_gate` passed with actual initial publish 644.804 ms,
nonzero exact response-loss replay, unchanged tuple fingerprints and unknown
minute reacquisition. Target base/adversarial rollback fixtures also passed on
9 September, all 35 private tables force RLS, providers are disabled and target
fixture data is zero. Advisors have no WARN/ERROR; INFO findings and follow-up
measurement scope are recorded in the ledger. The local filename was aligned
to remote migration version `20260907163356` without changing its content.

The owner batch evidence below is retained as additional evidence; references
to coordinator ownership of old import replay logs are superseded by the
independent gate logs `/tmp/vaultshuffle-m2-coordinator-gate-*.log`.

## Frozen implementation

- Migration: `supabase/migrations/20260907163356_m2_jobs_quota_publish.sql`
- Migration SHA-256:
  `f09d7ca900f3cdaaee81eff0f507adc5869865f16eb7f340eeb1729223bc5aba`
- M1 SHA-256 remains:
  `54fe0a7defd029e91568b78d51393670ac7ca6edcf915919670c7f64c2476389`
- Contract: `M2-contract.md`, updated to the settled queue, token-bucket,
  profile, canonical-text, pinned-fence, retention, Store-provider, and
  lock-order decisions.
- README: `README.md`, now includes portable replay commands and the exact
  local fixture/benchmark procedure.

The migration creates default-version PGMQ queues
`vault_interactive`/`vault_background`, private forced-RLS job/quota/charge/
outbox relations, fixed-search-path definer wrappers, exact canonical-text
publish validation, account/job alias fencing, lease reclaim, deferred ACK,
manual-unverified profile support, and sparse full/pinned observation fences.
It contains no credentials, provider keys, session tokens, raw response bodies,
or network calls. The rejected reverse `(game_id, account_id)` library index
is absent.

## Fresh replay and local evidence

The final local replay used a fresh PG17.6 database
`vaultshuffle_m2_capability_rebuild`, applying the exact immutable M1 migration and
then the frozen M2 migration with `psql -X -1 -v ON_ERROR_STOP=1`. The replay
created PGMQ 1.5.1 and both durable queues. The coordinator's independent
fresh replay logs are in `/tmp/vaultshuffle-m2-import-m1-replay.log` and
`/tmp/vaultshuffle-m2-import-m2-replay.log`; the final fixture logs are:

- `/tmp/vaultshuffle-m2-capability-base.log`: exit 0, final `ROLLBACK`.
- `/tmp/vaultshuffle-m2-capability-adversarial.log`: exit 0, final `ROLLBACK`.
- `/tmp/vaultshuffle-m2-capability-concurrency.log`: exit 0, duplicate-attempt and
  full/pinned two-connection assertions passed.
- `/tmp/vaultshuffle-m2-capability-10k-safe-final.log`: exit 0, real
  normalizer/SQL benchmark using only transaction-local role switching.
- `/tmp/vaultshuffle-m2-capability-cleanup-final.log`: zero fixture rows and zero
  membership changes after both harnesses.
- `/tmp/vaultshuffle-m2-capability-security.log`: PGMQ, forced-RLS, role, and ACL
  queries.

The final management-compatible SQL fixture (`tests/m2.sql`) is one
rollback-only transaction and passed after adding missing/off fixture-GUC,
pre-session principal, endpoint-replay, worker raw-helper/PGMQ denial, and
post-migration default-ACL assertions. It also verifies tenant status/library
isolation, account aliases, complete digest rejection and replay, changed-only
publication, family/history/collection/snooze preservation, wishlist pins,
current-pick invalidation, interactive-only global quota debit, and forced RLS.

The adversarial SQL fixture (`tests/m2_adversarial.sql`) is also rollback-only
and passed. It covers expired lease reclaim with a fresh charge/token, fencing
old publish/renew/retry/ACK calls, deferred retry ACK and no re-enqueue,
mismatched message IDs, typed `unavailable`/`invalid` outcomes returning
protocol `applied`, exact terminal response-loss replay, manual unverified
profiles, null/null pinned freshness, retired-row removal, and old-pinned/new-
full plus new-pinned/old-full ordering. It also changes a job's sync pointer to
both a newer and an older generation and changes its active profile Steam ID;
publish, renew, and retry all return typed stale results in each case. The
focused capability cases cover complete-zero, all-null fields, positive versus
zero last-played epochs, private-after-known, and provider-error/invalid after
known visibility.

The two-connection harness (`tests/m2_concurrency.py`) passed with one charge
row for the raced attempt UUID and an `attempt_already_charged` second result.
Its full/pinned fence interleaving accepted the pinned observation, applied
the older empty full snapshot with `sweep_deferred_count = 1`, and retained
the library row. Its `finally` cleanup now deletes both the fixture account
and its catalogue game. It authenticates every connection with the explicitly
supplied local setup/admin login, uses `SET LOCAL ROLE` inside each runtime
transaction, and never changes cluster role memberships.

The real TypeScript normalizer/SQL adapter benchmark
(`tests/m2_10k_local.mjs`) passed twice on the same clean local replay:

- canonical document: 1,737,832 bytes; provider body: 839,394 bytes;
  10,000 games; exact SHA-256
  `5cac4a392b56f5b94ea48313280b0eedb39a40c5bf5a5277c612fde87780f68c`;
- first publish: 630.72 ms, 10,000 library changes, 9,999 sparse activity
  changes, 10,000 Store outbox inserts, atomic ACK;
- identical second publish: 446.74 ms, zero library/activity/outbox changes,
  atomic ACK;
- both transactions stayed below the five-second target budget and returned
  the exact stored hash/count summary.

The Node benchmark requires `M2_ADMIN_USER` as an explicit local setup login;
its SQL adapter authenticates as that login and switches to `vault_app` or
`vault_worker` with `SET LOCAL ROLE` per transaction. It performs no cluster
`GRANT` or `REVOKE` and restores only its fixture rows, quota values, and
provider mode.

The final cleanup query reports zero accounts, fixed-fixture catalogue games,
fixed outbox rows, provider charges, and jobs. Static security evidence reports
PGMQ 1.5.1, both queues, all seven M2 `ops` relations with
`relrowsecurity = relforcerowsecurity = true`, no PGMQ schema usage or direct
`ops.jobs`/raw-charge privileges for `vault_app`, `vault_worker`, or `public`,
and both runtime roles `NOLOGIN`, non-superuser, non-CREATEROLE,
non-CREATEDB, non-replication, and `NOBYPASSRLS`. The intended wrappers and
narrow marker helper are executable only by their runtime roles; public marker
execute is false.

Python syntax compilation and Node syntax checking also passed:

```sh
PYTHONPYCACHEPREFIX=/tmp/vaultshuffle-m2-pyc python3 -m py_compile \
  database/v2/tests/m2_concurrency.py database/v2/tests/m1_family_concurrency.py
node --check database/v2/tests/m2_10k_local.mjs
```

## Review closure mapping

| IDs | Closure evidence |
|---|---|
| Q1 | `m2.sql` interactive/background counters plus `m2_concurrency.py` duplicate UUID race. |
| Q2 | `m2.sql` pre-session/wrong-account/endpoint replay and runtime ACL assertions; raw helper is not granted. |
| Q3 | Frozen migration locks provider control before fresh UTC date/bucket clock; fixtures exercise provider/lease paths under those locks. |
| Q4 | `m2.sql` resets the fixture GUC and tests both missing and `off`; only explicit `on` succeeds. |
| J1 | `m2_adversarial.sql` expires a lease, reclaims with attempt 2, and fences every old-token mutation. |
| J2 | Adversarial deferred retry stores the provider delay, ACKs the current message, and cannot re-enqueue/claim. |
| J3 | Adversarial wrong-message retry/ACK leaves job lease and message identity unchanged. |
| J4 | Queue advisory lock plus queue → sync → job/charge ordering; two-connection fence run completed without deadlock. |
| J5 | Main fixture retains coalesced aliases through completion and validates tenant status; compound account/job FK is migration-enforced. |
| P1 | Adversarial manual/unverified profile and strict pinned status/AppID/profile checks. |
| P2 | Adversarial post-lock expiry/sparse null-null confirmation and old pinned reply rejection after newer full; exact sync/profile stale checks cover publish, renew, and retry. |
| P3 | Migration removes retired rows on reacquisition and preserves greatest minutes/timestamp provenance; adversarial path passes. |
| S1 | Adversarial private/invalid SQL publish returns `applied` while job rows retain typed terminal statuses. |
| S2 | Main complete response-loss replay and adversarial private replay return exact stored summaries bound to lease/message/hash/status. |
| S3 | Main preservation/sweep fixture and adversarial both observation orderings pass; no partial publish follows bad digest. |
| S4 | Adversarial capability/epoch cases plus actual normalizer 10k run validate visibility semantics, exact canonical digest, changed/no-op counters, and sub-five-second publish timings. |

## Later integration limits

Coordinator integration review, exact target apply, target fixtures, migration
history alignment and M2 signoff are now complete as recorded above.
Background pinned/recent/Store/SteamSpy live consumers, Store retry
policy, scheduled TTL cleanup, and preview-to-live provider cutover remain
later integration work; the M2 Store outbox is durable and disabled.
