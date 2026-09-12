# VaultShuffle v2 execution status

Updated: 11 September 2026 (London). Plan: [architecture and execution plan](VaultShuffle_v2_architecture_plan.md).

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
| M3 | In progress | M3 schema applied; target schema/security/rollback gate accepted. Exporter/reader and identity/session local gates accepted. Catalogue batch returned; library/history and commitments/draws completion transferred to one Claude Sonnet 5 / Medium thread. Remaining transforms, real export, loader and parity pending. |
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

## Current checkpoint — 10 September 2026

**LATEST policy and ownership — 11 September 10:31 UTC:** user replaces the
fixed max-agent strategy with dynamic model/effort selection. Prioritize Claude
while allowance is available; one Claude thread by default, two only for
distinct useful purposes, no native subagent fan-out. Simple work uses cheaper
low/medium effort; normal implementation uses capable medium; escalate only
for concrete complexity/risk. The old three max Luna / Opus Ultracode defaults
are superseded. Codex fallback workers follow the same cost-conscious policy.

Catalogue Luna returned **128 tests** (34 games / 68 catalogue / 26 values),
strict TS/lint, and applied-index finalization. Root completed-review acceptance
is still pending. The library and commitment Lunas subsequently hit allowance
limits; all Codex workers are stopped. Claude is available again, and the
existing task is set to **Sonnet 5 / Medium** for sequential completion of the
unfinished library/family/history and collections/commitments/draws batches.
No implementation overlaps. Exact current handoff and boundaries:
[efficient Claude continuation](v2-claude-efficient-resume-20260911.md).
Library checkpoint has 121 tests and a new local constraint harness on disk;
M3-G has implementations and some tests, but its checkpoint is stale and final
validation remains unfinished. Root retains catalogue integration review,
source prerequisites, ledger and milestone signoff. Never infer completion
from the historical ownership entries below.

Claude message45 is verified sent and running at Sonnet5/Medium. Root's
completed catalogue boundary review reproduced three local defects: mismatched
map/source provenance accepted, malformed external stub title accepted, and
stale cached IDs after a mutable map changes. Exact bounded follow-up is in
[catalogue review](v2-m3-catalogue-review.md). Root has stopped editing that
domain; the same Claude thread can take these corrections after the current
two batches. Catalogue acceptance remains pending those fixes, with no second
reviewer or model escalation needed. No new remote action occurred.

**LATEST ownership — 11 September 01:10UTC:** Claude exhausted again. UI
verified all **88 Finished**, auto-continue0, reset06:40London, and message43
with root's no-overlap transfer is visibly sent. Current Codex allowance is
available; resume the same three max Luna handles in their same scopes:
catalogue/game review + applied-index finalization, library/family/history
completion, M3-G collections/commitments/draws completion. This supersedes the
Claude-resumed entry below and earlier ownership banners. Do not start new
agents or resume Claude scopes without reconciling these owners.

Saved return state: catalogue applied-state metadata refresh now reports
**120 Python tests** (98 manifest/22 probes), all92destinations applied and0
proposed, exactimmutable SQL hash. New contractSHA
`2d7a77eb38f69cf6985ebf1b803bd187cc3f1b5033f9468da7480f044da3a68e`,
sidecarSHA`095797f57b21c3fc0bb063351bdb1a49f33f4ef49075f3b50fe1ba056e5607b1`,
manifestSHA`98355df376c5793ca8b3e37ebaab08869c8cd9e3084bcdde2ad8f616f6f4f843`.
Catalogue domain completion review still needs a final return. Library worker
checkpoint reports **121 tests**, strict targetedTS/lint; actual PG output
gate and unresolved physical/semantic cases still need return/review. M3-G
now has shared/collections/commitments/draws implementations; final owned
tests/PG constraint smoke and exact return remain pending. Check their current
domain checkpoints rather than replaying older work. Root remote schema/SQL/
RLS gate below remains accepted; advisors pending tool availability.

**Latest ownership — Claude resumed 11 September London:** all three Codex
Lunas are confirmed errored at their account limit. User says Claude is back;
UI confirms new message39 referencing
`docs/v2-claude-resume-20260911.md` sent and parent **Running**, Opus5 /
Ultracode. Three native Opus5/max batches now own: catalogue/game completion
review plus applied-migration metadata/index refresh; library/family/history
completion; M3-G collections/commitments/draw history. Exact scope and no
overlap instructions are in that handoff, superseding older ownership banners.
Do not resume Codex implementers until Claude stops and root transfers scope.
Root retains remote post-apply verification and milestone signoff. Initial
CUA paste timed out; typeText+Return succeeded but UI refreshed only after
clicking the active task. Do not duplicate sent messages based on stale AX.

**M2 is complete. M3 is the first unfinished milestone.** M1/M2/M3 schema migrations are now applied and immutable; M3's data-preservation gate remains incomplete. Resume current workers before assigning duplicate work. Root reviews completed batches and handles the real source snapshot prerequisite. Overall work is **not complete**.

**M3 DDL applied after explicit approval, 10 September 23:26:54UTC:** user
answered "Approve the M3 rehearsal migration". The exact final4 apply succeeded
only on VaultShuffle2 `vbjtbwelnhbbdfrqczyf`; remote history now contains
`20260910232654_m3_preservation_schema`. Local file was renamed to
`database/v2/supabase/migrations/20260910232654_m3_preservation_schema.sql`
without changing bytes, SHA
`605b72a3d9df1328ec27033c3420c1813a238f6e15bd8fc28f971cddaf30a24a`.
**Do not edit or reapply M1/M2/M3; future DDL requires a new migration.**
Post-apply marker remains deliberately `m1`; accounts/games remain zero.
The first post-apply table count omitted the `support` schema (89/956); include
all six private schemas for the expected 92/991 comparison. Schema/security/
rollback checks and generated applied-state index refresh remain pending.
Earlier rejected/pending entries below are historical, not current apply state.
No real export, private-row load, source write, deployment or provider
activation occurred. User now reports Claude back; reconcile current ownership
before transferring batches, and keep unfinished Luna implementations isolated.

**Remote M3 schema/SQL gate accepted, 11 September:** connector unavailable,
so root used the authenticated CLI only on the approved target. Metadata
matches the generated catalogue exactly: all six private schemas, **92 tables /
991 columns**, zero unforced-RLS tables, zero anon/authenticated table or column
privileges, both runtime roles NOLOGIN/NOSUPERUSER/NOBYPASSRLS/NOCREATEROLE.
The scoped draw FK matches. `m3.sql`, `m3_replay.sql`, `m3_cleanup.sql` pass
against target and leave zero accounts/games/runs. Target runtime security
checks pass as `vault_app` using temporary role membership inside the same
rolled-back transaction; final membership=false, no fixture rows survive.
Durable metadata-only evidence:
`database/v2/m3-target-validation-20260911.json`; temporary query/results are
`/tmp/vaultshuffle-m3-target-{postcheck,fixtures,security}.{sql,json}`.
The CLI reports target login-role initialization, as before; no production
CLI or authentication action was performed. Service advisors remain pending
until their connector returns. This completes the applied schema subgate,
not M3 real-data preservation/parity.

