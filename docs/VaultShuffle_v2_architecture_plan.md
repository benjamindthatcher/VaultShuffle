# VaultShuffle V2: revised delivery plan

Updated 30 September 2026. This revision replaces the September 5 product assumptions and September 14 execution priorities. It retains the existing V2 relational foundation; it does not propose another redesign. See [execution status](v2-execution-status.md) for what is actually implemented and verified.

The earlier plan, detailed invariants, migration manifest and implementation remain recoverable from `codex/v2-architecture` at `df481f035446aff0fe856918862c41151a46fcb5`. That branch is an implementation source, not the current product baseline. Current `main` plus the user's uncommitted work define the features to preserve. Do not merge the old branch wholesale over newer application code.

## 1. Scope and decisions

Finish the database migration, preserve current behaviour, and remove obsolete machinery. Production remains `pfvblcopcmairdfeqdep`; the separate rehearsal target is `vbjtbwelnhbbdfrqczyf`. No production authority switch has occurred.

| Area | Updated decision |
|---|---|
| Duration provider | **HLTB only.** No IGDB integration, fallback, popularity source, alias dependency, worker, credentials or future provider milestone. |
| Blacklist | Permanent inactive pool, manual reactivation only. No expiry, blacklisted-at field, Sleep history or new state/event system. |
| Sign-in | Preserve current verified Steam sign-in and public-profile URL resumption across devices. These remain distinct identity assurances. |
| Account promotion/merge | Retired in current application work. Do not rebuild the removed secure-profile flow or make it an M5 requirement. |
| Wishlist | Existing product scope: separate saved games, Steam wishlist import, suggestions, details and regional store cache. `/play-next` redirects to `/wishlist`. |
| Vault | Preserve current goals, global filters, selection and learning semantics, including September 23 changes. |
| UI | Preserve current product work, VaultShuffle Purple, approved landing-page exception, stationary controls and mobile refinements. No visual redesign. |
| Execution | One agent, bounded implementation batches, focused verification and durable checkpoints. No parallel workers unless the user changes this instruction. |
| Future features | Achievement hunts, embeddings, collaborative models and a broader shopping system remain deferred; they do not block database completion. |

## 2. Foundation to keep

Reuse the private `app`, `catalog`, `reco`, `ops` and `migration` domains and independent migration root under `database/v2/supabase`, now selectively integrated into the current checkout alongside `lib/v2`. Do not rebuild the legacy migration chain as a blank-database baseline.

Keep internal account/game keys and stable public UUIDs, a compact active library, sparse authored state, separate personal activity and retained personal facts, explicit Family Sharing access, shared catalogue metadata, owner-scoped collections, and bounded operational jobs. SteamID64 stays a decimal string at JavaScript/JSON boundaries. Steam AppIDs must not be narrowed to signed 32-bit values.

Keep the existing server data-access approach: parameterized SQL, TLS verification, a small bounded connection pool, transaction-local tenant context, and non-owner application/worker roles. Ordinary requests must not use the database owner or bypass RLS. Session resolution establishes the account; request bodies cannot select the principal. RLS and compound foreign keys enforce both row ownership and parent ownership. Test missing context, two tenants, failed transactions and pooled connection reuse.

Keep existing session cookies, token prefix, hashing compatibility, account UUIDs and expiry behaviour. Database unavailability is a retriable service failure, not logout or conversion to guest. Preserve the distinction between a publicly accessible Steam profile workspace and verified Steam identity; URL resumption must not confer verified privileges.

Use current installed Next.js guidance before changing runtime code. Server Components and routes share the same server-only data-access layer. Keep client DTOs small and exclude credentials, raw session hashes and private migration evidence.

## 3. Data contracts and targeted updates

