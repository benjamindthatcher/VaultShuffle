# VaultShuffle v2 execution status

Updated: 14 September 2026 (London). Plan: [architecture and execution plan](VaultShuffle_v2_architecture_plan.md).

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
| M3 | In progress | Synthetic all-domain loader accepted; real export and full offline transform completed for 1,048,426 rows. Grouped preservation/precision corrections underway before real rehearsal load, parity and storage measurement. |
| M4 | In progress | Connection/session and initial bootstrap/Library/detail reads accepted locally, including >1,000-game PG17 access/pagination fixture. Versioned page contracts, Dashboard and Collections reads underway. Runtime remains on legacy. |
| M5–M7 | Pending | Product parity, load/recovery verification and eventual production cutover. |
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

## Current priority — real source export and rehearsal preflight

**14 September resume:** both active workers hit an account usage limit during
their previous batches and have now been resumed in place after the user's
`continue`. Keep their existing edits and assignments; neither batch has passed
its final acceptance gate yet. All five remotely applied migration files were
rechecked against their recorded SHA256 values and remain unchanged.

**13 September completed milestones:** permanent Blacklist implementation and
its guest/runtime/SQL acceptance are complete. The reviewed V2 migration
`20260912193000_blacklist_semantics.sql` is applied and immutable at SHA256
`a20e75cbca19918d4a5d8cb2778a98f50bf98641b7594c4c067abe58a8c9cca6`.
Target rollback behavior and schema/access checks passed; no real account,
game or migration-run data was loaded. Evidence:
`database/v2/blacklist-target-validation-20260913.json`.

The legacy compatibility migration remains prepared and unapplied. It must
ship with the matching runtime release because legacy runtime writes `Slept`
and the new runtime writes `Blacklisted`. No more Blacklist feature work is
needed, and no production deployment or table/data write occurred.

**Local loader accepted:** all 44 source relations now have nonempty synthetic
fixtures. Root ran the targeted PG17 suite (13/13) and all-domain PG17 suite
(1/1), sequentially against the final five-migration schema. The sequence
repair uses transactional ALTER SEQUENCE RESTART and its late-failure rollback
regression passes. Actual integration exposed and repaired two adapter defects:
merged review decisions now preserve the SQL default for omitted source payload;
completion registry links now reference explicit resolved/unknown history IDs.
Terra/Medium `loader_closeout` independently ran the final TypeScript, focused
ESLint and 23 loader units successfully and updated the three loader docs.
This closes synthetic loader acceptance; it does not close real-data parity.

At the accepted five-migration baseline, the physical destination index had
92 relations / 988 columns, with manifest coverage and 122 Python checks passing.
Subsequent M4 session and M3 precision migrations are prepared locally and
remain unapplied remotely. Keep those local schema revisions distinct from the
applied target. V13 still records final-freeze observations requiring fresh evidence.

**Browser-first preference (latest user instruction):** use the signed-in Brave
Supabase dashboard for access, settings and metadata. Source Settings tab
`966861393` in browser `2` is authenticated; the separate in-app browser sign-in
page is not the user's session. Use another transport only for work the browser
cannot complete, such as the single-transaction streaming export. Do not start
new credential searches. The two workers resumed after a temporary usage-limit
interruption on 13 September; await their completed results.

**Active workers (maximum two):**

- `real_source_export` — Sol/High, completed/accepted; inactive. Its artifacts
  and validation are in `docs/v2-export-connection-ready.md`.
- `loader_closeout` — Terra/Medium, completed. Captured live view semantics
  are reviewed in `docs/v2-m3-live-view-review.md`; D-VIEW-1/S-VIEW-DEFS
  observation is accepted. Manifest decision update is pending integration.
- `m4_session_foundation` — Terra/High, completed/accepted locally. Connection
  and session repository evidence is in `docs/v2-m4-session-checkpoint.md`;
  one additive migration is prepared and remains unapplied remotely.
- `real_snapshot_preflight` — Sol/Medium, active. Owns the grouped real-preflight
  corrections, related transform/manifest files and
  `docs/v2-m3-real-preflight-checkpoint.md`.
- `m4_read_validation` — Sol/High, completed/accepted locally. PG17 repository
  suite passed 13/13, including the 1,205-game read fixture (8/8). Now idle.
- `m4_page_contracts` — Sol/Medium, active. Owns the remaining bounded page
  contracts, Dashboard/Collections read repositories and actual-PG validation.
  No session-file ownership, SQL migration edits or runtime switch.

