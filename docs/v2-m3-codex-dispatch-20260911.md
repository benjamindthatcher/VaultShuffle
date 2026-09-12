# M3 Codex execution batches — 11 September 2026

**SUPERSEDED CONCURRENCY, 12 September:** latest user amendment permits at
most TWO active subagents, and the second must have independent useful work.
Use Sol/Terra/Luna at task-appropriate effort. Root controls scheduling;
workers must not delegate or resume siblings. Let full batches finish. Current
active scopes and queued loader integration are in the execution ledger.

This is the current ownership and resume handoff. The user's latest instruction
is to fill Codex with substantial autonomous work before coordinator usage runs
out, choosing economical models according to task difficulty. It supersedes
older Claude-first / fixed max-agent instructions for this dispatch. Both Claude
batches have finished; do not send them more work or resume the old max Lunas.

## Shared facts and boundaries

Repository: `/Users/benthatcher/Documents/GitHub/VaultShuffle`, shared checkout
`codex/v2-architecture`; observed HEAD
`b51dcd163a923bba0315dac125fa7d945690d4e9`. Preserve all dirty and untracked
work and user footer commits. No reset, checkout, commit, push, dependency
upgrade, deployment, provider activation or production change. Do not create
worktrees that omit the untracked v2 implementation. Read the current plan,
relevant contracts and this dispatch; historical ledger instructions are history.

M0/M1/M2 are complete. M3 is incomplete. Source `pfvblcopcmairdfeqdep` remains
authoritative and read-only; target `vbjtbwelnhbbdfrqczyf` is the separate
rehearsal database. This batch authorizes **local synthetic work only**. No
remote access, secret discovery, auth provisioning, real export/load or target
DDL. Source DB credential/TLS/full-row-access proof is still a known external
prerequisite; do not reopen the exhausted access investigation.

Applied migration files are immutable:

- M1 `20260906093036_m1_private_foundation.sql`, SHA256
  `54fe0a7defd029e91568b78d51393670ac7ca6edcf915919670c7f64c2476389`.
- M2 `20260907163356_m2_jobs_quota_publish.sql`, SHA256
  `f09d7ca900f3cdaaee81eff0f507adc5869865f16eb7f340eeb1729223bc5aba`.
- M3 `20260910232654_m3_preservation_schema.sql`, SHA256
  `605b72a3d9df1328ec27033c3420c1813a238f6e15bd8fc28f971cddaf30a24a`.

Latest accepted remote metadata is `database/v2/m3-target-validation-20260911.json`:
92 tables / 991 columns, private RLS/security and rollback gates passed, no real
rows. It is dated evidence, not a fresh remote check. Marker deliberately `m1`.
Both databases use UTC: preserve microseconds, NULLs and civil dates, never
apply a geographic offset. No private cells, tokens, hashes or export rows in
chat/logs. Existing exporter/reader provide the accepted private-file boundary.

Use shared PG17 binaries at `node_modules/.cache/vaultshuffle-pg17-20260910`
read-only; allocate your own uniquely named cluster, socket and port. Existing
integration harnesses show initialization/extension/bootstrap patterns. Stop
only your own server. Do not rebuild binaries or repeat accepted unrelated
gates. Read AGENTS.md; read relevant installed Next guides before any Next API
work. These assignments are standalone migration tooling, not Next UI changes.

## A — preservation and provider integration (Sol / High)

Own existing `lib/v2/migration/transform/{games*,catalogue*,provider-shared*,
duration-provider*,library*,family*,history*,provider-constraints*}`; existing
domain contracts/checkpoints for those modules; the preservation proposal;
new local follow-up SQL/tests; and `database/v2/migration/**` manifest/index/
validator files. Do not modify identity/scalars/session/capability/M3-G modules,
remaining-domain modules or `lib/v2/migration/load/**`.

1. Complete a focused acceptance review of both finished Claude returns:
   `docs/v2-m3-preservation-followup-checkpoint.md` (latest 128 unit / 27 PG),
   `docs/v2-m3-preservation-final-review.md`, and provider checkpoint/contract
   (40 provider tests, 143 catalogue, 14 PG; reported combined 480). Prioritize
   the three corrected preservation defects and actual data-loss boundaries.
   Fix reproduced issues within your ownership and validate autonomously.