| Domain | Keep / adapt |
|---|---|
| Accounts and sessions | Reuse foundation and reviewed session-touch correction; adapt to current URL resumption. Preserve necessary historical identity mappings without reviving promotion APIs. |
| Library and activity | `user_games` is the legacy authority. Never revive undone completion from stale `user_game_state`. Preserve exact personal minutes, unknown values, observed intervals and retained facts after access loss. |
| Family access | Personal ownership wins. Multiple lenders may supply access. Lender playtime/achievements never become borrower facts. Preserve existing roster and candidate semantics. |
| Authored state | Completion, notes, manual progress, dismissals and baselines survive loss of access. Keep existing completion/undo history. Permanent Blacklist remains a simple state. |
| Pins, snoozes, current pick | Preserve current scopes, slots, baselines and eligibility. Vault snoozes are separate from Library Blacklist; do not remove them by confusing the two. |
| Collections | Preserve public IDs, ordering, notes and unavailable members. Counts and smart filters operate over the full eligible set, not the current page. Quick wins exclusions have been reconciled with current product rules; keep whole-set pagination/count checks. |
| Wishlist | Add owner-scoped saved games keyed by account and Steam AppID, including upcoming/unavailable games absent from the catalogue. No dependency on Library ownership, pins or Blacklist state. |
| Store cache | Preserve country-scoped metadata and prices, numeric minor units/currency, normal/sale TTLs, refresh leases and failure backoff. Failed refresh must not manufacture a current price. Reuse current cache design rather than introducing a general marketplace. |
| Catalogue | Keep Steam metadata, artwork, player-mode classifications, weighted tags, quarantine and human review decisions. Preserve the current SteamSpy/Store tag precedence. |
| Duration | Retain validated HLTB estimates, reviewed HLTB identities and human overrides. Unknown stays unknown; do not retain IGDB-only values as a hidden fallback. |
| Recommendations | Preserve useful current preferences and measured counters with sufficient numeric precision. Map current explicit actions accurately; automatic selection or a reroll is not automatically a negative preference. |
| Operational state | Keep quota/cooldown constraints, fenced import generations, leases and retry bounds. Do not restart production's in-flight jobs in rehearsal. Rebuild disposable queues safely. |

Wishlist-specific acceptance follows [the current Wishlist contract](wishlist.md): atomic additive import, duplicates do not replace saved entries, failure does not erase the list, guests remain local without automatic account sync, unavailable AppIDs remain saved, and saved/owned/family games are excluded from discovery as specified there. Do not reuse the old Library `Wishlist` tombstones as this new saved-game table.

### HLTB-only transition

1. Retire active IGDB tools and remove the HLTB input builder's dependency on an IGDB report. Keep Steam catalogue ingestion, HLTB validation, checkpoint/resume, reviewed V2 SQL generation and read-only duration inspection. Retain the existing private link/note review and undo; do not keep a processing queue that has no worker.
2. In the V2 catalogue transform and manifest, explicitly discard obsolete IGDB estimates, provider IDs, provider-only aliases, retry state and provider-only payloads. Do not route them into a generic preservation archive merely to keep old row counts equal. Record aggregate disposition counts, without inventing per-game history.
3. Add an additive migration for the existing target's provider constraints/resolver and any obsolete provider-specific fields. Rebuild derived duration projections from validated HLTB and independent human overrides. Preserve overrides as authored decisions, never relabel an IGDB estimate as HLTB. If no acceptable value remains, show unknown and make it eligible for HLTB review.
4. Verify finite/endless/unknown classification, confidence and identity rules, rejection handling, manual override precedence, queue completion and dependent Library/Wishlist filters. An old SQL resolver must not silently select IGDB after an HLTB writeback.
5. Apply the reviewed transition only to the appropriate environment/release. Existing source values and SQL have not been changed by local tooling cleanup. Historical applied migrations remain immutable.

**Local preparation completed 29 September:** additive HLTB-only target correction, typed projection/disposal and actual PG17 cleanup/privilege/full-load checks pass. Provider-neutral authored aliases and human reviews are retained. The legacy duration queue has no provider attribution and is intentionally discarded; explicitly attributed HLTB state survives. Remote application/source release remains pending. See the [execution checkpoint](v2-execution-status.md).

No hosted duration worker is needed: the current duration pipeline is local and reviewed. Steam metadata scheduling remains separate.

### Permanent Blacklist integration

The V2 branch already contains the accepted additive Blacklist migration and runtime work. Reuse it selectively. Current product types, provider writes and UI now use permanent `Blacklisted` with no Sleep timestamp. The legacy source boundary temporarily translates the immutable source RPC/storage spelling `Slept`, omitting its retired timestamp on reads. Current Library desktop/mobile checks pass; keep that boundary only until the actual switch.

Port only the necessary database/runtime/test changes: active → Blacklisted → inactive indefinitely → manual reactivation → active. Remove timestamps, expiry jobs and restoration fields used solely by timed Sleep. Preserve any existing normal-behaviour dependency only if actually required; do not add blacklist history or new restore metadata. Do not mix this work with completion-history or Vault snooze changes. Verify guest and signed-in paths, filters, reload and manual reactivation once, then move on.

### Legacy cleanup rules

Remove dead application entry points and redundant scripts when callers are gone. Do not delete current authored facts, historical completion events, the only remaining personal playtime, or identity mappings still needed by existing references. The retired promotion subsystem needs no new jobs, event log or user interface. Any retained historical mapping must have an actual consumer or migration purpose.

