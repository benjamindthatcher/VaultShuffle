# Sign-in and import diagnostics

These diagnostics use PostHog plus structured Vercel function logs. They add **no Supabase tables or diagnostic rows**. Existing session, import-job and account-merge writes remain application state, not a logging store.

## What is recorded

| Surface | Coverage |
| --- | --- |
| Steam sign-in | Start/redirect, callback validation, OpenID verification, optional profile metadata, account/session creation, success, cancellation and failure |
| Profile URL setup | Validation/rate limit, reference resolution, profile/library lookup, snapshot cache, account/session creation, library handoff, session response |
| Securing a manual profile | Intent creation, callback verification, merge failures and analytics-delivery warnings |
| Library import | First fetch, job staging, completed batches/import, upstream errors, cooldowns and failed batch saves; optional recent-activity enrichment runs in the nightly worker |
| Other APIs | Shared `jsonError` failures with route/method/status; bootstrap partial failures and session metadata warnings |
| Uncaught server errors | Next.js `onRequestError`, including route handlers, rendering and server actions |
| Browser | Failed API requests, import failures/deferred attempts and the global React error boundary; existing PostHog exception capture remains enabled |
| Request guards | Origin, body-size and content-type rejections in Vercel logs only, to avoid flooding product analytics with probes |

Events are `server_operation` and `server_error`. Filter by `operation`, `stage`, `outcome`, `error_code`, `upstream_status`, `database_code`, `status`, `request_id`, `flow_id` or `operation_id`. Server failures preserve approved SQLSTATE/PostgREST codes, not SQL messages or row contents. An opaque `error_fingerprint` groups failures by code location without exporting stacks; missing configuration has its own code. Next.js error digests connect render failures to the browser boundary.

`X-Request-Id` connects a browser failure to a server request. Manual setup sends an operation UUID through lookup and create. Steam redirects carry a separate 15-minute, HTTP-only diagnostic flow cookie; it grants **no authentication or ownership authority**. Account UUIDs are recorded only when known by the server. Replay/distinct IDs from the analytics cookie are untrusted correlation hints, never authorization inputs.

## Privacy and volume

- Do not pass raw errors, stacks, submitted profile URLs, Steam IDs, display names, cookies, tokens, keys, request/response bodies or full URLs to diagnostics. The shared serializer only accepts approved properties and strips query strings/dynamic route segments.
- PostHog delivery requires the browser's analytics consent mirror and respects opt-out, DNT and GPC. An absent mirror fails closed. Structured operational logs still record sanitized failures.
- The mirror cookie contains consent plus PostHog UUIDs only. It does not contain `vault_session`. Signing out clears/replaces analytics identity through the existing client flow.
- Each request batches at most 20 events. There are no per-game events and no successful status-poll events. Completed imports and important authentication outcomes are unsampled.
- No new PostHog person profiles are created by server diagnostics (`$process_person_profile: false`); server geolocation is disabled.
- Delivery runs in Next.js `after`, with one awaited request and a 3.5-second timeout. Uncaught-error instrumentation awaits delivery directly. A failed delivery is logged as `diagnostics_delivery_failed`; it never changes the application response or writes a retry queue to Supabase.
- An abruptly killed function may never reach `after`. Its immediate Vercel log is the fallback. Logging improves detection and diagnosis; it cannot guarantee Steam availability.

## Configuration and deployment verification

Existing `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` and `NEXT_PUBLIC_POSTHOG_HOST` configure capture. EU is the default ingestion region. `VERCEL_ENV` and `VERCEL_GIT_COMMIT_SHA` separate environments/releases. No new secrets, database migrations or PostHog admin API key are required.

After deployment:

1. With analytics enabled, complete one Steam sign-in and one profile URL setup in a test account. Verify both server outcomes in PostHog and the corresponding request references in Vercel.
2. Confirm a manual setup reports `cache_result = hit` at `setup_library_handoff`, then imports the saved job without another `owned_games` fetch. Vercel Runtime Cache must be available in the deployment region. Cache misses/eviction are safe and observable.
3. Check a cancelled Steam sign-in, invalid profile input, and a simulated upstream cooldown in a non-production environment. Never deliberately exhaust the live Steam API limit.
4. Repeat with analytics disabled: no server diagnostics should reach PostHog. Operational logs should remain useful.
5. Check for `diagnostics_delivery_failed`. PostHog outage or misconfiguration must not break sign-in.

The automated route tests use the actual route handlers and signed lookup-token implementation with in-memory service adapters. They do not authenticate a real Steam identity or mutate a live database. A local build without production environment configuration cannot substitute for the post-deployment checks above.

## Investigating an incident in PostHog

```sql
SELECT
  properties.operation AS operation,
  properties.stage AS stage,
  properties.error_code AS error_code,
  properties.upstream_status AS upstream_status,
  properties.database_code AS database_code,
  count() AS events,
  uniq(distinct_id) AS affected_visitors
FROM events
WHERE event IN ('server_error', 'server_operation')
  AND properties.environment = 'production'
  AND properties.outcome IN ('failed', 'deferred')
  AND timestamp > now() - INTERVAL 1 DAY
GROUP BY operation, stage, error_code, upstream_status, database_code
ORDER BY events DESC
```

For an individual attempt:

```sql
SELECT timestamp, event, properties.operation, properties.stage,
       properties.outcome, properties.error_code, properties.request_id,
       properties.flow_id, properties.operation_id, properties.replay_id
FROM events
WHERE properties.request_id = 'REPLACE_WITH_REQUEST_UUID'
ORDER BY timestamp
```

Search `flow_id` for the Steam redirect journey and `operation_id` for manual setup. Replay correlation is also attached as PostHog's `$session_id`. Expected input/privacy outcomes should be separated from service failures; a private or empty library is not a broken sign-in.

Suggested alert starting points (configure recipients and thresholds in PostHog after observing the new production events):

- Two or more visitors with `steam_rate_limited` within 15 minutes.
- Any new database error code in `account_and_session_create` or `account_merge`.
- At least five sign-in/create failures and a failure rate over 10% in 15 minutes. Count distinct request IDs, not all milestones.
- Repeated setup handoff misses or no import completion following creation.
- `diagnostics_delivery_failed` in Vercel: the monitoring pipeline itself needs attention.

These alert rules are recommendations, not already-created alerts.

## Reliability changes

- Steam 429s return HTTP 429 plus `Retry-After`/`retry_after_seconds`, not a generic 502. Browser auto-retry excludes cooldown, privacy, validation and authentication failures. Cooldowns persist in session storage across reloads.
- Setup caches the fetched games for 15 minutes in Vercel Runtime Cache, in bounded chunks. Only the signed lookup token names the random snapshot; reads verify its Steam identity and expiry. A successful create stages the **existing** import job. Cache/staging errors do not hide the created session; dashboard fallback remains available.
- Private profile visibility, explicit zero-game responses, unknown library visibility, invalid/missing profiles, malformed upstream responses and temporary Steam failures have separate codes and honest copy. Unknown visibility is never asserted to be private. Manual rechecks bypass profile metadata cache so a privacy change is not hidden for 30 minutes.

## Tests

```sh
node --experimental-strip-types --test lib/diagnostics.test.ts lib/steam-reliability.test.ts lib/steam-library-snapshot.test.ts lib/auth-flows.test.ts
npm run typecheck
npm test
npm run build
```
