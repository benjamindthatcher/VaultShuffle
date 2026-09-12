# VaultShuffle v2 execution status

Updated: 12 September 2026 (London). Plan: [architecture and execution plan](VaultShuffle_v2_architecture_plan.md).

## Authority and isolation

- Working branch: `codex/v2-architecture`, starting at `2e82939a9f1e8f85cd9516eafdc377ab1866e9eb`.
- Production source `pfvblcopcmairdfeqdep`: read-only audit only; still authoritative.
- Initially empty target `vbjtbwelnhbbdfrqczyf`: authorized v2 development/rehearsal database.
- Separate migration root: `database/v2/supabase/`; legacy root is not a complete blank-database baseline.
- No production environment, deployment, worker schedule or database has been changed.

## Milestones

| ID | State | Evidence / next action |
|---|---|---|
| M0 | Complete | Source/live audit, independent reviews, portable plan, separate branch and empty target verified. |
| M1 | Complete | Exact final fresh rebuild, non-owner SQL/clock/concurrency fixtures and target apply/SQL checks passed. See latest checkpoint. |
| M2 | Complete | Exact immutable migration applied; fresh rebuild, target/local adversarial SQL, concurrency, real 10k orchestrator, replay and changed-only tuple tests passed. |
| M3 | In progress | M3 schema and target security gate accepted. Three Codex batches now cover preservation/provider integration, remaining transforms and the local loader/reconciliation pipeline. Real consistent export, real rehearsal parity and storage remain pending. |
| M4–M7 | Pending | Application parity, load/recovery verification and eventual production cutover. |
| F1–F3 | Planned | Opt-in achievement/purchase features and evidence-gated model experiments. |

## Prerequisites found

Only the legacy Supabase URL/service-role key is available in `.env.local`. v2 application credentials, Steam key and the existing `SESSION_SECRET` were not present there. PostgreSQL 17 clients and a synthetic local server have since been built under `/tmp` (details below); Docker is absent. Consistent export and authenticated preview still require suitable private credentials/runtime later. Do not copy secrets into this file.

## Timestamp region check — 7 September

User highlighted source Ireland versus target Virginia. Read-only management queries on both projects reported session `TimeZone=UTC` and UTC server timestamps around 2026-09-07 02:00 UTC. Information-schema checks found zero `timestamp without time zone` columns in source `public` or the target's currently applied private domain schemas. Do not apply a geographic offset to stored instants. M3 must still verify dates, numeric epochs, strings/JSON timestamp provenance and session/display conversions under the export's explicit UTC canonicalization. This was metadata/time inspection only; no production writes. The unrelated synthetic future-epoch bug was corrected to historical epoch 1700000000 with runtime receipt provenance.

## Pre-existing uncommitted changes (preserved)

`README.md`, `eslint.config.mjs`, `docs/database-capacity-plan.md`, `data/catalogue/gap-field-needs-2026-09-02.json`, `data/catalogue/store-gap-appids-2026-09-02.txt`, `scripts/catalogue/apply-steam-gap-writeback.mjs`, `scripts/catalogue/enrich-steam-gaps.mjs`, `scripts/catalogue/enrich-steam-tags.mjs`, `scripts/catalogue/steam-gap-mapping.mjs`, `scripts/catalogue/steam-gap-mapping.test.mjs`, `scripts/durations/select-hltb-review-input.sql`.

They remain the user's work and are not evidence that v2 has been implemented. No pre-existing file has been reset or reverted.

## Continuation rules

Read the plan and this ledger, inspect Git status, verify the target project marker, then continue the first incomplete milestone. Update this file with actual migrations, test commands, results and deviations. Never mark M3 complete for synthetic fixtures or M6 complete for a storage estimate. Keep production authoritative until the final gated cutover.

## Immediate priority — permanent Blacklist, then resume M3