The first remote replay exposed a **test clock defect**: its hardcoded recovery
hold expired at2026-09-11T00:00Z. Root changed only `tests/m3_replay.sql` to a
transaction-relative already-due staging window, tests active-hold suppression,
then expires the hold and tests purge-due resumes. Focused local replay and
all remote SQL fixtures pass. Applied migration bytes are unchanged. Root owns
this fixture change; Claude's index/docs worker should record its updated hash
without overwriting it. Latest user footer commit is `b51dcd16...` per Claude's
verified parent check, superseding earlier HEAD while preserving the v2 branch;
no root or Claude v2commit/push occurred.

**Latest continuation — 11 September London / 10 September 23:25UTC:** user
confirms Claude still exhausted. All three Luna handles had allowance errors;
current Codex allowance is available and existing handles were resumed in their
same M3-F/M3-G scopes. Catalogue checkpoint now claims bounded implementation
complete with 66 catalogue tests / 26 value tests and actual disposable PG
constraint inserts; worker is finalizing its return for root review. Library
and commitment checkpoints were missing, so those owners must bank accurate
state first. No domain completion inferred from partial files.

Supabase connector returned. Target preflight again proves marker VaultShuffle2,
M1/M2 history only, zero accounts and games. Root attempted exact final4 M3
`apply_migration` with SHA
`605b72a3d9df1328ec27033c3420c1813a238f6e15bd8fc28f971cddaf30a24a`.
**Automatic approval review rejected the call before execution**, citing lack
of explicit approval for this exact persistent schema/RLS/retention/privilege
mutation. A concise approval question is pending in this conversation for the
reviewed M3 migration to `vbjtbwelnhbbdfrqczyf`; no production/source change or
live data copy is part of it. Do not retry or route around the rejection until
explicit approval arrives. All local work continues. M3 has not been applied.

Current worker checkpoints: [exporter](v2-export-checkpoint.md), [physical database](../database/v2/M3-checkpoint.md), [manifest/probes](v2-m3-probes-checkpoint.md). Their accepted assignment is [M3-B](v2-m3-b-database-batch.md), with [capability precedence](v2-m3-capability-decision.md). Claude's older [M3-A checkpoint](v2-m3-a-checkpoint.md) is historical baseline, not current ownership. If interrupted again, check these files, current clock and live worker status first; never infer current usage from a cached Claude UI.

**Latest continuation review:** the three persistent max Luna handles remain
available. Database and session/capability workers are completing their batches.
Identity returned 17 passing tests; root reviewed the completed code and
reproduced invalid run identities being accepted through regex coercion
(`undefined`, NULL, numeric run ID). The same worker is fixing explicit runtime
type checks, correcting absent-root tombstone map provenance to the existing
`unknown` enum, and strengthening independent scalar boundary tests. Identity
is not accepted until this follow-up returns. No duplicate work was assigned.
Supabase connector tools are exposed again: target metadata verifies healthy
VaultShuffle2 / us-east-1 / PG17.6, marker `m1`, and exactly M1/M2 migration
history. No M3 apply or source query was performed on this continuation.

**Latest ownership — 19:34UTC, supersedes earlier entries:** user confirms
Claude exhausted again. Claude's M3-F partial catalogue/game and library/family/
history files plus shared game-map contract exist; no finished domain checkpoint
or accepted integration yet. M3-F and its shared contract now explicitly
transfer ownership to the existing max Lunas: identity/manifest worker takes
catalogue/game; exporter/session worker finishes the known tombstone adapter
fix then takes library/family/history. Database worker finishes the independent
read-only session/capability review. Their prior allowance errors are historical:
root rechecked current allowance as available and resumed the same handles.
CUA's read-only Claude check was rejected by automatic approval review citing
the previous usage limit. No UI stop/queued handoff is claimed; the user's
stopped-usage report and durable ownership banners govern. Never overlap Claude
and Luna implementation if Claude later returns.

After the user's approval-setting change, CUA read succeeds: Claude reports
**73 Finished**, 100% five-hour allowance, reset 11 September 01:00 London,
and auto-continue **0**. Its new M3-F assignments and two working agents were
visible in completed history, confirming earlier handoff delivery. The stop/
ownership notice attempted now has no verified sent state (clipboard timeout
and app-change interruption); durable banners and auto-continue off prevent
automatic overlap. Recheck before any later Claude reset transfer.

Session adapter follow-up is saved: 17 focused tests / strict TS / lint pass.
`unknown` map provenance accepts only a deleted, unverified manual tombstone
with explicit identity proof; a session with that deleted owner still fails.
Database reviewer is checking the stable session/capability code. Exporter Luna
has advanced to M3-F library/family/history, identity Luna to catalogue/game.

**Independent M3-E review follow-up:** database reviewer found capabilities
still require a nonexistent source row for a proven deleted tombstone, and
both transforms dereference null/undefined account maps before stable error
validation. Findings saved in `docs/v2-m3-session-review.md`. Root agrees and
transferred only `sessions*`/`capabilities*`, tests and their contract/checkpoint
to the database reviewer for the final fix. Exporter continues its large
library/family/history batch without overlapping those files. Deleted tombstone
capability absence must stay absence, no invented tuple; supplied observations
for a deleted tombstone must fail explicitly. Acceptance still pending that
integration test gate.

**M3-E local gate accepted:** both independent findings are resolved. Explicit
deleted tombstone proof passes through the adapter, capabilities omit its
absent observations and reject any supplied row targeting it; sessions still
reject deleted owners. Input/map guards now return stable errors before any
dereference. Reviewer returned 20/20 focused tests, strict targeted TS/lint;
root reviewed the fixes and reran the combined identity/scalar/session/
capability suite, **40/40 passed**
(`/tmp/vaultshuffle-m3-root-identity-session-gate.log`). Full repository TS has
one concurrent unfinished `library.test.ts:481` error assigned to its owner;
this is not a full integrated build claim. Database reviewer is now idle and
owns no new implementation. Both M3-F domain workers continue autonomously.

**Next disjoint batch assigned:** the same database/review Luna now owns
[M3-G collections, commitments and draw history](v2-m3-g-commitment-transform-batch.md)
under new `collections*`, `commitments*`, `draws*` transforms and their domain
contract/checkpoint. It coordinates the existing game/library map and exact
PG array/JSON APIs with the two M3-F owners. This supersedes its idle status;
no further SQL or session edits assigned. All three implementation workers
remain `gpt-5.6-luna` / `max`; Claude remains exhausted and auto-continue off.