Root owns coordination, source-policy decisions, integration review and this
ledger. Do not repeatedly inspect intermediate worker output or duplicate
implementation. Let each assigned batch finish. Older workers that hit usage
limits are inactive; their stale status is not a current tool blocker.

**Approved real export:** the user supplied the private Management API token
and explicitly approved temporary `read_only:true` source logins, read-only
export of account/session/game data into
`/private/tmp/vaultshuffle-m3-export-20260913/output`, and refreshing the
five-minute login when needed. No repeat permission question is required.
No source table/schema/data writes or production password reset are authorized.
The authentication-only temporary login exception is separate from those bans.

**Real source export COMPLETE, 13 September 13:04 UTC.** Worker used the
signed-in browser first, then the approved streaming transport because the
Table Editor cannot supply one repeatable-read transaction across all tables.
The exporter activated an already-granted read-only role after checking existing
membership, full SELECT visibility, no write/create privileges, non-superuser
status and BYPASSRLS. No new grants or source data/schema changes were required.
Canonical constraint rendering is fixed; same-transaction view definitions
are captured in a separate private sidecar. Strict reader verification passed.

- Run: `/private/tmp/vaultshuffle-m3-export-20260913/output/20260913T130404Z-130c2ad9`
- Manifest SHA256: `b3f9def89106b7e5c4772ee5b3b0449ac16e504da2f8e677e7ee1194837fc3cb`
- Adjacent sidecar: `20260913T130404Z-130c2ad9.schema-views.json`
- Sidecar SHA256: `59597f47278c8d7ca4722dd46cd991d80fc80f64ecca83354ba1c37391cfa641`
- 44 relations / 486 columns; 1,048,426 rows; 668,415,359 COPY bytes.
  42 nonempty relations, two empty; two live view definitions.
- Transaction UTC: `2026-09-13T13:04:04.638967Z`; snapshot
  `202821:202821:` unchanged at close. Repeatable read, read only,
  `row_security=off` verified. Direct TLS certificate/hostname validation passed.
- Private directories 0700; all files and sidecar 0600. Failed `.partial` runs
  remain evidence only. V2 target remains without real imported data.

Export worker closeout passed TypeScript, focused ESLint, 55 export/helper
units, actual PG17 constraint/view-sidecar integration and diff hygiene. Root
reviewed final role activation, schema rendering and sidecar publication changes
and accepted the real export. The worker subsequently hit a usage limit; no
source-export work remains to retry. Do not repeat the export or refresh source
credentials merely to inspect these local artifacts.

The real preflight passed strict reader verification but hit the staging size
ceiling on the 495,374,271-byte `user_games_with_catalog` view. Root approved
a narrow fix: preserve 256 MiB default, allow an explicit 1 GiB maximum for this
run, and avoid materializing unused rebuild-only view rows after verifying them.
The worker is resumed for this fix and actual preflight. Terra/Medium
`loader_closeout` completed the independent captured live-view review in
`docs/v2-m3-live-view-review.md`. Root accepted D-VIEW-1 observation: both
view bodies are known and their derived facts come from preserved base tables.
The new M4 worker uses applied schema contracts and separate directories, so
its local session foundation can proceed while M3 real-data preflight runs.

**Completed real preflight 11:**
`/private/tmp/vaultshuffle-m3-export-20260913/preflight-11/real-preflight-report.json`
is protected 0600, staging removed, zero target writes. Reader verifies
44 relations / 486 columns / 1,048,426 rows and every file hash. All-domain
transform now completes; no target-contract additions. Tags, sighting times,
dismissal units and duration status adapters passed real data. Focused 210
checks, TypeScript, lint, manifest check and diff hygiene passed.

Publication is still blocked: recommendation decimal precision (13,232),
unverified settings (3), family recency exceptions (3), and 22,317 conflict
occurrences dominated by preserved stale-state codes, old proposal flags,
historical counters and purge review/event overlap. Import/cooldown holds are
also recorded. The grouped root rulings and full rationale are in
`docs/v2-m3-rehearsal-evidence.md`; do not re-decide each row or equate a
reported historical disagreement with lost data.

**Active correction batch:** `real_snapshot_preflight` now owns the grouped
resolutions, a narrowly widened recommendation total-hours column in a NEW
additive migration (local validation only), actual settings provenance and
unattributed family-recency preservation. It must preserve strict final-load
checks and propose an explicit isolated-rehearsal distinction for operational
cutover holds. No real target load is assigned yet. Rerun preflight after the
coherent correction batch; do not repeat the completed source export.