2. Check the provider durability requirement against plan sections 5.4, 7,
   13 and 14.2. Current queue transforms appear archive-only and describe
   retiring retry schedules. Expiring staging is not durable terminal/backoff
   state. Preserve useful terminal rejections and applicable backoff in the
   actual `catalog.provider_state` contract (or exact private durable evidence
   with a blocker where the mapping cannot be justified), without restarting
   production leases/queues or inventing provider attribution. Inspect actual
   legacy status writers and catalogue tags retry fields. Prove cleanup cannot
   erase the only terminal state and cause repeated rediscovery/refetch. Do not
   silently declare all retry fields disposable.
3. Verify Wishlist never implies never-owned, null loss time is restricted to
   labelled Wishlist/unknown, family tombstones confer no active access,
   divergent raw/observed clocks survive durably, and family minutes cannot
   become borrower personal activity. Nonempty preservation exceptions must
   be countable unresolved final-load blockers. Fix the raw NUL delimiter in
   library-shared.ts to an escaped literal with identical runtime semantics.
4. Once locally accepted, prepare a new immutable follow-up migration from
   the proposal, with a fresh unused version and exact checksums. Do not apply
   remotely. Keep applied/proposed index status truthful: this SQL is locally
   prepared, not target-applied. Update manifest dispositions/physical index
   and validators to represent its status without erasing the five remaining
   source-dependent relation decisions or exact-hours blocker. Do not mark a
   decision resolved using historical aggregate audits instead of the export.
   Include a concise exact target-apply review packet with rollback/rebuild,
   RLS/privacy/retention/default/constraint evidence and remaining gates.
5. Run owned regression tests, strict TS/lint and one fresh synthetic PG17
   rebuild with all immutable migrations plus the new follow-up. Exercise
   emitted outputs and adverse SQL cases. Report concrete gaps rather than
   invent a lossy source semantic. Tell C the definitive local schema path,
   target-row changes and provider output interface as soon as frozen.

Return `docs/v2-m3-codex-preservation-checkpoint.md`. Update it after substantial
phases with completed commands/results and exact next action, including on
interruption. You may finish all phases without waiting for root. Root retains
remote-apply approval and overall milestone signoff.

## B — remaining source-domain transforms (Terra / Medium)

Own new `lib/v2/migration/transform/reco-config*`, `support-ops*`,
`legacy-operations*`, `remaining-shared*`, associated tests/local PG harness,
`docs/v2-m3-remaining-contract.md`, and
`docs/v2-m3-codex-remaining-checkpoint.md`. All applied SQL, generated indexes,
existing transforms and root ledger remain read-only.

Implement the remaining pure typed source dispositions completely, using the
actual physical schema and exact scalar/private error helpers:

- `user_genre_preferences`, `genre_preference_globals`,
  `game_preference_globals`: versioned frozen warm-start evidence, exact
  counters/decimals and account/game/provenance mapping; no invented training.
- `algorithm_weights`, `app_settings`: versioned validated configuration;
  separate secrets from ordinary values without logging them or activating
  workers/features. Unknown/secret-like semantics require private quarantine
  and explicit blocker, not leaked settings or invented defaults.
- `contact_messages`, `feedback_submissions`: exact private support contents,
  statuses/times/account references and retention/deletion behavior.
- `metadata_worker_runs`, `steam_import_jobs`, `api_rate_limits`: bounded audit
  and explicit deterministic cutover/freeze/cooldown plan. Do not resume old
  jobs, reset live cooldowns, invent freeze time, or close source-dependent
  decisions from a synthetic test. Require supplied exact cutover evidence
  and produce blockers when absent.
- Audit and implement residual `account_merges` durable audit/alias outputs
  and `manual_profile_security_intents` expiry/disposition if existing identity
  transforms only return evidence. Reuse their stable outputs and same-run
  account map; never elevate/revive merged sessions or infer deleted accounts.

Read disposition files `05-reco-and-config.json`, `06-support-and-ops.json`
and relevant `00-identity-and-sessions.json`, the exact frozen schemas, current
source writers and plan. Every owned source column needs an explicit durable,
bounded archive, rebuild or blocking disposition. Preserve exact decimal/JSON
and UTC source facts. Account identity never comes from unverified request data.
Do not introduce a new physical schema on your own: report a minimal proposed
contract to A and keep explicit blockers while completing unaffected work.

Make exported interfaces available early in your contract and send their names
to C so it can integrate without waiting for tests. Reuse established input
shape: same-run identity/account/GameMap, COPY strings/null, stable errors,
deterministic sorted output, counted conflicts/exceptions, exact target-record
shapes. Do not build a parallel ID/map/scalar system. If provider provenance
requires a source instant, use a supplied actual fact or block, never Date.now.