**Latest resume:** A completed the database/V2 Blacklist batch. B completed the runtime
conversion, standing-preference correction, real mocked-clock regression and
the guest UI test. The browser execution is pending: sandbox listener failed
with EPERM on port 8799, then automatic approval review rejected the ordinary
local-only escalation because the account usage limit was reached. Do not
bypass that rejection; rerun normally when allowance returns. B is now
preparing only the independent prior-follow-up target rollback fixture
(`database/v2/tests/m3-followup-target-rollback.sql`); remote execution remains
root-owned. Maximum two active workers. A froze two UNAPPLIED Blacklist migrations
(`supabase/migrations/20260912192336_replace_sleep_with_blacklist.sql` and
`database/v2/supabase/migrations/20260912193000_blacklist_semantics.sql`) plus
truthful applied/pending index changes. Its focused gate passed 178 unit tests,
121 Python checks, 27 V2 PG integration tests, clean TypeScript, a fresh five-
migration PG17 replay, and both V2 and legacy behavioral SQL fixtures. B's initial
UI/runtime conversion passed 70 tests/build; its completed correction passed
32 focused tests and TypeScript, preserving negative preference contribution
from undated current Blacklisted state without new time/history metadata.
Do not treat initial UI success as end-to-end feature completion. Generic M3
loader remains paused until Blacklist is validated.

The user's 12 September request replaces timed Library Sleep with permanent
Blacklist using the same existing behavior. Active -> Blacklist -> inactive
Blacklisted pool until explicit manual Reactivate -> active. No time limit or
automatic expiry. Remove Sleep-only timestamps/history/restore metadata;
do not build a new state/history/event subsystem. Existing completion/manual
reactivation behavior and the separate Vault snooze feature remain. This
explicit product decision supersedes old Sleep-timestamp preservation rules.
After this narrow change is implemented and validated, **resume database M3**.

Two agents are assigned (maximum two active, no delegation):

