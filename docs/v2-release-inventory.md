# Coordinated release inventory

Assessed inventory, 1 October 2026. The user selected all seven groups on 1 October and excluded the optional logging patch. This authorizes the selected coordinated release. The remaining credential-upload confirmation and cutover verification still apply. The selected work is assembled in an unpublished local main release commit whose parent is `bbd836e`; do not wholesale merge/reset other worktrees.

## Named pending work

| Name for release selection | Current source / scope | Remaining assessment |
| --- | --- | --- |
| V2 database and application integration | Main `database/v2`, `lib/v2`, `/api/v2` and current product pages/provider. Preserved auth, Library/Blacklist, Dashboard, Collections, Finished, Vault, Family, Wishlist and complete Steam imports; bounded pins/capabilities. | Private app/worker logins and the staged runtime migration chain are applied to the inactive rehearsal. Real-account/HTTP and synthetic 10k read checks pass. Production build/public-blog boundary, real HTTP and full 23-migration local restore are accepted. Temporary source write-fence preparation is tested; fresh final transfer and eight stale-library recoveries remain after selection. Live learning and daily playtime capture are locally accepted. Shared catalogue, tags/endless, guest reads and bounded nightly owned/pin scheduling are locally accepted. Requires coordinated runtime + additive SQL release. |
| Permanent Library Blacklist | Main Library/actions/types, additive V2 schema and migration transforms. Sleep expiry/history solely for Sleep removed; manual reactivation retained. | Already locally accepted; preserve separation from existing Vault snoozes/history. |
| HLTB-only duration tools and IGDB retirement | Main plan, transforms and `scripts/durations` / removed IGDB tooling. | V2 retains the private evidence-review/undo workflow and bounded reviewed HLTB writeback; obsolete queue commands refuse to create unused V2 jobs. Do not revive IGDB paths from old branches. Applied migrations remain immutable. |
| Wishlist and regional Steam prices | Main Wishlist routes/components, catalogue preview, analytics/details/tests and source + V2 country migrations. | Main implementation includes the ranking behavior. The other worktree only extracts duplicate helpers and carries stale V2 placeholders; keep current main Store integration. |
| VaultShuffle Purple and shared stationary controls | Main theme/controls, product and public-page styling, button/theme standards and original landing-page exception. | Keep the user's restored landing presentation; final combined visual check after selected work is assembled. |
| Landing preview and public-page refinements | Main landing preview/draw/sign-in interactions, FAQ, footer, blog/SEO/metadata changes and analytics. | Name final feature-level changes from diff/thread context; do not treat already-published blog commits as new releases. |
| Profile flow simplification | Main auth and onboarding; removed secure manual-account promotion/merge UI; current resume/sign-in paths. | Preserve current user-approved behavior; no obsolete promotion architecture. |
| Playing Next, completion and Vault interaction refinements | Main product/shared components, recommendation kernel, review/completion and browser tests. | Some refinements are already on main; distinguish current dirty additions from published fixes. |
| Wishlist worktree residual (no additional ranking feature) | `/Users/benthatcher/.codex/worktrees/wishlist-release/VaultShuffle`, same base `bbd836e`. Worktree-only `lib/wishlist-taste.ts`; different `lib/wishlist.ts`, `wishlist-server.ts`, `wishlist.test.ts`. | Assessed: ranking logic matches main. `wishlist-taste.ts` duplicates the existing pure helpers in `play-next.ts`; imports plus obsolete Sleep compatibility and disabled V2 placeholders are the residual differences. Recommend excluding these redundant/stale copies. |
| Uncommitted endless-classification tests | `.claude/worktrees/determined-allen-a14723/lib/game-classification.test.ts`. | All 18 worktree test cases already exist on main, with additional safeguards. No extra changes to collect; keep the worktree until final cleanup. |

## Branch / worktree disposition to review

`git fetch origin` completed on 1 October. Main and origin/main remain `bbd836e`; there are no new remote-main commits. Local and remote refs were assessed with `git cherry`.