Identity local gate accepted after root's review/reproduction fixes and rerun:
20 tests passed (`/tmp/vaultshuffle-m3-root-identity.log`). Final4 manifest
coverage gate accepted: 119 Python tests passed
(`/tmp/vaultshuffle-m3-root-manifest-final4.log`), 44 source relations/486
columns; sidecar SHA `ea92cb5e2f2e62f79d187f90ab6dcc32d1e001d4dc8caa67bc7bcdbe08af82c8`.
Final-load correctly refuses the remaining 1 column / 5 relation decisions.
Manual session disposition now preserves workspace login continuity.

**Remote M3 apply did NOT occur.** Root verified target marker/M1-M2 history,
zero accounts and games, loaded exact final4 SQL into tool memory for apply,
then the Supabase connector disappeared before any apply call. The target
remains M1/M2 as last verified. Reverify marker/history before the eventual
single exact-hash apply; do not assume an attempted read is an applied migration.

**19:01UTC resume / current ownership:** the 25-minute event wait timed out and
`list_agents` then showed only root. Existing canonical handles still accepted
follow-ups and are resumed; do not spawn replacements merely because a list
omits them. Database returned final3 SQL `7a82d2eb...` / contract `688482b9...`,
2,133 lines, clean replay and scoped draw/collection deletion fixtures. Root
review accepted the native FK correction but sent a focused cleanup-query
follow-up: the twice-referenced ranked CTE may materialize all tenants despite
an outer account filter, and the new retention indexes look redundant with
backward scans of existing indexes. Database owns the measured fix and new
final hashes; manifest refresh waits for that final delta.

Root found a cross-domain manual-session regression in the structured manifest
and new session transform. `manual_profile_sessions` are returning manual
workspace logins (`lib/auth.ts:153-196,330-347,414,434`), required to survive by
plan 14.2/14.3; only `manual_profile_security_intents` expire/restart at freeze.
Both active owners have the binding correction to preserve manual digest,
kind, owner, exact times and maps in unified `app.sessions`, with compatibility
tests and no elevation of verification. No source purge/expiry is authorized.

The next substantial batch is prepared at
[M3-F catalogue/library transforms](v2-m3-f-domain-transform-batch.md).
Claude UI reports its limit reset and all 64 old agents finished, auto-continue
off. **The new handoff has NOT been delivered:** CUA paste timed out twice,
setValue/typeText did not populate the composer, and one coordinate attempt
reported noWindowsAvailable. Reconnecting by bundle ID showed the old task
unchanged. Do not assume M3-F is running or overlap it; verify a sent message
and parent/native task activity before transferring ownership. Current work
remains with the three Codex max Lunas above. Supabase target remains M1/M2 only.

**Subsequent evidence supersedes the failed-delivery assumption:** Claude wrote
`docs/v2-claude-domain-transforms.md` with the assigned common game-map contract,
then new `transform/library-shared.ts` appeared. This confirms the M3-F batch
was picked up despite CUA continuing to display stale pre-reset content. Keep
M3-F catalogue/library paths reserved to Claude; do not duplicate them. The
three Codex workers only finish their existing review corrections. Native task
UI status is not currently reliable, so review saved completed checkpoints.

Database final4 returned with the same 92/991 layout, SQL
`605b72a3d9df1328ec27033c3420c1813a238f6e15bd8fc28f971cddaf30a24a`, contract
`46e9b982395cb2800da1247d22afc43de0e1cc3e99df1fc632a7b032142a3577`.
Root reviewed its actual EXPLAIN: 40-account/10,000-draw fixture, the bound query
ranks only the selected account's 250 rows, index conditions hold on each
branch, output LIMIT 20. NOT MATERIALIZED allows filter pushdown; ranking still
processes that account's rows. Three redundant indexes were removed. Fresh
M1/M2/M3 replay and four SQL fixtures passed; final sidecar refresh remains with
manifest owner. M1/M2 file hashes are unchanged.

**Physical local gate accepted:** root independently ran `m3.sql`,
`m3_replay.sql`, and `m3_cleanup.sql` against final4 as the non-superuser owner,
all passed (`/tmp/vaultshuffle-m3-root-final4-sql.log`). Current local fixture:
`vaultshuffle_m3_final4`, socket `/tmp/vaultshuffle-m3-final4-socket-20260910`,
port 55454, PGDATA `node_modules/.cache/vaultshuffle-m3-final4-20260910/data`.
Fresh replay/security/EXPLAIN evidence remains in the same parent cache directory.
Remote apply waits for final manifest refresh/review; real export/parity remain
later gates. The now-idle database Luna has one independent read-only M3-E
session/capability review, writing `docs/v2-m3-session-review.md`; no SQL changes
or overlapping implementation are assigned.

Session/capability worker returned the corrected batch: 16 focused tests,
targeted strict TypeScript and full repository typecheck pass; full lint has
0 errors / 24 existing warnings. Both manual and verified full-cookie HMAC
digests are retained without rehashing or elevation; obsolete manual
`expire-at-cutover` is rejected. Local acceptance waits for the independent
review. Exporter worker is idle with no new scope.

The shared checkout had independently moved to `main` and gained the user's
footer commit `79010ab31e751141057f8f255af3d6affdd35da7`. Root verified the old
v2 branch was its ancestor, advanced only that v2 ref using the expected old
hash, then switched back to `codex/v2-architecture` at the same current tree.
The new user commit and all dirty files are preserved. Current v2 HEAD is
`79010ab31e751141057f8f255af3d6affdd35da7`; no v2 commit or push was made.

**14:33UTC continuation:** all three Luna workers had hit an allowance error;
root's current usage tool reports available allowance, so existing handles were
resumed. Reader returned 39 unit tests and one actual 60,030-row exporter→reader
roundtrip, but root review found three blockers and sent it back: leading U+FEFF
is silently stripped by default TextDecoder; legal raw PostgreSQL control bytes
are rejected; `privateFile` opens a FIFO without NONBLOCK before its stat. Two
decoder defects were reproduced locally with synthetic strings; reader is not
accepted until fixes and actual roundtrip tests pass. Its checkpoint is
[reader](v2-m3-reader-checkpoint.md), contract [reader API](v2-reader-contract.md).
Exporter-owned fixture restarted on `/tmp/vs-m3:55441` (same ignored data
directory), superseding `/tmp/vs-m3x`. Database actual SQL is now 2,082 lines;
no final current-file replay accepted. Manifest full-suite caught and is fixing
its own stale-state retention mismatch: the complete stale audit is bounded
30-day staging, only sparse sole evidence belongs in durable
`app.game_state_legacy_measurements`. No full-table lifetime exception approved.

