# Hosted worker policy

Duration enrichment is local-only. Vercel's retained metadata jobs fetch Steam library/Store data and SteamSpy community tags. No hosted worker looks up IGDB/HLTB durations; the application continues reading already-stored duration data.

## Steam schedules

| Route | Daily UTC schedule | Bounded work |
| --- | --- | --- |
| `/api/cron/pinned-playtime` | 01:00 | Pinned games only; up to 150 accounts with pins, 4 concurrent; 90-second work deadline, 120-second function limit |
| `/api/cron/nightly-metadata` | 03:00 | Up to 150 accounts, 3 concurrent; 90-second work deadline, 120-second function limit |
| `/api/cron/catalogue-metadata` | 04:00 | Up to 40 catalogue games; 90-second work deadline, 120-second function limit |
| `/api/cron/steam-tags` | 05:00 | Up to 60 tag jobs; 70-second work deadline, then guest-pool materialisation; 120-second function limit |

Hobby delivery can occur anywhere within the scheduled hour; these are not exact appointment times. Adjacent stages reconcile stored state and do not depend on precise delivery order. Schedules are UTC and do not shift with British Summer Time. See [Vercel scheduling documentation](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

The existing 06:00 UTC `genre-preferences` schedule is retained unchanged. It refreshes feedback-derived recommendation preferences, not durations, and remains separate from the three Steam workers.

## Cost and retry controls

These controls apply to the four Steam workers above. The retained recommendation-learning job keeps its existing execution behaviour.

- `CRON_SECRET` is required. Preview deployments refuse execution even with a valid secret. No query parameter overrides batch/time limits.
- The existing atomic `consume_api_rate_limit` RPC reserves one run per worker per UTC day. This guards duplicate delivery, concurrent requests and repeated manual poking without new tables. Two-day cleanup already exists for these tiny reservation rows.
- A failed run retains its daily budget. There is no automatic same-day retry or HTTP backfill endpoint. Investigate logs, then let the next nightly run resume outstanding work; use local tools for deliberate bulk work.
- Time budgets leave room before Vercel's hard limit. A hard timeout can still interrupt an in-flight DB call; queue leases recover through existing claim functions on a later run.
- Steam Store processing defers the rest of a batch on 429. SteamSpy now does the same, releases untouched claims in one DB update and stops after three consecutive errors.
- One small `metadata_worker_runs` record remains per actual run. Library failure details are capped at 20 sanitized codes. Operational failures also use structured Vercel diagnostics; no per-game analytics flood is added.

The four Steam functions have a combined eight-minute *wall-time ceiling per admitted daily set*. This is not a CPU billing prediction. It excludes normal user requests and the retained recommendation-learning job.

## Pinned playtime

The new `pinned-playtime` worker is strictly separate from the full-library sweep. It selects only accounts with current Owned library pins (the visible Playing next shelf), requests only their pinned AppIDs via Steam's `appids_filter`, and rechecks account ownership/current library pins inside `refresh_pinned_steam_playtime` before updating. It never imports a game, touches an unpinned row, changes `hours_at_pin`, runs catalogue/tag/duration enrichment, modifies quarantine or writes a full-library snapshot from a partial pin response. Observed-minute baselines use the full import's existing 0.1-hour precision so switching between workers cannot manufacture recency evidence.

The worker makes one attempt per selected account, shares identical pin requests within the run, continues past individual failures, stops the next batch on Steam 429, and stops after three wholly failed batches. A saved cursor continues the next daily run if the time/account ceiling is reached. It is daily on the current Hobby plan, not real-time or hourly. The separate manual pin button does not invoke a cron.

Full-library **Refresh Steam data** still fetches an uncached owned-games response, stages and saves `hours_played` for every imported batch, then reloads `/api/app-data`. Pinned UI derives current hours from those same game rows while retaining the original pin baseline. The Steam import RPC now preserves higher saved hours/observed minutes against missing/zero/stale responses; this does not prevent explicit manual game edits. Display precision remains 0.1 hours. Full-library snapshots use saved Owned rows instead of untrusted response zeros.

Apply `20260831175217_add_steam_playtime_refresh.sql` and `20260831175537_harden_pinned_playtime_scope_and_precision.sql` before deploying these callers. `supabase/tests/pinned_playtime.sql` verifies pin-only writes, cross-account isolation, unpin/re-scope races, consistent precision, baselines/player state, stale responses, full import refresh and snapshot totals in a rolled-back transaction. Browser roles have no access to the new service-role-only RPCs.

## Library sweep and normal use

The library sweep uses a bounded keyset scan across both identity tables. Its last attempted account UUID is saved in the existing run summary to continue next night, wrapping at the end. This avoids always starting with the first accounts. Large populations can take multiple nights to traverse; this is not a promise that every account refreshes every 24 hours.

Accounts referring to the same Steam identity share owned-games and recent-activity fetches within the run, while their separate VaultShuffle data stays separate. A rate limit stops the next batch. Playtime snapshots capture observed data only: an unobserved day's playtime cannot be reconstructed.

User-requested sign-in, initial library imports and manual library refresh still work. They queue missing catalogue metadata but no longer start `after()` catalogue or recent-activity workers. Missing shared metadata is filled by later nightly passes. Explicit user-initiated Steam searches/game details are not background workers and remain available.

The tag worker writes tag fields, not duration estimates/classifications. Existing database projection/classification rules and stored duration evidence are untouched. Guest selection is rebuilt from stored data after tag processing, not by looking up durations.

## Removed entry points

- `/api/cron/durations`
- `/api/durations/process` (GET and POST)
- `/api/catalogue/process` (GET and POST; the manual bulk drain)
- The duration loop inside `nightly-metadata`
- Background enrichment after user imports

Legacy duration-worker source is retained for reference and guarded against Vercel execution. The local duration admin's old `process` command no longer invokes a Supabase function. See [local duration workflow](../supabase/README.md).

## Deployment and verification

Editing `vercel.json` does not alter a running deployment. Vercel updates/removes schedules on a new production deployment. Do not deploy unrelated uncommitted work as part of this change.

After an approved deployment:

1. Confirm the production cron list matches `vercel.json` and contains no duration route.
2. Confirm both old duration URLs and the manual catalogue-processing URL return 404, not a worker result.
3. Check unauthorized retained cron requests return 401 without a DB reservation.
4. Observe the next scheduled runs: bounded counts/time, saved cursor and rate-limit/partial outcomes. Do not repeatedly invoke production crons just to test them.
5. In an isolated duplicate test, expect `skipped: true, reason: daily_budget_used` and no second task execution.

No production cron invocations or duration writes are needed for the local regression suite:

```bash
node --experimental-strip-types --test lib/nightly-workers.test.ts
npm run typecheck
npm test
npm run build
```