- `codex/v2-architecture` has five non-equivalent commits including the recovery checkpoint. Its attached reconciliation worktree has earlier uncommitted transforms/manifests/migrations; current main has the reconciled accepted implementation. Compare useful residual changes; never merge its stale plan, IGDB behavior or applied SQL blindly.
- `claude/determined-allen-a14723` has one extra commit `7f39974`, fixing stale schema-cache behavior in the old duration/IGDB workers and worker-run helper. Those old hosted duration/IGDB paths are retired; The only applicable residual is a small legacy worker-log diagnostic change from silent missing-table/schema-cache errors to informational logs, preserved as an optional patch for release choice. Its uncommitted classifier tests are a separate item above.
- `Preview` and `play-next-claude-full` point at the same extra `a8ef210` “preview update” commit, containing older UI and data artifacts. Compare relevant residual product work; exclude protected/generated exports and deployment-link files from a normal application release.
- `codex/recovered-main-features` points at stash-shaped recovery `800af0f`; `db/shrink-user-games` has cleanup `93ceef9`. All recovered preview product/public-page files are already present on current main (with newer theme/behavior). No missing application files were found. Historical recovery evidence is superseded by current checkpoints; use selective comparison, not wholesale merge. The latter's historical migration cleanup must not delete current immutable applied files.
- Goal/learning and mobile-reroll branches are patch-equivalent to work already merged on main. Catalogue quarantine audit is also patch-equivalent. Other local legacy worker/import/store-tags/endless branches have no unique commits beyond main.
- Wishlist and V2 reconciliation worktrees remain dirty; eager-mclean is clean. `/private/tmp/vaultshuffle-store-tags` is a missing, prunable Git worktree entry with its branch still retained; no pruning/archive was performed.

No worktree was archived, no changes were copied over newer main files, and no commit/push/deployment/switch was made by this inventory. The final user selection has since been received; see below.

## Residual assessment and optional choice

The Preview/recovered product work is represented by current main: 15 files match the older preview exactly and 34 have later changes, primarily theme and subsequent behavior. No application files are missing. The preview commit also includes 27 export/cache/deployment/test artifacts that are outside a normal release. Do not copy them or merge the preview commit wholesale.

The V2 branch's missing historical `docs/v2-m3-rehearsal-evidence.md` is superseded by current M3 and execution evidence. Its immutable SQL and earlier transforms must not replace the accepted current chain. The cleanup branch is primarily deletion of historical migrations; exclude that destructive cleanup from this release.

Optional **worker logging diagnostics** is preserved at `docs/release-candidates/worker-logging-diagnostics.patch`: expose expected rollout schema-cache/missing-table errors as informational logs. It does not restore retired IGDB workers. This patch is collected for review and has not been applied to the application.

The final include/exclude request should use the named product units above plus this optional diagnostic item. Blacklist and HLTB-only remain required parts of the V2 migration. Deleting worktrees, changing published history and deploying excluded artifacts are not implicit release actions.

## Final selection names

The concrete release choice is the following seven groups. Database preservation includes the required permanent Blacklist and HLTB-only changes. Excluding a visible feature requires adapting its current V2 dependencies before publication; no discarded work will be deleted.

1. **V2 database, Blacklist and HLTB-only migration** — current app/runtime integration, safe imports/learning/workers, data transfer and coordinated authority switch.
2. **Wishlist and regional prices** — saved games, public Steam wishlist import, discovery and country-specific prices.
3. **Purple theme and stationary controls** — shared product/public styling and consistent controls, with the restored original landing presentation.
4. **Landing and public pages** — interactive preview, sign-in presentation, FAQ/footer/blog/SEO and the pending 1.2 release notes. Existing published blog commits remain part of main.
5. **Profile flow simplification** — public-profile resumption and removal of the old promotion/merge flow.
6. **Dashboard, Library and Playing Next** — completion history, selection/filter/detail improvements and saved-game behavior.
7. **Vault setup and recommendations** — setup/genre flow, draw actions and goal/learning refinements; keep already-published mobile/Steam-launch fixes.

Optional eighth choice: **legacy worker logging diagnostics**, the separately collected small patch. Recommend excluding it unless wanted; retired IGDB workers stay removed. Redundant Wishlist/classifier worktree copies, old preview export artifacts and historical migration deletions are excluded.

Recommend releasing all seven groups together and skipping the optional diagnostic patch. The user selected all seven groups on 1 October and excluded the optional logging patch. Proceed with the combined release checks and final transfer/switch; no push/deployment/freeze/switch has occurred yet.
