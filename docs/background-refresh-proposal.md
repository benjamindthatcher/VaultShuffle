# Background refresh proposal

Status: partial publication and independent freshness are implemented. The
remaining prioritisation and capacity suggestions below remain proposals.
User constraint: all automatic background refresh must run nightly.

## Implemented bug fixes

- Scheduled refreshes can now replace known Steam Deck ratings, including an
  upgrade, downgrade or Valve's explicit Unknown result. The previously committed
  `20261001150853_refresh_steam_deck_ratings.sql` migration was missing from live
  V2 and is now applied.
- Successful app details survive an HTTP 429 from the optional reviews or Deck
  lookup. Successful reviews also survive a later Deck 429; missing signals
  preserve their stored values. The worker stops further Store calls, and the
  database retains the shared 30-minute cooldown and a retry within the existing
  five-attempt bound. Exact response-loss replay cannot republish details, add
  price history or extend the cooldown. The supporting
  `20261001165805_preserve_metadata_on_optional_rate_limit.sql` migration is
  applied to live V2. The corresponding worker change is included in this release.

Both live migration records match their repository source hashes, and the live
function body matches the tested implementation. Worker-only execution and the
original lease/revision checks remain enforced. Applying these migrations did
not drain or modify the 13,292 pending jobs. The full repository check passed:
588 main tests, 193 V2 tests, type checking, lint, theme checks and the build.
Focused mocked-provider and isolated PostgreSQL cases cover optional 429s,
preserved facts, replay, stale attempts and retry exhaustion.

## Independent freshness implemented

`20261001172131_catalogue_signal_freshness.sql` and the catalogue worker recheck
metadata, reviews and Deck freshness when claiming a job. Each has a 30-day
clock. Existing review data has no invented check date and receives one refresh.
Current jobs finish without a Store request or spacing delay. Reviews-only and
Deck-only jobs preserve primary details, provider state and price history.

Missing or failed optional signals retain their previous values and a bounded
retry. Successful signals advance only their own clock; zero reviews and Valve's
explicit Unknown rating count as valid results. Lease/revision fences and replay
receipts apply to these partial updates as well as full metadata publication.

The nightly schedules, daily guards, 100-game ceiling, 100-second deadline,
650 ms Store spacing and shared 30-minute rate-limit pause remain unchanged.
The worker summary now includes skipped jobs. Required CI runs type checking,
lint/theme checks, main tests, isolated PostgreSQL V2 tests and a production build.
CI uses an empty TLS-enabled local database with restricted app credentials.

## Remaining capacity considerations

The catalogue queue contains 13,292 pending games. These jobs were created after
today's 04:00 UTC worker slot, so the absence of completions does not establish a
stuck worker. The problem is capacity: one short run each day cannot keep a large
backlog current.

The V2 catalogue worker has a 100-second deadline and a nominal limit of 100
games. A game with all three signals due needs details, reviews and Steam Deck
requests, with 650 ms spacing. Current and partially current games use fewer calls. The deadline will usually stop work before the
100-game limit. The owned-library scheduler admits up to 20 accounts per daily
run; the audit found 741 eligible accounts, including 238 seen in the last month.
Even with successful processing, a complete rotation at 20 per day takes about
38 days.

## Recommended behaviour

1. **Prioritise useful work.** Fill missing descriptions and images for recently
   active users before refreshing complete older records. Reserve some capacity
   for older jobs so they continue advancing. Give recently active users first
   access to the nightly library refresh; rotate inactive accounts less often.
   A nightly run does not guarantee that every account refreshes each night.
   Keep user-requested refreshes in their existing interactive lane.
2. **Skip work already satisfied.** Recheck freshness when claiming a job and
   coalesce overlapping requests for the same game. Do not make a Store request
   merely because an old `owned_identity` job remains pending. Metadata, reviews
   and Deck ratings need their own freshness decisions; a recent description
   must not prevent a genuinely due Deck update.
3. **Publish details independently.** This is implemented as described above.
   The next admitted retry fetches only signals whose freshness check is due.
4. **Use the existing nightly time efficiently.** Retain the nightly schedules,
   daily admission guard and 100-second work deadlines. Spend most catalogue
   capacity on missing primary details, with a reserved share for due reviews
   and Deck ratings. Fetch only the signals that need refreshing, rather than
   all three signals for every game. Keep the existing 100-game ceiling and
   account for provider requests separately. For libraries, consider refilling
   the existing 20-account cohort after it drains while time remains, retaining
   the overall 150-claim ceiling, bounded concurrency and pending-job capacity.
   Measure the nightly throughput before changing those ceilings. Keep existing
   Steam Web API quotas, transaction leases, revision checks and the shared
   30-minute Store pause after a 429.
5. **Measure each batch.** Record claimed, published, retried, failed and skipped
   counts, provider requests and duration. Read pending count and oldest due-job
   age from the existing queue. Investigate three admitted runs with due work
   and zero progress; distinguish a provider pause or exhausted allowance from
   a fault. Use one summary per run, with no per-game analytics events.

Even at the current ceiling of 100 catalogue games per night, 13,292 jobs would
take at least 133 nights if every job required a fetch and no new work arrived.
Actual throughput may be lower because of network time and provider limits.
That is why freshness skips, shared-game deduplication and useful-work priority
matter more than simply increasing the nominal batch size. The intended result
is that visible missing details improve first; a full backlog-clearance date
should be calculated from measured nightly progress.

## Scheduling and cost

Keep the existing Vercel nightly schedules and their once-per-day reservations.
Empty queues should exit immediately. Duplicate deliveries remain blocked, and
failed runs resume on the next night through the existing queue leases and
retry state. This proposal uses the current hosting plan and scheduling system.

The function time ceilings remain fixed. Making more useful progress within
them can increase provider requests and database work, so the run summaries
must track both alongside duration. A provider pause must stop that night's
affected work; it must not start another automatic run later in the day.

## Verification before rollout

Use isolated PostgreSQL and mocked providers to verify duplicate scheduling,
freshness skips, priority with older-job progress, partial enrichment, provider
429s, exhausted daily limits, expired leases, cohort refill and replayed
publication. Verify that details-only work cannot erase stored review or Deck
facts and that reserved signal work and older jobs continue advancing. Review
several nights of actual batch counts and queue-age movement before increasing
any ceiling. Use the existing run records and bounded operational history.

Nightly schedules, daily admission guards and batch/time ceilings are unchanged.
Priority, cohort refill and increased capacity remain proposals pending nightly
throughput measurements; independent freshness and request skipping are implemented.