**Manifest local return:** 118 tests passed (96 manifest / 22 probe-safety),
builders/coverage passed on SQL hash
`9dcb9f25e2e7afaf72cd59cfcf0d15c23c168d17724d87a33b5815ee0abc2cdf`,
contract `54753c2b5b3983cba613d17328e639537dce6a4dad1083934039af2f5338a9b8`,
index `c152a5e21603de3965f59c7bd074f25d0666cc21c2116eb21627a884169dad06`.
Index has 92 relations / 991 columns; source coverage 44 / 486. Root reviewed
the corrected structured capability semantics and bounded full stale-state
disposition. Accepted for continued local integration, not final-load or parity;
compare index to actual replay catalog and refresh against any final DB delta.
One hours column and five relations remain formally gated. The same max Luna
manifest worker now owns [M3-D exact scalars/account identity](v2-m3-d-identity-batch.md)
under new `lib/v2/migration/transform/scalars*` and `accounts*`, plus
`docs/v2-m3-identity-checkpoint.md`, disjoint from the reader/database workers.

**Reader gate accepted / next transforms:** fixes preserve leading U+FEFF and
legal raw PG17 controls, reject NUL, and open private artifacts with NONBLOCK
so FIFO input cannot hang before stat. Worker returned 45 reader tests and two
actual PG17 roundtrips; root reran the combined exporter/shared/reader unit set,
**126/126 passed** (`/tmp/vaultshuffle-m3-coordinator-js.log`). Export worker now
owns [M3-E sessions/capabilities](v2-m3-e-session-capability-batch.md) under new
`transform/sessions*` and `capabilities*`, coordinating scalar/account interfaces
with the identity worker. Reader checkpoints remain durable; no real export.

**Physical return and root review:** worker returned current SQL `9dcb...` with
clean replay and four M3 SQL fixtures passing as a target-like non-superuser
owner, contract hash `389449a4c0bcb350856acb155acc38a5504d89bcb53c69477c45e1e95ee258e3`.
Root independently compared the live local catalog to the generated index:
exactly **92 relations / 991 columns**, no missing/extra/column-order differences.
Root then reproduced a draw deletion failure in a rollback-only fixture:
compound `vault_state.current_draw_ref` FK `ON DELETE SET NULL` nulls the required
account key. Database worker is fixing it with PG17 column-specific SET NULL,
also replacing the unnecessary collection-detach trigger with the native
column-specific action, and aligning draw UI-history retention to plan13's
latest100/90days instead of lifetime. Final replay/hash remain pending after
these fixes; no M3 remote apply authorized yet. Local database is
`vaultshuffle_m3_owner3`, socket `/tmp/vaultshuffle-m3-owner-socket-20260910:5432`,
actual data directory `node_modules/.cache/vaultshuffle-m3-owner-cluster-20260910/data`
(logs are in its parent). Do not confuse the parent log directory with PGDATA.

**Latest ownership, 10 September 13:44–13:46UTC:** Claude exhausted again. All 64 native tasks finished; task auto-continue is off; root's no-overlap handoff is verified queued. Existing max Luna database and manifest workers resume their same paths from the actual afternoon deltas; the migration is now **1,983 lines**, `m3_cleanup.sql` exists, and the database checkpoint is still stale. Root explicitly instructed both to bank accurate checkpoints first. Exporter worker advances to [M3-C verified artifact reader](v2-m3-c-reader-batch.md), owning new `lib/v2/migration/read/**`, reader contract/checkpoint and necessary exporter/shared compatibility. No overlapping Claude implementation is authorized.

**Local exporter gate accepted:** final RLS fix passed **81 unit tests / 29 actual clean PostgreSQL integration tests**, typecheck and targeted lint; Claude parent independently reran unit/integration and inspected the guard, and root reviewed its final control flow. Transaction-local `row_security=off` is set/read back before relation reads and rechecked at close; manifests now require version 2 row-security evidence. Actual restrictive/default-deny/FORCE RLS fixtures fail without finalizing a partial dataset; a full-visibility control succeeds. Mutation experiment demonstrated the original bug would seal 40 of 100 rows with a matching checksum. See [export checkpoint](v2-export-checkpoint.md). Fixture `/tmp/vs-m3x`, port 55441 remains running for exporter/reader roundtrip only, data `node_modules/.cache/vaultshuffle-m3-export-data-20260910b`. Remote TLS/SCRAM/pooler/source privileges remain unmeasured; no real export accepted. Physical retention/deletion/replay and manifest semantic/destination gates remain unaccepted. Approved separate nullable `app.accounts.last_login_at` is in plan 14.2.

- User expects execution through all milestones and a durable handoff; `continue` resumes the first unfinished gate. Overall work is **not complete**.
- **Latest user delegation preference: Claude app/native agents are primary while Claude usage is available; parent Opus 5 / Ultracode, native implementers Opus 5 / max. At 13:44UTC allowance is exhausted (next reported reset 18:20UTC / 19:20 London); all three existing max Luna workers own the batches above. Claude task auto-continue remains off and a stop/ownership message is queued. Reconcile actual worker state before any return to Claude. Codex retains coordination, integration review and milestone signoff.**
- User requests updates at major milestones, not routine waiting/progress messages. Patiently wait for batch completion; communicate milestone completion, actionable blockers and necessary decisions.
- **10 September explicit waiting preference:** user added `[features.multi_agent_v2]` with min/default/max `1500000` ms and asked that it be used. The block is physically in `database/v2/supabase/config.toml`, not `~/.codex/config.toml`. Apply `timeout_ms: 1500000` directly to `collaboration.wait_agent`; the tool supports that duration and wakes for worker updates or user input. Prefer these event waits to routine one-minute polling. Preserve the user-added config block; do not relocate or remove it without need.
- **User usage-efficiency rule (7 September): operate in large, well-specified batches. Let the assigned max Luna agents implement, debug and validate autonomously. Coordinator re-engages for cross-domain decisions, unresolved blockers, final integration review and milestone gates; do not continuously supervise or repeatedly read evolving implementation.**
- On 9 September the import Luna stopped at the account usage limit. Its durable integration implementation was already saved; coordinator reviewed and ran it successfully on a fresh isolated database. Database/application agents had returned their completed M2 batches. Do not repeat completed M2 work on the next reset.
- All Luna agents must run `gpt-5.6-luna` with `reasoning_effort=max`. Persistent paths: `/root/database_security_max`, `/root/import_integrity_max`, `/root/application_access_max`. After the latest usage restart, `list_agents` showed only root, but the existing canonical paths still accepted `followup_task`; resume them before attempting replacements. Never resume retired agents at high.
- User permits additional Luna agents when they have a legitimate independent batch. This supersedes the original three-agent preference; respect actual concurrency capacity and keep all Lunas at max. Reuse the existing three when usage returns and their next domain batch is ready.
- Ownership: database agent owns `database/v2/**`; import agent owns `lib/v2/import/**` and `docs/v2-import-contract.md`; application agent owns `docs/v2-application-contract.md` until application dependencies freeze. Coordinator owns cross-domain decisions, review, remote apply, integration and this ledger.