Do not rewrite applied SQL or delete migration evidence to make the repository look cleaner. Add changes to the current V2 chain. Disposable queues/cache can be rebuilt; durable facts need a documented mapping or explicit disposal decision. Historical reports remain evidence only, not runtime requirements.

## 4. Reads, writes and imports

Reuse the implemented session/bootstrap/Library/detail repositories and improve them in place. The recovered Dashboard/Collections fixture now passes; integrate its code selectively against current application contracts. The app stays on the current runtime until each migrated path is ready.

- Bootstrap: session-safe account summary, counts, revisions, current pick and bounded pins; no full Library payload.
- Library/Collections: bounded pages and stable cursors tied to tenant, query and relevant revisions; consistent whole-set counts; over-1,000-member coverage.
- Dashboard: whole-library aggregates and bounded highlights/history, with unknown and price-coverage semantics preserved. Current page now consumes the V2 aggregate contract; standing filters run before totals, up to 17 display cards are hydrated, and completion history uses 60-row pages. Current Library and Dashboard have local fixture/browser acceptance; remaining Collections/product/remote gates still apply.
- Detail/Wishlist: load expanded data on demand; country-aware shared cache remains independent of personal saved state.
- Mutations: validate the established account, enforce ownership, use atomic transactions and existing idempotency/revision boundaries; stale writes do not silently win.
- Import: only a complete, validated, current-generation snapshot may remove access. Partial/private/error results cannot erase a library. Replayed or superseded jobs cannot publish. Keep changed-only updates and preserved personal facts on removal/reacquisition.
- Workers: bounded claims, leases, provider budgets, backoff and durable rejection decisions. Rehearsal cannot drain production jobs or call live providers accidentally.

Ireland versus Virginia is not a timestamp conversion rule. Earlier inspection found UTC and timezone-aware stored timestamps on both projects. Recheck during fresh inventory, preserve instants and numeric epochs, and explicitly validate date-only and JSON timestamps. Never add a geographic offset.

## 5. Rehearsal and preservation

The September 13 export and its temporary preflight files are gone after the restart. The historical 44-relation inventory and 1,048,426-row export remain historical evidence. A protected consistent September 29 snapshot now covers 46 relations / 502 columns / 1,091,337 rows and passes full local reconciliation, restore and real-account repository reads. Source migrations now include Wishlist, store cache, URL resumption and Vault learning changes. The current schema definitions, grants, policies, functions, views, triggers and pg_cron metadata are recorded. Current source dispositions now cover all 46 domains; reuse the validated snapshot for rehearsal, then take a new snapshot at final freeze.

Use the signed-in browser for Supabase inspection and access. Use another transport only when the browser cannot perform the operation, such as a consistent streaming export. Do not hunt for passwords or reuse expired temporary credentials. Export to a protected local directory with a manifest, exact counts/hashes and consistent UTC snapshot. Never put account/session data or credentials in Git or reports.

Extend the existing disposition manifest and transforms; do not start a second migration framework. Include new durable Wishlist data, current learning/configuration, and an explicit rebuild disposition for cache. Separate approved discarded IGDB/Sleep machinery from unexplained data loss.

Precision and real-preflight-evidence corrections are applied to the isolated target together with Wishlist, session renewal, HLTB-only and current catalogue additions. The original eleven preservation migrations and subsequent runtime migrations are applied; the target now has 25 immutable entries. The original candidate8 fingerprints were verified remotely, and the current-chain local restore retains all 63 exactly. The current snapshot preserves nine unknown-subject family observations and three rollback-only settings; it does not activate obsolete settings in runtime. Preserve genuinely unresolved personal evidence privately and with owner access controls when needed, without assigning unknown activity to a borrower. Fix contradictory tests before accepting this batch.

Required rehearsal result: every current source domain accounted for; no unexplained loss of authored state; reconciled IDs and constraints; no tenant leaks; repeated load/retry safe; a late failure rolls back data and sequence effects; real representative queries pass. Measure actual storage and runtime latency once the real target is populated.

## 6. Finite delivery sequence

These retain M0–M7 names so prior work stays traceable. Completed foundations are reused, not repeatedly re-audited without a changed dependency.