Run meaningful unit/permutation/adverse tests, owned TS/lint, and a synthetic
actual-PG17 output/constraint/privacy gate with your own fixture. Prove exact
round trips, cross-account rejection, deleted/unknown owner handling, secret
redaction and no runnable legacy jobs. When complete, send A precise manifest
changes needed and C definitive exported entry points. Do not wait for root
between ordinary implementation/debugging phases. Bank the completed batch
and remaining true source/schema dependencies in your checkpoint.

## C — local migration loader, reconciliation and run pipeline (Sol / High)

Own new `lib/v2/migration/load/**`, synthetic loader fixtures/harnesses,
`docs/v2-m3-loader-contract.md`, `docs/v2-m3-codex-loader-checkpoint.md` and
`docs/v2-m3-local-runbook.md`. Existing export/read/transform/SQL/manifest
files are read-only. Coordinate needed changes with A or B; do not edit
sibling files. Package/scripts edits are root-owned; document executable
commands without modifying package.json.

Deliver the substantial missing local pipeline, not merely a design or mock:

1. Define and implement a private verified-reader -> staging/transform ->
   target adapter pipeline, with clear phases and dependencies. Consume the
   accepted reader and existing transforms. Establish deterministic complete
   account and AppID maps before dependent transforms, preserving their same
   run/snapshot identity. Integrate all source relations, including counts for
   views/explicit retirement and all B outputs when ready. Use staged bounded
   disk/DB work where required; no unrestricted all-source in-memory copy.
2. Implement safe local PostgreSQL execution using existing helpers where
   suitable: fixed allowlisted relations/columns, bound values or correctly
   encoded COPY, exact bytea/timestamptz/numeric/JSONB representation, generated
   identity override and sequence advancement, FK order, tenant-scoped maps,
   immutable manifest/transform/schema fingerprints, applied-step bookkeeping,
   replay/failure rollback and mismatched-run rejection. Keep real/remote
   execution disabled in this batch; no implicit environment or secret lookup.
3. Refuse final publication if reader streaming fails after emitted rows, any
   transform exception/unresolved conflict exists (including recency and
   completion ordering exceptions), mapping/count/column coverage fails,
   schema drifts, snapshot-sensitive decisions are absent, or checksums differ.
   Do not hardcode a validator-success flag or bypass fail-closed manifest
   decisions for production. Synthetic explicit evidence remains labelled.
4. Produce private machine-readable reconciliation: every intended account's
   identity and personal/family AppID sets, exact minutes/NULL counts, retired
   state/activity/clocks, collections/commitments/history, session kinds and
   catalogue/provider/support/preferences. Counts alone are insufficient:
   stable per-relation/per-account canonical checksums must detect swapped
   game identities and changed authored facts. Record snapshot/schema/code/
   transform versions, durations and actual table/index bytes for synthetic
   runs; do not present synthetic storage as real-user measurement.
5. Run one end-to-end actual local PG17 synthetic export/verified read/
   transform/load/reconcile fixture, plus focused fault injection: damaged
   stream after callbacks, unknown IDs/cross-tenant refs, unresolved anomaly,
   exact large numbers/JSON and microsecond timestamps, duplicate retry,
   wrong-run/schema state, rollback and sequence next insert. Test loader
   storage representation rather than just comparing its own mock output.
   Include an actionable local rehearsal/runbook with every real-source and
   target approval prerequisite left explicit. Never mark M3 complete.

A is reviewing/finalizing preservation/provider row shapes and local follow-up
SQL; B is creating remaining-domain entry points. Freeze your independent
transport/staging/run/checksum foundations first, then integrate their finished
contracts. Ask them directly for concrete cross-domain decisions. If a
dependency is unfinished, continue your independent phases and persist an
exact remaining integration queue; do not poll their code repeatedly. Existing
M3-G commitments/collections/draws code has 129 unit / 12 PG tests but not a
substantial coordinator review: include its adapter/accounting boundaries in
your integration work, fixing your adapter or sending concrete defects to root.

## Coordination and completion

These three batches can execute independently within their file ownership.
No extra subagents/Claude fan-out is needed. Do the work, debug and validate
autonomously; send only frozen interface changes, true cross-domain blockers
and completed returns. Read finished sibling results once at integration gates.
Keep each owned checkpoint current at meaningful phase boundaries so a user
can resume with only `continue` after usage interruption. Do not edit
`docs/v2-execution-status.md` (root-owned). A worker finishing its batch does
not establish M3 or overall completion.