### M1 complete — immutable applied foundation

- Applied only to target `vbjtbwelnhbbdfrqczyf`, reverified healthy VaultShuffle2 / us-east-1 / PostgreSQL 17.6. Migration: `database/v2/supabase/migrations/20260906093036_m1_private_foundation.sql`; exact SHA256 `54fe0a7defd029e91568b78d51393670ac7ca6edcf915919670c7f64c2476389`. The management tool assigned the timestamp and local history was aligned without changing content. **Do not reapply or edit this migration.** Future changes require new migrations.
- Target marker reverified after latest continue: `VaultShuffle2`, `vbjtbwelnhbbdfrqczyf`, schema `m1`. All 26 domain tables have forced RLS; runtime/worker roles are NOLOGIN, NOSUPERUSER, NOBYPASSRLS and NOCREATEROLE.
- Coordinator independently replayed the exact final migration into fresh local `vaultshuffle_m1_final` as non-superuser `postgres`. `database/v2/tests/m1.sql` passed locally and through target management SQL (`m1 SQL assertions passed`). Target cleanup verified zero accounts/library/catalogue rows, null tenant context, and rolled-back temporary SET-role grants.
- `database/v2/tests/m1_session_clock.sql` passes via psql separate statements, proving expiry advances within one reused transaction. It is separate because a management API request has one query-start `statement_timestamp`. `database/v2/tests/m1_family_concurrency.py` passes READ COMMITTED, REPEATABLE READ and SERIALIZABLE; the stale writer cannot create a sixth member.
- Local logs: `/tmp/vaultshuffle-m1-final-rebuild.log`, `/tmp/vaultshuffle-m1-final-fixtures.log`, `/tmp/vaultshuffle-m1-final-concurrency.log`, `/tmp/vaultshuffle-m1-session-clock.log`. Older `vaultshuffle_m1` and `vaultshuffle_m1_rebuild` databases/logs are development artifacts; use `vaultshuffle_m1_final`.
- Post-apply advisors: no warnings/errors. Four security INFO notices are intentional deny-all RLS on ops tables. Performance INFO notices cover intentionally absent reverse game-FK indexes, an alias-target FK to assess during real-data deletion rehearsal, and unused indexes on an empty database. [RLS notice](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy); [FK index notice](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys).
- Review findings fixed before sign-off: global PUBLIC default function EXECUTE revoke (schema-only revoke was ineffective); existing role attribute validation instead of superuser-only ALTER; fail-closed integer tenant parsing; statement-clock session expiry; account/session/verified-profile consistency; sparse sleep/restore fields, wishlist pin scope, observation times and bigint daily totals; compound tenant/session FKs; family parent row versioning to reject stale stronger-isolation writers. Exact contract is `database/v2/M1-contract.md`.

### M2 complete — immutable safe import

- Applied only to VaultShuffle2 `vbjtbwelnhbbdfrqczyf`; remote history reverified with M1 and M2. M2 file: `database/v2/supabase/migrations/20260907163356_m2_jobs_quota_publish.sql`, SHA256 `f09d7ca900f3cdaaee81eff0f507adc5869865f16eb7f340eeb1729223bc5aba`, 144,293 bytes. Management assigned the version; the CLI-generated local draft was renamed without changing content. **Do not edit or reapply M1/M2; use a new migration for future DDL.** The marker deliberately remains schema `m1` as the foundation marker; migration history records advancement.
- Coordinator independently replayed exact M1+M2 as non-superuser `postgres` in fresh `vaultshuffle_m2_coordinator_gate`. Base and adversarial fixtures passed using rollback-only role setup, then the two-connection quota/observation tests passed. Logs: `/tmp/vaultshuffle-m2-coordinator-gate-{rebuild,fixtures,concurrency,10k}.log`. The fixture wrapper is `/tmp/vaultshuffle-m2-coordinator-fixture-wrapper.sql`; it grants test ADMIN/SET only inside rollback transactions and preserves the function owner/default-ACL assertions. Concurrency and benchmark scripts now use explicit local admin login plus transaction-local runtime role and never modify cluster memberships.
- Actual 10k normalizer fixture: provider 839,394 bytes; canonical 1,737,832 bytes; hash `5cac4a392b56f5b94ea48313280b0eedb39a40c5bf5a5277c612fde87780f68c`. Initial publish **652.05 ms**, 10,000 library changes/9,999 sparse activity changes/10,000 outbox inserts; a new identical job **467.70 ms**, all change counters zero. Both atomic ACKs passed and both measured RPC wall times are below the five-second gate. Earlier `completed_at - charged_at` values were metadata intervals, not commit latency, and are not benchmark evidence.
- On 9 September coordinator ran the durable `lib/v2/import/steam-owned-sql-integration.integration.ts` against another fresh exact replay, `vaultshuffle_m2_import_gate`. Effective role is `vault_worker` for every RPC, with explicit isolated admin connection and transaction-local SET ROLE; no persistent membership grants. **Passed**, initial publish RPC **644.804 ms**. It proves real claim → fixture transport → normalize/orchestrate → SQL publish; commit-then-response-loss with nonzero exact stored summary and one fetch; a new identical job with unchanged library/activity `xmin` fingerprints; known and unknown minute retirement/reacquisition; private/invalid/stale outcomes and deferred retry/ACK. Logs: `/tmp/vaultshuffle-m2-import-gate-{rebuild,integration}.log`. This disposable DB retains 10k shared catalogue/outbox fixture rows; account/job/library/queue cleanup is verified zero and both providers disabled. Use a fresh database for a repeat; do not mistake retained synthetic shared data for an export or production data.
- Target `database/v2/tests/m2.sql` (28,110 bytes) and `m2_adversarial.sql` (43,902 bytes) each executed as exact one-query rollback-only fixtures through management SQL on 9 September and succeeded. Final query verified zero accounts/games/library/jobs/charges/quota/outbox/queue messages, null tenant context, all **35/35** private tables FORCE RLS, and runtime roles NOLOGIN/NOSUPERUSER/NOBYPASSRLS/NOCREATEROLE. Original postgres memberships remain ADMIN=true, INHERIT=false, SET=false after rollback. Steam and Steam Store providers remain disabled.
- Target advisors: **no WARN/ERROR**. Eleven security INFO notices are intentional deny-all ops RLS with private wrapper access. Twenty FK-index INFO findings include intentional absent reverse game indexes and composite FKs already covered by useful leading keys; assess real deletion/cleanup plans during M3/M6 before adding indexes. Nine unused-index INFO findings are expected on the empty target. [RLS explanation](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy), [FK index explanation](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys), [unused indexes](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index).
- Final contract: `database/v2/M2-contract.md`; implementation/test details: `database/v2/M2-checkpoint.md`; review closure: `docs/v2-m2-review-checklist.md`. The independent application review closed exact generation and active profile/lifecycle fencing on the prior hash; final f09 capability/positive-epoch deltas passed added local and target regressions. Q1–S4 are closed for M2; no actual provider network call or scheduled worker activation is claimed.
- Accepted implementation: bounded strict full-response normalizer/fetch, explicit fixture/live single-attempt orchestrator, lossless bigint SQL adapter, exact canonical SHA256, complete-only retirement, greatest-known minutes/provenance, sparse pinned observation fencing, retained authored/family/history facts, changed-only writes and semantic revisions. Zero/negative known last-played epochs are rejected; provider zero normalizes null. Empty/all-null complete capability is unknown for playtime/last-played; private library is hidden with other visibility unknown; transient/invalid errors preserve prior visibility.
- Operational contract: PGMQ 1.5.1 default install, interactive/background ID-only messages, wrapper-only access. Keyed Steam UTC daily global 80k/background 50k; token buckets 120 at 2/sec global and extra 60 at 1/sec background. Atomic nonrefundable charge at each claim, account/generation/profile/lease fencing, retained coalesced UUID aliases, expired-lease reclaim, bounded retry/deferred ACK. Lease default120s (15–300), max5 attempts, successful summaries14 days, terminal detail30 days. Independent disabled Steam Store outbox does not consume keyed Web API quota. Scheduling, all-consumer budget integration, long-run cleanup and live provider adapters remain M6; runtime credentials remain M4.

