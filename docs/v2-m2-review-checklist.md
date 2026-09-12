# M2 review closure checklist

M2 closed on 9 September 2026 against applied migration
`20260907163356_m2_jobs_quota_publish.sql`, SHA256
`f09d7ca900f3cdaaee81eff0f507adc5869865f16eb7f340eeb1729223bc5aba`.
This record retains the regressions identified during review and the evidence
required to keep them closed. The execution ledger records the actual gate.

## Closed database review findings

| ID | Regression that must be prevented | Required evidence |
|---|---|---|
| Q1 | Interactive calls consume the background bucket; retries double-debit one attempt UUID. | Interactive use can exceed the background burst without consuming it; concurrent identical attempt requests consume one charge and cannot authorize two HTTP calls. |
| Q2 | Attempt replay returns another account's token/identity or permits another HTTP call after charge/application/expiry. | Actual runtime-role missing/wrong context and changed endpoint/job/game replay are rejected; exact replay never grants fresh fetch permission. Runtime public lookup is quota-only and cannot accept arbitrary job IDs. |
| Q3 | A quota date, provider mode or expiry becomes stale while waiting for locks. | Clock/mode checks occur under the final serialization locks; lock-wait fixtures exercise expiry and mode changes. UTC daily accounting derives its day after the provider serialization lock. |
| Q4 | A missing fixture GUC passes SQL's three-valued boolean gate. | Provider fixture mode with missing/off context is rejected; explicit rollback fixture context succeeds. |
| J1 | A crashed fetching worker leaves its job permanently unclaimable. | Expired lease/VT can be reclaimed with a fresh charged attempt/token; old publish/retry/renew/ACK cannot mutate the replacement. |
| J2 | Deferred provider response becomes a short automatic retry. | Deferred transition stops automatic claiming and atomically acknowledges its own transport message; reason remains available for later operator/policy handling. Retry-After is never shortened. |
| J3 | Retry/ACK can delete or change visibility of a different job's message. | Wrong message ID leaves both jobs/messages unchanged; stale or expired lease cannot mutate queue state. |
| J4 | Request/coalesce, claim, publish, pinned observation and deletion take locks in conflicting orders. | One documented account/sync/job/charge order; two-connection request/claim and full/pinned fixtures complete without deadlock or invalid state. |
| J5 | Coalesced request aliases are forgotten after completion, or tenant FKs permit mismatches. | Retry every coalesced request key after completion returns its original job; different-account aliases cannot reference each other's jobs. Deleting a retained job clears only in_flight_job_id, not the nonnull account key. |
| P1 | A missing complete status or mismatched profile is accepted by pinned publication. | Missing/invalid status, charged-subject mismatch and inactive/merged account are rejected under locks; valid active manual/unverified profile works. |
| P2 | Pinned validation uses a pre-lock expiry or loses confirmation when minutes and last-played are unknown. | Post-lock expiry check; valid AppID-scoped null/null confirmation retains freshness against an older full snapshot; old pinned reply cannot recreate access removed by a newer complete full snapshot. |
| P3 | Reacquisition leaves an unknown-minute retired row, or unknown/decreased data changes retained timestamp provenance and revisions. | Retired row removed even when its minutes are null; greatest known minutes and last-played source remain consistent; semantic revisions reflect effective fact changes. |
| S1 | Newly applied unavailable/invalid outcomes violate the accepted TypeScript return contract. | Real SQL/orchestrator integration returns applied/already_applied/stale protocol results, while job outcome remains independently typed. All terminal outcomes preserve ownership unless complete. |
| S2 | Hash-only terminal replay confuses failed retry with committed snapshot publication or returns a different summary. | Bind replay to original lease/message and typed result/hash; conflicting input rejected; commit-then-response-loss yields the exact stored summary with no second fetch. applied_generation remains a generation, never account ID or library revision. |
| S3 | An older complete snapshot removes access or evidence confirmed by a newer pinned observation. | Concurrent full/pinned fixtures, explicit zero/private/malformed cases, competing lease/generation cases, and retirement/reacquisition with retained family/history/collections/pins. |
| S4 | Normalizer and SQL accept different canonical payloads, or unchanged imports rewrite all rows. | Actual normalizer-generated 10,000-game fixture through the TypeScript orchestrator and real SQL; validate exact hash, unchanged/changed writes and measured publish transaction against the five-second target. |

## Settled implementation corrections

- Keep the three-column active library; no reverse game index without a measured
  query that needs it.
- Store enrichment uses the separate disabled `steam_store` provider class and
  remains account-independent. It does not consume keyed Steam Web API quota.
- Retain successful job summaries for **14 days**, matching architecture §13.
  Earlier coordinator notes saying seven days were an error; terminal detail
  retention remains 30 days. Scheduled cleanup is M6.
- The final private ACL/function surface, fresh M1+M2 rebuild, non-owner SQL,
  concurrency fixtures, benchmark and target apply remain separate required
  gates. Never apply the evolving draft to the target as a shortcut.

## Final evidence

Q1–Q4, J1–J5, P1–P3 and S1–S4 are closed by final function review,
`database/v2/tests/m2.sql`, `m2_adversarial.sql`, `m2_concurrency.py`,
`m2_10k_local.mjs`, and the real TypeScript integration below. The database
checkpoint maps the detailed cases; core/adversarial fixtures also passed on
the authorized target with all synthetic data and temporary role changes
rolled back. All 35 private tables force RLS; target advisors have no warnings
or errors. See the execution ledger for INFO dispositions and remediation links.

Coordinator's independent fresh replay and SQL/concurrency/10k logs:
`/tmp/vaultshuffle-m2-coordinator-gate-{rebuild,fixtures,concurrency,10k}.log`.
Initial 10k publish measured 652.05 ms; new identical job measured 467.70 ms,
with zero changed counters and atomic ACK.

The durable `lib/v2/import/steam-owned-sql-integration.integration.ts` passed
on a separate fresh exact replay (`vaultshuffle_m2_import_gate`) with effective
`vault_worker`, explicit fixture mode and UTC transactions. It validates nonzero
exact summary replay after commit/response loss with one fetch, unchanged
library/activity tuple fingerprints on a new identical job, known/unknown
retirement and reacquisition, private/invalid/stale outcomes, and deferred ACK.
Actual initial publish RPC measured 644.804 ms. Log:
`/tmp/vaultshuffle-m2-import-gate-integration.log`.

Final `npm test`: 515/515; typecheck and targeted import lint passed. The
ordinary zero-network suite contains 56 v2 tests; actual SQL integration stays
explicitly opt-in. No live worker activation or M3 real-data parity is claimed.