| Gate | Remaining work | Done when |
|---|---|---|
| Recovery / plan update | Reconcile branches, current edits, tools, lost temporary files and live project status; revise scope | Current status and resumable next batch recorded. |
| M1–M2: existing foundation | Keep accepted schema, tenant isolation and safe-import protocol; validate additions through relevant existing tests | Immutable history matches; new migrations replay with grants, RLS, import fencing and rollback checks. |
| M3: current-data rehearsal | Completed: all current dispositions, full local load/parity/restore and the approved remote upload pass. All eleven target migrations are applied; 63 remote relation fingerprints match. After target-only vacuum and eleven measured index rebuilds, actual database is 455,978,131 bytes (~456 MB); all 63 fingerprints remain exact | A current consistent snapshot loads into the isolated target with explicit preservation/disposal results and no unexplained failures. |
| M4: current-app reads | Session, Library, Dashboard, Collections, Wishlist, whole completion review and whole-pool Vault/bounded history are locally integrated; preserved and live learning, whole-account capabilities and guest reads are locally accepted; real-account/HTTP acceptance and the V2 production build pass | Session, Library, Dashboard, Collections, detail, Wishlist and Vault checks pass without full-library bootstrap. |
| M5: current-product writes | Sign-in/resumption, permanent Blacklist, completion/Undo/dismissal, atomic 500-game review, pins, Collections, Wishlist, server Vault and Family are locally accepted. Whole Steam import enqueue/status/live worker adapter, bounded owned-only pinned refresh and whole-account capabilities are locally accepted; worker SQL deadlines are bounded and public guest catalogue uses V2. Catalogue metadata and bounded nightly owned/pin scheduling are locally accepted, including claim/publication concurrency and Family metadata refresh. SteamSpy/Store tags, bounded endless sweep and worker regressions are locally accepted. Live learning and UTC daily playtime capture are locally accepted. Catalogue review/Deck parity is accepted and applied. Inactive remote runtime roles and positive HTTP reads/preview are accepted; real production-cookie continuity and final-data recovery remain launch checks | Existing user journeys and focused concurrency/failure tests pass; retired promotion is absent. |
| M6: release readiness | Synthetic 10k and representative real-account/concurrent reads, bounded payloads/worker deadlines and full 23-migration local restore pass. Final frozen-data/cutover acceptance remains | Measured 10,000-game edge account, representative concurrent workload, bounded payloads/queues and a successful restore drill. Expand scale only if evidence warrants it. |
| M7: production transition | Final freeze/export/validation, matching runtime configuration and authority switch | Explicit release gate, recorded authority, post-switch checks and tested recovery procedure. |

Do not require speculative 50,000-user infrastructure, new ML models, a generalized pricing platform or achievement polling to complete this migration. Keep indexes driven by actual queries. Preserve the already accepted data-integrity and isolation requirements; economise by avoiding duplicate implementations and repeated review loops.

## 7. Cutover and recovery

**New user release-selection gate, 30 September:** Before the final freeze, combined push/deployment or authority switch, inventory the pending updates on main and other branches/worktrees, name the distinct work, and ask which items to push and which to exclude. Prepare the selected work as one coordinated release. Earlier conditional cutover authorization does not bypass this selection. Continue database preparation/validation; do not merge or publish unrelated work merely because it is present.

Follow [the concrete cutover runbook](v2-cutover-runbook.md). Before release, reconcile current source/app versions, retain the provisioned least-privilege runtime connection privately, verify production session-secret/cookie continuity and rehearse the final freeze. Eight stale imports require fresh complete reconciliation; known cooldown windows come from their actual callers and unknown buckets remain blockers. Freeze relevant writes/workers, take the final consistent snapshot, load and validate, then switch the app and scheduled work together. Do not silently fall back to the legacy database on errors.

Rollback to the old database/build is safe only before new V2 production writes. After those writes, roll forward or use tested reverse replay; switching back without replay loses user changes. Keep the old database read-only for a bounded recovery period and remove retained exports under the existing retention policy after validated cutover. The user subsequently explicitly authorized completing integration, refreshing all required source data (including new users) near completion, and then the real switch once these gates pass. Routine runtime configuration/deployment necessary for that switch is within scope; commit/push, paid upgrades and destructive production deletion remain separate.

## 8. Continuation

Read [execution status](v2-execution-status.md), inspect current Git status and the relevant diff, then take its next bounded batch. Preserve user edits and current theme/Wishlist work. Keep credentials and raw source data out of checkpoints. Record actual validation and remote application separately; local code, historical acceptance and deployed state are different facts.

For the smallest launch database, measure after the final load: vacuum/analyze bulk-loaded relations and rebuild only demonstrably sparse indexes while the target is inactive and has working-space headroom. The measured Library/catalogue heaps are already packed; no full rewrite is warranted by present evidence. Temporary migration staging/evidence is the larger remaining reduction opportunity, but remove it only after final reconciliation under the registered retention/cutover policy. Check both database quota and WAL/disk growth; do not assume the present rehearsal size proves final capacity.

When interrupted, leave the exact branch/commit, changed paths, test failures, remote state, and next command or batch in the status document. `continue` should resume that work without repeating the entire audit.