- `m3_preservation_integration`, Sol/High: database/new migrations, V2
  transform/manifest/load-contract updates and SQL tests. Owns database/v2/**,
  necessary NEW legacy compatibility SQL, and narrow lib/v2/** changes.
  Latest state is `app.game_state.blacklisted boolean NOT NULL DEFAULT false`
  in the existing sparse state row. No timestamp denotes Blacklist membership.
- `m3_remaining_domains`, Terra/Medium: non-V2 runtime, types, validation,
  UI labels/actions/section, optimistic updates, classification/filters and
  relevant tests. Owns app/**, components/** and lib/** excluding lib/v2/**.

Both received the full bounded feature scope and must coordinate their SQL/
status interface directly. Root reviews completed results, not intermediate
implementation. New checkpoints: `docs/v2-blacklist-database-checkpoint.md`
and `docs/v2-blacklist-runtime-checkpoint.md`.

The generic M3 loader worker is stopped after hitting allowance; do not resume
it concurrently with the Blacklist schema/transform work. Its partial pipeline
and unresolved acceptance gaps remain saved. Once Blacklist completes, resume
that worker on Sol/High, integrating the new schema before its all-domain
actual PostgreSQL end-to-end gate.

**New Git baseline:** user commit `0b2c934` (database update) includes previous
work, on `codex/v2-architecture`. Preserve it and any unrelated subsequent
changes; no root commit/push.

**Critical applied-state update:** root successfully applied
`20260911234500_m3_legacy_preservation_followup.sql` to the separate target
`vbjtbwelnhbbdfrqczyf` via the normal CLI migration command after exact file
inventory/hash verification and a fresh empty-target/drift/security precheck.
SHA256 remains
`beecb95c25e87f1b239f11f16e807338ec496df19ac27deffa5fb49b0bda5f59`.
This fourth migration is now IMMUTABLE. Postcheck at 2026-09-12T14:58:40Z
verified the four migration records, both new nullable columns, runtime now()
default, exact widened orphan constraints, zero private browser grants,
forced RLS and zero rows. Evidence:
`database/v2/m3-followup-target-validation-20260912.json`.
The earlier approval-service block cleared after the user's approval/retry.
A owns fixing the stale local applied-index flag alongside the new schema.
A target behavioral rollback fixture remains pending; local 27-test behavior
was already proven. No source writes or real target load occurred.

## Current execution policy — maximum two workers

**Wait override removed as a requirement:** the user withdrew the fixed
25-minute wait rule. Current `/Users/benthatcher/.codex/config.toml` parses
successfully and contains none of `multi_agent_v2`, `min_wait_timeout_ms`,
`default_wait_timeout_ms`, or `max_wait_timeout_ms`; the project has no
`.codex/config.toml`. No config edit was necessary. Stop explicitly supplying
1,500,000ms waits; use normal interruptible waits. Continue letting complete
worker batches finish without routine intermediate supervision.

Latest user amendment allows **one additional subagent for independent work,
maximum TWO active**. Use Sol, Terra or Luna with appropriate effort. Let each
assigned batch finish autonomously; do not supervise routine intermediate work.
This supersedes the preceding one-worker-only rule and older three-worker
concurrency allowances. No worker may start or resume another worker itself.

Current assignments are the two Blacklist batches described above. The
general loader is paused. Its resumption packet is
`docs/v2-m3-loader-resume-after-blacklist.md`; its older checkpoint is stale
and must not be mistaken for current implementation progress.

Previously accepted preservation work passed 128 provider/catalogue unit,
17 actual PostgreSQL and 121 Python checks. Previously completed remaining
transforms and boundary repairs are preserved. The generic assembler's empty
fixtures did not establish all-domain acceptance.

The earlier approval-service allowance block cleared after the user's
approval. The fourth migration is applied, as recorded above. Connector
availability may vary; inspect available tools once and use normal authorized
target tooling rather than repeatedly retrying unavailable connectors.

If account allowance blocks a worker, retain its checkpoint and queue rather
than trying models repeatedly. Every worker must persist exact next steps.
No completed worker batch establishes overall M3 completion.

## Resume — 12 September 2026

The user confirms Claude completed work during the Codex allowance outage.
All three Codex workers had stopped on usage limits. On-disk A and B returns
now report completed batches; loader files extend beyond its stale checkpoint.
Root resumed the same Sol/High A and C, Terra/Medium B workers with targeted
integration/repair scopes, explicitly preserving completed Claude work.

A: finish acceptance of new provider durability and pending-schema/index
changes, missing Python regression gate and truthful apply packet. B: remaining
transform accounting/security boundary integration with loader, fix reproduced
issues only; exact counters that exceed target precision remain blockers.
C: finish full concrete loader and actual end-to-end gate from current files;
root identified precommit ordering, self-derived schema fingerprint, incorrect
per-relation counts and sequence-test gaps to repair. Exclusive ownership is
still as in the dispatch. No routine intermediate supervision.

The earlier preservation return reported 492 transform tests, 27 preservation / 17 provider
PG tests, locally prepared follow-up `20260911234500` SHA256
`beecb95c25e87f1b239f11f16e807338ec496df19ac27deffa5fb49b0bda5f59`,
unapplied at that checkpoint, with 2 pending columns. Root subsequently applied
and verified it as recorded in the current section above. Remaining-domain return reports 540
combined transform tests, 48 new tests / 14 PG tests, strict TS/lint clean.
These are worker-reported results pending final integration acceptance.

New uncommitted landing UI, AppDataProvider, app-view-model and Next generated
file changes appeared during the outage and are user/other work; preserve them.
Branch/HEAD remain `codex/v2-architecture` / `b51dcd1`. No v2 commit or push.

**Root read-only target gate, 12 September:** Supabase connector is available
again. Target `VaultShuffle2` / `vbjtbwelnhbbdfrqczyf` is healthy in us-east-1;
marker remains the expected `m1`, only original M1/M2/M3 migrations are
applied, accounts/games/runs are all zero, unforced RLS and browser table
privileges are zero. Previously pending service advisors have now run:
security has 58 INFO notices for private RLS tables without policies;
performance has 67 INFO uncovered-FK notices and 14 INFO unused indexes.
No WARNING/ERROR severity returned. Preserve deny-by-default private access;
do not add permissive policies to clear this advisory. Index/deletion cost
requires the planned real-load/workload measurements; do not add every index
or remove unused indexes from an empty rehearsal. Exact metadata-only evidence:
`database/v2/m3-target-advisors-20260912.json`. That read-only gate performed no
source query, auth mutation, DDL or data load; the later apply is recorded above.

## Current checkpoint — Codex dispatch, 11 September 2026

The user's latest instruction is to fill Codex with substantial autonomous
work before root usage runs out, using models matched to complexity. Root was
switched back to Astra Ultra for coordination. This dispatch supersedes older
Claude-first and fixed max-agent instructions. Both Claude batches finished;
no further Claude work was assigned. Their returned code is pending integrated
acceptance, not lost or being restarted.

**Three new Codex workers are running in the shared checkout:**

| Worker | Model / effort | Complete assigned batch |
|---|---|---|
| `/root/m3_preservation_integration` | GPT-5.6 Sol / High | Review and repair finished preservation/provider work; durable terminal/backoff evidence; new local follow-up migration; truthful manifest/index integration; actual PG constraints/privacy gate. |
| `/root/m3_remaining_domains` | GPT-5.6 Terra / Medium | Remaining recommendation/config/support/ops transforms, residual security-intent/merge audit disposition, exact accounting and actual PG output/privacy tests. |
| `/root/m3_local_loader` | GPT-5.6 Sol / High | Verified artifact -> staged transform -> local PG load/replay pipeline, complete accounting, per-account reconciliation, synthetic end-to-end/fault-injection and local runbook. |

Exact multi-phase assignments, exclusive file ownership, dependency interfaces,
autonomy and acceptance gates are in
[v2-m3-codex-dispatch-20260911.md](v2-m3-codex-dispatch-20260911.md).
All three were successfully spawned. They have substantial independent work
and communicate only for frozen interfaces or concrete blockers. Do not
restart old max workers, duplicate their implementation/review, or repeatedly
read intermediate files. Let completed batches return. No new remote operation
or target/source change was performed for this dispatch.

**Resume after usage interruption:** read this checkpoint and the dispatch,
then obtain one compact status for the three named agents. Review their
completed checkpoints, not a repeated full repository audit:

- `docs/v2-m3-codex-preservation-checkpoint.md`
- `docs/v2-m3-codex-remaining-checkpoint.md`
- `docs/v2-m3-codex-loader-checkpoint.md`

If running, leave them to execute. If interrupted, resume the same worker at
its recorded next phase, retaining its chosen model/effort. If completed,
review concrete failures/schema changes and integrate once. Root retains
remote-apply decisions and overall milestone signoff. No M3 completion claim
until actual consistent export, real rehearsal parity and measured storage.

**Latest Claude returns now transferred to worker A:** provider batch has
40 provider unit tests, 143 catalogue tests, reported 480 combined transform
tests, 14 actual PG tests, clean repo typecheck/v2 lint. Preservation correction
has 128 owned unit tests and 27 actual PG tests; the proposal was unapplied at
that checkpoint and later became the immutable fourth migration. It
adds legacy ownership/clock preservation and retired-family disposition.
Relevant completed evidence is in `docs/v2-m3-provider-checkpoint.md` and
`docs/v2-m3-preservation-followup-checkpoint.md`. A must verify the corrected
three integrity defects and provider terminal/backoff durability; expiring
queue archives alone do not satisfy plan sections 7/13/14.2.

Earlier same-day coordination entries are preserved in
[v2-execution-history-20260911-claude-returns.md](v2-execution-history-20260911-claude-returns.md).
Those model settings, ownership and pending return descriptions are historical.

## Accepted evidence and exact resume points

The chronological ledger is preserved in
[v2-execution-history-through-20260911.md](v2-execution-history-through-20260911.md).
Read its relevant section only when historical commands or decisions are needed;
its old ownership banners are superseded by this file. The archive is evidence,
not a new instruction to repeat prior work.

- **Git:** branch `codex/v2-architecture`, last observed HEAD
  `b51dcd163a923bba0315dac125fa7d945690d4e9`, user footer changes preserved.
  No v2 commit/push/reset. All uncommitted files remain in the shared checkout.
- **M1/M2:** complete, including real target apply, fresh rebuild, non-owner
  tenant/clock/concurrency tests, import fencing/idempotency, changed-only
  writes and measured 10,000-game import. See archived ledger and
  `database/v2/M1-checkpoint.md`, `database/v2/M2-checkpoint.md` where present.
  Do not repeat accepted gates without a changed dependency.
- **M3 physical schema:** applied after the user's explicit approval
  “Approve the M3 rehearsal migration”, target version `20260910232654`, local
  `database/v2/supabase/migrations/20260910232654_m3_preservation_schema.sql`.
  Exact SHA256
  `605b72a3d9df1328ec27033c3420c1813a238f6e15bd8fc28f971cddaf30a24a`.
  M1/M2/M3 SQL is immutable. Future physical changes require a new migration
  and root review. Target marker deliberately remains `m1`.
- **M3 applied schema gate accepted:** all six private schemas match at
  92 relations / 991 columns; zero unforced RLS or browser private privileges;
  runtime roles least privileged; SQL/security fixtures rollback cleanly,
  accounts/games/runs all zero. Exact metadata-only evidence:
  `database/v2/m3-target-validation-20260911.json`. Scoped collection/draw
  deletion, latest100/90-day UI history, account-predicate retention EXPLAIN,
  staging purge/recovery hold and privacy tests passed. Service advisors remain
  pending connector availability. No real user data loaded.
- **Replay fixture clock fix:** only `database/v2/tests/m3_replay.sql` changed
  after apply, to transaction-relative already-due staging and active/expired
  hold tests. SHA256
  `ccd365080f0d1fce9d5bf6edf7bd1b984563479fea7a7a40fae049a0e7ad7719`.
  Applied migration bytes were not changed.
- **Exporter/reader accepted locally:** 126 combined unit tests, exporter
  29 actual PG integration tests, reader two actual PG round trips including
  60,030 rows and exact scalars/controls. Export manifest v2 requires RLS
  evidence; `SET LOCAL row_security=off` and readback refuse filtered exports.
  TLS/SCRAM checks and private path/error handling are implemented. No real
  remote source export, source TLS/SCRAM or export-role privilege proof yet.
  Resume `docs/v2-export-checkpoint.md`, `docs/v2-m3-reader-checkpoint.md` and
  paired contracts; do not regress the accepted boundary.
- **Identity/scalars/session/capability accepted locally:** root combined
  40/40 tests, strict targeted TS/lint. Preserve long-lived manual login sessions
  (`manual.` cookie prefix); only security intents expire at final freeze.
  Proven deleted tombstones retain explicit provenance, create no invented
  visibility tuple and cannot own live sessions. Capability account tuple is
  authoritative under the reviewed rule; false/NULL does not mean hidden.
  Shared exact timestamps retain microseconds and civil dates, integer/decimal
  conversions are checked. See identity/session contracts and checkpoints.
- **Catalogue returned, correction gate pending:** 128 owned tests before the
  three reproduced root review findings. Actual synthetic PG output checks were
  recorded by the worker. Shared GameMap contract is in
  `docs/v2-claude-domain-transforms.md`; use it unchanged except the assigned
  boundary corrections. Loader must control deterministic identity override,
  sequence advancement and server JSONB size checks.
- **Library/family/history:** 121 unit tests with owned TS/lint, local PG output
  gate and physical edge cases being completed by Claude. Stale user-game state
  is audit/reconciliation only, never active authority; personal and lender
  facts remain separate. Read `docs/v2-m3-library-checkpoint.md` for current
  output evidence, not an old handoff's partial state.
- **Collections/commitments/draws:** implementations and collection/commitment
  tests exist; final draw tests and SQL constraint validation remain in progress.
  Read current `docs/v2-m3-commitment-checkpoint.md` and M3-G assignment.
- **Manifest/probes:** 120 Python tests (98 manifest, 22 probes), builders and
  normal coverage pass. 44 source relations / 486 columns; destination index
  92 applied / 0 proposed relations and 991 columns. Contract SHA
  `2d7a77eb38f69cf6985ebf1b803bd187cc3f1b5033f9468da7480f044da3a68e`,
  sidecar SHA
  `095797f57b21c3fc0bb063351bdb1a49f33f4ef49075f3b50fe1ba056e5607b1`,
  manifest SHA
  `98355df376c5793ca8b3e37ebaab08869c8cd9e3084bcdde2ad8f616f6f4f843`.
  Final-load intentionally fails on 1 unresolved source column and 5 relation
  decisions: actual hours precedence, cooldown bridge, purge/completion
  duplicate semantics, import freeze and source view definition. Dated audits
  are not snapshot parity and must not silently close these gates.

## Source access and local tools

Source access investigation is closed in `docs/v2-export-access.md` and
`docs/v2-export-access-followup.md`: legacy API credentials alone cannot prove
one repeatable-read PostgreSQL export. No usable database password/private
runtime credentials were found in the approved locations. Do not search
unrelated secret stores. Management HTTP pagination is not a consistent export.
The source CLI login-role endpoint provisions credentials and changes source
authentication: **not approved or called**. In particular, do not use source
`supabase db query --linked`, which initializes a login role. Suitable existing
private credentials or specific source-auth authorization will be needed after
local tooling is concrete and reviewed. No source data/auth writes permitted.

Supabase connector tools disappear with session/account context. Rediscover
available tools; do not assume a named method exists. Target-only authenticated
CLI query/apply testing has been approved and used; CLI itself reports target
login-role initialization. Do not repeat M3 apply. The target is
`vbjtbwelnhbbdfrqczyf`, VaultShuffle2, us-east-1, PG17.6.

Local PG17.6 binaries: `node_modules/.cache/vaultshuffle-pg17-20260910`,
read-only shared prefix. Each worker owns a dedicated synthetic data directory,
socket and port. Do not rebuild binaries, install globally or disturb sibling
clusters. Retained root final4 cluster: data
`node_modules/.cache/vaultshuffle-m3-final4-20260910/data`, socket
`/tmp/vaultshuffle-m3-final4-socket-20260910`, port55454, database
`vaultshuffle_m3_final4`, owner `vault_local_admin`. Export fixture cluster uses
`/tmp/vs-m3`, port55441. Old broken /tmp clusters are evidence only.

## Next gates and communication

Finish the current three assigned transform scopes and one completed
integration review; resolve concrete physical gaps without rewriting applied
SQL or fabricating source facts. Then implement remaining duration/provider,
quarantine/seed/import, recommendation/config and support/ops dispositions;
build staged loader and parity harness. M3 completion needs the consistent
real source export, deterministic mappings, complete disposition, actual
rehearsal, per-account parity/checksums and measured storage. M4–M7 follow their
plan gates; no production cutover before M0–M6 pass.

Claude's current task is “M3 migration readiness audit”, local session
`local_dfafb2d6-61c0-4b11-a384-523129119f32`. CUA verified Sonnet5/Medium and
message45 running; message47 queues the catalogue correction after its two
current batches. No native subagent restart. At a completed boundary prefer a
fresh concise handoff over carrying the old oversized conversation context.
If interrupted, first read this file, latest owned checkpoints, current Git
status and actual Claude/worker state. Transfer ownership explicitly before
switching workers. Keep model/effort dynamic; do not revive fixed max defaults.
Update the user at major milestones and at required blockers. Overall work is
not complete.