### M3 active — Claude coordination and next gate

- **Resumed 9 September at 15:52 UTC:** user continued Claude while Codex usage was exhausted, then explicitly asked Codex to check progress and keep Claude as primary worker while its usage is available. Current Claude app task is **M3 migration readiness audit**, session `local_dfafb2d6-61c0-4b11-a384-523129119f32` (`claude.ai/epitaxy/local_dfafb2d6-61c0-4b11-a384-523129119f32`). This replaces the earlier session `local_2339b7c1-fd74-4a3b-9070-767e1cff3325` for coordination. Parent remains **Opus 5 / Ultracode**. UI reported 0% of five-hour allowance and 11% weekly used, then verified the resumed task running. Do not resume unrelated enrichment tasks.
- Claude completed the readiness report plus mechanical constraint sweep and started M3-A from `docs/v2-m3-a-batch.md`. Four assigned subagents (exporter, schema/manifest, browser access, report verification) stopped at Claude's session limit. Saved implementation at resume: `lib/v2/migration/shared/{secret,redaction,private-fs}.ts`. These are partial and unvalidated; no M3 DDL, physical contract, complete manifest or real export is claimed.
- User-created `.claude/agents/opus-implementer.md` and `opus-analyst.md` are untracked project work to preserve. Both pin `claude-opus-5`, effort `max`; the analyst is read-only. Claude confirms definitions became available after its session restart. Codex has not edited them. Current Git HEAD remains `2e82939`; checkout remains dirty (README, eslint config, package scripts and untracked v2/agent work); no commit was made because the batch is unfinished and mixed pre-existing user changes must remain separate.
- Sent and verified a resume message directing Claude to reuse useful subagent context, finish/debug/validate the existing bounded M3-A batch without repeating completed audits, and save exact task/subagent/test/next-step state in **`docs/v2-m3-a-checkpoint.md`** (new Claude-owned output). Read that checkpoint first on next continuation. The batch file defines all other owned paths. Codex retains the main ledger and physical-contract/exporter integration gate; no M3 DDL or real source export before that review. Let agents run in batches; use concise UI status checks rather than re-reading evolving code.
- Report corrections requiring final integration: `algorithm_weights` is manually tuned scoring configuration, not learned warm-start evidence; app abuse counters are separate from M2 provider budgets; distinguish source schema possibilities from actual data violations. Target operator/owner postgres was directly verified NOSUPERUSER, BYPASSRLS=true, CREATEROLE=true, LOGIN=true, so absence of a dedicated loader role does not itself block administrative rehearsal loading. These corrections are already in M3-A's assignment.
- Coordinator captured one read-only source schema inventory on 9 September: `database/v2/source-schema-inventory-20260909.json`, 44 public relations / 486 columns with types/nullability/constraints and non-system schema names. No source row values were queried. This evidence was sent to the running Claude audit. It is metadata only, not a data snapshot or complete non-public-schema disposition.
- Source-consistent read-only direct/session credentials remain unresolved. Existing legacy service-role HTTP access and management metadata queries do not establish a private consistent bulk export. Never run the CLI path that provisions login roles on production. Source schema/column coverage must be 100% against a real snapshot, including non-public schema disposition where applicable; a repository-only audit cannot prove that gate.
- The earlier private-connection-file question is superseded by the user asking us to investigate existing direct Supabase/browser access first. Claude's bounded browser-access work is assigned under M3-A. Do not re-ask for credentials before its findings are reviewed. Never print a credential or provision a production role as a shortcut. Earlier checks found only legacy API URL/key locally and no DB process variables, `.pgpass` or `.pg_service.conf`; this does not establish that no usable access path exists.
- Next: review Claude's readiness report; obtain/provision suitable source read-only direct/session connection privately through the authorized secret workflow (no secret printed); build/export a UTC repeatable-read snapshot with private permissions/checksums; implement complete source disposition/mapping/transform/validator and any necessary new migration, then execute real-data rehearsal and per-account parity/storage report. Preserve every intended private record and resolve all exceptions. M3 stays incomplete until these actual-data gates pass.
- M3 client prerequisite: the temporary PostgreSQL build used for local synthetic tests has `USE_OPENSSL` undefined (`/tmp/vaultshuffle-pg17/include/pg_config.h:730`). It must not be used as an insecure remote export workaround. Use/build a TLS-capable client with certificate verification for direct/session source export; local Unix-socket tests remain valid.
- **Run 2 progress, 9 September afternoon UTC:** Claude reports browser/access and report-verification agents complete; exporter and schema/manifest agents continue autonomously at Opus 5 / max. Browser output is `docs/v2-export-access.md`; corrected audit is `docs/v2-claude-m3-readiness.md`. Dashboard inspection found no downloadable backup on the current plan and identified direct/session endpoints. No password was retrieved. Codex reviewed the completed access report and sent `docs/v2-m3-a-coordinator-feedback.md` with precision corrections and an optional bounded current-CLI investigation for a freed analyst. This is not M3-A signoff; the physical contract, exporter validation and complete manifest are still pending.
- **Access investigation delta:** read-only source role metadata found an existing expired `cli_login_postgres` (LOGIN=true, SUPERUSER=false, BYPASSRLS=false, valid until `2026-09-03 15:19:13.270498+00`). It has not been refreshed or changed. Current installed CLI help is Bun-based and describes `db query --linked` as Management API access, unlike the earlier CLI observation below; neither that help nor its `stream-json` output flag proves a snapshot-consistent bulk export. Any role provisioning/refresh remains prohibited on the source under the development read-only boundary. Official [CLI role documentation](https://supabase.com/docs/guides/troubleshooting/permission-denied-when-deleting-the-cli_login_postgres-role-808bae) confirms that some passwordless CLI paths mutate managed login roles. Investigate first; do not infer that resetting the production password is the only possible access path.
- **Resumed again at 21:33 UTC:** Claude had automatically resumed after the 20:50 UTC allowance reset. Run 3 completed `database/v2/M3-contract.md` and the 44-relation / 486-column disposition manifest with 177 unresolved columns. Claude's batch lead independently reports 58 validator/probe-safety tests and 30 exporter shared-layer tests passing, plus typecheck. Export integration remained active, not yet accepted. Initial Codex UI state was stale and incorrectly suggested allowance still exhausted; refreshed state showed 87% used and exporter running. No Luna was spawned. Always re-check the current clock, files and live task after a user `continue` before acting on cached UI usage.
- **M3-A database review → next batch:** coordinator reviewed the completed proposal and recorded binding decisions plus corrections in `docs/v2-m3-b-database-batch.md`. Preserve the plan-required draw/warm-start/config/support/catalogue evidence, specify exact durable destinations, correct archive retention, distinguish authored hours from mere divergence, retain unknown-game completion history, strengthen manifest gates, and compile/test safer probes. One NEW M3 migration and isolated local validation are authorized by that batch; remote apply and real load are not. The exporter keeps separate ownership. The original M3-A no-DDL boundary is superseded only by this bounded M3-B database assignment; M1/M2 remain immutable.
- **Claude exhausted refreshed allowance at approximately 21:41 UTC:** all three native agents (export integration, M3-B physical schema, M3-B manifest/probes) returned HTTP 429 session-limit failures. Next reset is 10 September 01:50 UTC / 02:50 London. Root left an ownership handoff telling Claude not to auto-resume implementation before reading this ledger and checking current ownership. The user's instruction to prefer Claude until its usage is used up is satisfied; max Luna workers now continue the saved work: `/root/m3_export_recovery_max` owns `lib/v2/migration/**` and export contract/checkpoint; `/root/m3_database_max` owns exact M3 contract, one NEW migration, M3 SQL tests and database checkpoint; `/root/m3_manifest_probes_max` owns `database/v2/migration/**` plus `docs/v2-m3-probes-checkpoint.md`. All three explicitly run **gpt-5.6-luna / max**. No duplicate active Claude implementation is authorized. Reconcile ownership before returning work to Claude on its next reset.
- **Measured source audit, 21:39–21:40 UTC:** `database/v2/source-nonpublic-audit-20260909.json` records zero Auth users/Storage buckets/Storage objects/queued HTTP requests, 45 non-public relation metadata entries, and confirms the proposed queue `created` column does not exist. `source-playtime-audit-20260909.json` plus exact wrapped `.sql` records all nine reviewed P05/P06 aggregate probes in one RR/read-only transaction, 30s statement/2s lock timeout, UTC. All 365,610 owned library rows carry exact minutes and none disagrees with the decimal hours formula; all 1,563 family rows have unknown minutes and zero hours. All 62 pin baselines and all non-null completion hours convert to whole minutes. Stale staging has 24,428 rows and measured completion/recency discrepancies. No private row values were returned. These are separate live aggregate observations, **not** a consistent migration export or cutover snapshot; recheck on the real snapshot.
- **Bounded export-access follow-up closed:** `docs/v2-export-access-followup.md` records installed CLI version still 2.115.0 (Bun wrapper plus Go binary, not proven version drift) and a documented API candidate for a temporary read-only login with TTL. That endpoint mutates managed authentication state and has not been called; no source role/password change is approved or performed. Existing connector audit access still does not supply a continuous PG export connection. Avoid repeating the browser/CLI audit or asserting a password reset is the only route. Finish/review exporter TLS/auth first, then resolve the exact private credential/authentication prerequisite.
- **Conflict aggregates at 21:50 UTC:** exact SQL/result saved in `database/v2/source-conflicts-audit-20260909.{sql,json}`, RR/read-only with 30s statement/2s lock timeout. 684 accounts include 223 manual and two missing manual profiles; no both-kind or missing Steam profiles. Of 461 compared Steam accounts, 183 disagree between account/profile visibility triples and 271 have differing checked times: precedence requires writer/read-path evidence. One collection has duplicate positions. Zero over-cap families (max four), orphan lender links, unresolved completion identities, bad completion ordering, invalid Steam session hex/expiry or cross-table decoded digest collisions. All five current merge rows retain source accounts; no current tombstones required. These observations close hypothetical conflicts only for this audit, not for a future snapshot. Target recheck still has two applied migrations and zero accounts/games; no M3 target apply occurred.
- **Capability precedence resolved with semantic correction:** `docs/v2-m3-capability-decision.md` and plan 14.3 clarification establish account-side tuple precedence from `lib/games.ts` writer and `lib/session-payload.ts` reader. `source-visibility-audit-20260909.{sql,json}` at 21:52UTC found 183 account-only dated observations, 88 account-newer, zero profile-newer/profile-only/equal-time value conflicts. Critically, legacy false flags mean no positive hours/no reported last-played value, not explicit provider privacy. Preserve raw tuple/provenance; true can project visible, false/NULL project unknown unless independent privacy evidence exists. Both database and manifest agents have this binding correction; real export rechecks exceptions.
- **Latest resume, 23:43 UTC / 10 September 00:43 London:** all three max Luna agents had stopped at a prior account limit; resumed through their existing `followup_task` handles, retaining ownership above. Export checkpoint now reports 30 shared and 19 synthetic SQL integration tests, typecheck and targeted lint passing; TLS/SCRAM, mid-COPY errors, real-inventory plan and CLI entry point remain unfinished review surfaces. `docs/v2-export-contract.md` records Claude's completed baseline and its limits. Probe checkpoint is still implementation pending. CLI-created M3 migration `20260909214501_m3_preservation_schema.sql` exists but is **empty**, not implemented/applied. No M3 completion or schema-apply claim. Claude's no-overlap ownership message is verified **queued** for its 01:50UTC reset, all 34 native background tasks finished; don't resume its stale implementation automatically.
- **Exporter return/review, 10 September 00:22UTC:** worker returned 58 exporter/shared unit tests, typecheck and targeted lint passing, with synthetic TLS/SCRAM vector/CA/hostname/plaintext/timeout checks and an opt-in CLI. The prior 19 real PostgreSQL integration tests predate the new mid-COPY case; the shared temporary fixture had become unavailable. Root authorized a NEW isolated local cluster and sent the worker back to finish the final runtime gate. Root's completed-code review also requires explicit ordered authentication state (no premature ReadyForQuery success or async proof race), removal of all freeform PostgreSQL error text from diagnostics/private run failure reports, and whole-inventory schema drift checks inside the snapshot. Exporter is **not yet accepted**. Database/probe workers retain their current batches.
- **Tool availability on latest resume:** Supabase connector tools are no longer exposed in the current tool list. Local CLI remains authenticated; target-only marker query succeeded and printed `Initialising login role`, verifying VaultShuffle2 / `vbjtbwelnhbbdfrqczyf` / foundation marker `m1`. This target authentication setup is within rehearsal authority. Never use that CLI path on production under the read-only boundary. `~/.codex/config.toml` currently lists bundled/primary plugins and no Supabase entry; do not infer that earlier connector access persists.

### Validation baseline and integration

- Latest coordinator integration on 9 September: **515/515 tests**, including 56 v2 import tests; typecheck and targeted `npx eslint lib/v2/import` passed. Logs: `/tmp/vaultshuffle-v2-m2-final-{tests,typecheck,lint}.log`. Durable real SQL integration is separate and passed as recorded above.
- `package.json` adds `test:v2` and includes `lib/v2/import/*.test.ts` in `npm test`. An earlier integrated run passed **488/488**, before the final Retry-After/orchestrator work; log `/tmp/vaultshuffle-v2-fetch-integrated-tests.log`. That evidence is superseded by the 515-test integration above.
- Before v2 implementation: typecheck passed; lint passed with 0 errors/24 existing warnings; 459 tests passed; build passed. Logs `/tmp/vaultshuffle-v2-baseline-{typecheck,lint,tests,build}.log`. Last integrated log `/tmp/vaultshuffle-v2-integrated-tests.log` and 17-test normalizer log `/tmp/vaultshuffle-v2-normalizer-final.log`.
- Own whitespace checks passed. Full-tree `git diff --check` flags pre-existing README line 113 trailing whitespace; preserve it. Current dirty tracked files are README, eslint config and package scripts plus untracked v2 domain/docs. Do not restore historically dirty files just because their status changed.

### Local tools and later prerequisites

- **10 September 03:33UTC restored test toolchain:** original `/tmp` prefix/source/data had lost essential files (`initdb`, `postgres.bki`, catalog files); preserve prior logs but do not treat damaged or polluted offline clones as fresh-replay evidence. Root rebuilt official PostgreSQL 17.6 in ignored `node_modules/.cache/vaultshuffle-pg17-20260910`, with source and logs in `node_modules/.cache/vaultshuffle-pg17-build-20260910`. Official `.tar.gz` checksum verified `2910b85283674da2dae6ac13fe5ebbaaf3c482446396cba32e6728d3cc736d86` (different archive format from the older recorded source checksum). Configure flags remain `--without-readline --without-icu --without-zlib`; Unix-only local test use, no remote TLS claim. PGMQ 1.5.1 rebuilt from checksum-verified saved archive and installed under this prefix only. No package/global install. Each worker has instructions to use its own clean `initdb` data/log directory in the ignored cache, short private socket under `/tmp`, unique port, and target-like non-superuser roles. New prefix is shared read-only; workers must not stop or repair sibling clusters.

- Official PostgreSQL 17.6 source `/tmp/postgresql-17.6`, tar SHA256 `e0630a3600aea27511715563259ec2111cd5f4353a4b040e0be827f94cd7a8b0` matched official checksum. Built under `/tmp/vaultshuffle-pg17` with `./configure --prefix=/tmp/vaultshuffle-pg17 --without-readline --without-icu --without-zlib`, `make -j6`, `make install`. Nothing installed globally. Clients include psql/pg_dump/createdb/pg_ctl.
- Server data `/tmp/vaultshuffle-pg17-data`, private mode-700 Unix socket `/tmp/vaultshuffle-pg17-socket`, port 55432, TCP disabled. Bootstrap admin `vault_local_admin`; local `postgres` mirrors target NOSUPERUSER CREATEROLE CREATEDB BYPASSRLS; browser/service roles scaffolded. Evidence databases: `vaultshuffle_m1_final`, `vaultshuffle_m2_coordinator_gate`, `vaultshuffle_m2_import_gate` (the latter retains synthetic shared fixture rows). Socket operations require sandbox escalation. Server log `/tmp/vaultshuffle-pg17-server.log`; stop only when validation is idle using `pg_ctl -D /tmp/vaultshuffle-pg17-data stop`.
- Local PGMQ 1.5.1 files installed only under the temporary PG prefix. [Official source](https://github.com/pgmq/pgmq/tree/v1.5.1/pgmq-extension), archive `/tmp/vaultshuffle-pgmq-1.5.1.tar.gz`, SHA256 `a435fec34a8d3b3e6ace928e24889b5549a83369b1e479ab6747ac076246085c`, extracted `/tmp/pgmq-1.5.1`. Build/install from `pgmq-extension` using `make PG_CONFIG=/tmp/vaultshuffle-pg17/bin/pg_config` then `make install` with same PG_CONFIG. Non-superuser create-extension/create/send/read probe passed in rollback. Target has pgmq 1.5.1 installed by M2; pgcrypto 1.3 is already installed. Core PG17 sha256(bytea)/gen_random_uuid can avoid an unnecessary local pgcrypto dependency. Do not pin extension VERSION in migrations; Supabase changelog says ignored/deprecated.
- Supabase CLI `/opt/homebrew/bin/supabase`, version 2.115.0. Target-only `db query --linked --project-ref vbjtbwelnhbbdfrqczyf --output json` SELECT works, but prints `Initialising login role`; do not use this potentially role-provisioning path on read-only production. No production CLI query attempted. Prefer management tools for reviewed target apply/source audit.
- M3 needs a consistent private source snapshot using a read-only repeatable-read direct/session export or equivalent single snapshot stream. HTTP page copies are not parity proof. Suitable direct credentials/session secret/Steam key were absent locally; resolve privately when needed, never print secrets or private rows. Keep authorized pure/database work moving meanwhile.