**14 September M4 read acceptance:** `m4_read_validation` completed the actual
PG17 fixture and necessary SQL fixes. Root reviewed the final code and fixture:
family lenders deduplicate, personal ownership wins, totals stay stable past the
last page, filters run in SQL, details retain private fields, and bootstrap pins
are bounded to the library scope. The runtime login has only `vault_app`
membership, with actual no-context and cross-tenant RLS checks. Focused tests
passed 13/13 (read fixture 8/8), typecheck and lint passed, private fixture
directories were cleaned. Evidence: `docs/v2-m4-read-checkpoint.md`.

This accepts the implemented read slice, not all M4 contracts. Root found the
planned version/filter/revision cursor binding and typed input/restart errors
still absent. `m4_page_contracts` (Sol/Medium) owns those required gaps plus
Dashboard and paginated custom/smart Collections reads against existing schema.
It must validate independent expected filter sets, >1,000 collection memberships,
whole-library aggregates and tenant isolation in real PG17. Earlier M4 workers
are idle. No legacy route/UI/runtime switch is assigned.

The offline worker must preserve actual blockers and expose only value-free
aggregate findings. Source-dependent P05, purge/completion overlap, view
semantics, in-flight imports, and cooldown observations are measured from this
snapshot. Final-cutover freeze and runtime policy gates remain distinct from a
read-only rehearsal. No synthetic evidence or invented decision may clear them.

**Resume locations:** export helper/profile and all private output are under
`/private/tmp/vaultshuffle-m3-export-20260913` (0700, credentials 0600).
Never print credentials or private source rows. Export worker owns login
refreshes and records final paths in its checkpoint. Synthetic loader cluster
`/tmp/vs-m3-loader-c-cK5F5M/data` was stopped successfully by root after its
accepted tests to free host shared memory for M4 fixtures. Do not assume its
old socket/port55507 remains live. Its files are retained; no realdata was stored
there. New M4 fixtures own their separate private directories.

On 14 September root also gracefully stopped the obsolete synthetic
`vaultshuffle-m3-final2-20260910`, `final3` and `final4` clusters (ports
55452–55454) after they exhausted host shared-memory capacity and blocked the
new M4 fixture. All three `pg_ctl -m smart stop` calls succeeded. Their data
files remain intact; historical instructions referring to those live sockets
must no longer assume they are running. Current workers/export were untouched.

**M4 foundation accepted locally:** root reviewed completed client/session
changes and the narrow renewal migration. Focused actual non-owner PG17 suite
passed 3/3, including HMAC/prefix, absence versus database failure, expiry/
revocation/kind/active-account checks, manual renewal/hourly no-op, verified
fixed expiry, raw-session access denial and pooled transaction cleanup. Final
TypeScript, lint and diff checks passed. Optional injected CA PEM retains
mandatory certificate/hostname verification. Renewal is awaited and its actual
expiry is returned for later cookie integration; no raw table grant was added.

New V2 migration `20260913191021_m4_manual_session_touch.sql`, SHA256
`7b993f3e0f7978ea48975cee7c9787de17097f4dcb422a2d2bd07258cd8677bd`,
was generated with the Supabase CLI and tested locally. It is UNAPPLIED to the
remote target, adds only the reviewed function/ACLs, and shares the resolver's
owner under an explicit guard. Runtime remains legacy; M4 page/API integration
and production composition remain pending. `m4_session_foundation` is finished.

**Git baseline:** user commit `54c9042` (blacklist update), following `0b2c934`
(database update), branch `codex/v2-architecture`. Preserve both and unrelated
changes. No commit/push. The user's latest priority is bounded practical
completion: fix concrete correctness/security/data-loss defects, then advance.

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

Current assignments are the two real-export/preflight batches above. Blacklist
and synthetic loader acceptance are complete. Use the current loader checkpoint
and the active workers' export/preflight checkpoints to resume; older dispatch
packets describe completed implementation work.

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

## Historical source access and local tools (superseded by current priority above)

The credential/approval absence described in this historical section is no
longer current. The user supplied a token and explicitly approved temporary
read-only login refresh and protected local export; see the current priority
section and export worker checkpoint.


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

## Historical next gates and communication

The old Claude/three-worker assignments below are historical. The two active
Codex worker batches at the top of this ledger supersede them.


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
