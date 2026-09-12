# VaultShuffle v2: architecture and execution plan

Version 1.0 · 5 September 2026 · reviewed against source commit `2e82939a9f1e8f85cd9516eafdc377ab1866e9eb` and live database aggregates.

This is the replacement for the supplied `VaultShuffle_v2_architecture_plan.md` and the older array proposal in `docs/database-capacity-plan.md`. Those documents are evidence considered during review, not execution instructions. This document is self-contained; a new engineer or agent can continue using the repository, the project references below, and the execution ledger in `docs/v2-execution-status.md`. Follow the decisions and gates here. If evidence requires a change, record the reason, affected contracts, migration and validation before proceeding. Do not silently reinterpret an unchecked milestone as complete.

## 1. Decision

Build a modular Next.js application with one Supabase PostgreSQL database, a compact relational library, independently retained user decisions, shared catalogue features, bounded page queries and durable background work. Preserve the existing data. No evidence justifies starting users from zero.

The dominant improvements are fewer bytes fetched per visit, fewer database round trips, reliable set-based imports, and correct lifecycle rules. Row count alone is not the problem. Tens of millions of narrow, indexed rows are a reasonable PostgreSQL design target; that statement is a design judgement to verify under the workload below, not a promise about a particular compute tier.

Keep the present interface and pure product rules where they work. Replace the monolithic data provider and database access behind it in complete vertical slices. Do not simultaneously redesign the visual identity, replace every framework, and change ranking behavior. All code may change, but each change needs a product or operational purpose.

### Environment boundaries

| Purpose | Exact target |
|---|---|
| Repository branch | `codex/v2-architecture` |
| Existing production, read-only during development | `VaultShuffle`, ref `pfvblcopcmairdfeqdep`, `eu-west-1`, PostgreSQL 17 |
| v2 development/rehearsal target | Existing `VaultShuffle2`, ref `vbjtbwelnhbbdfrqczyf`, `us-east-1`, PostgreSQL 17 |
| v2 database history | `database/v2/supabase/migrations/`, independent of incomplete legacy migrations |
| Intended application region | Vercel `iad1`, subject to measured placement verification |

The target was verified empty before this work. Creating another billable project is unnecessary. Production remains authoritative until the cutover gate. Existing uncommitted files on the original checkout are preserved; the execution ledger lists them so they are not mistaken for v2 changes. Never repoint the legacy CLI project or overwrite its `.env.local` as a shortcut.

### Material corrections to the supplied plan

| Original assumption/design | Replacement decision |
|---|---|
| 450 games/user; largest around 4,700 | Measured mean 563; largest 8,353. Test 10,000-game accounts and 50,000 users. |
| Promise 35–45 KB/user | Measure heap, indexes, sparse facts, bloat, WAL and workload separately; use a range until rehearsal proves it. |
| Merge `user_games` and `user_game_state` | `user_games` is current authority; the sparse copy is stale. Never revive an undone completion from the old copy. |
| Delete ownership and keep only sparse recency | Archive the last known personal playtime on removal, even without recency evidence. |
| A successful fetch can reconcile ownership | Only a complete, validated, current-generation snapshot can remove access. |
| A random finalist winner is a user choice | Record machine selection, displayed impression and explicit response separately. |
| One current price per game | Region, currency and offer scoped observations; unknown is distinct from free. |
| Ordinal arrays plus discard old schema | Start with stable Steam achievement API names; schema updates cannot reinterpret unlocks. |
| Signed 32-bit Unix unlock timestamps | Use 64-bit epoch values or `timestamptz`; preserve unknown timestamps. |
| Enable vectors and choose 384 dimensions now | First ship structured content retrieval. Select model/dimension/index only after quality and cost evaluation. |
| RLS is a generic safety net | Define the custom-session principal, non-owner runtime role, transaction scope and actual tenant policies. |
| Time-relative partial index using `now()` | Invalid in PostgreSQL; use ordinary time indexes or immutable status predicates. |
| `pg_stat_statements` supplies p95 | It supplies aggregate statement statistics; instrument latency histograms separately. |
| Switching to old DB/build always rolls back | Safe only before v2 production writes. Afterwards roll forward or perform tested reverse replay. |

## 2. Verified baseline and uncertainty

Read-only aggregates on 5 September 2026:

| Measure | Observed |
|---|---:|
| Database size | 234,163,347 bytes, about 223.3 MiB |
| Accounts | 630: 432 Steam, 198 manual account records |
| Actual manual profile records | 196; reconcile the two-account discrepancy before migration |
| Accounts with library rows | 585 |
| All user-game rows | 329,191 |
| Owned personal rows | 327,927 |
| Family rows | 1,262 |
| Retired rows currently marked Wishlist | 2 |
| Mean / median games per populated library | 562.72 / 313 |
| p95 / p99 / maximum games | 2,032.8 / 4,558.72 / 8,353 |
| Shared catalogue | 26,040 |
| Tags / genres / categories populated | 24,018 / 23,768 / 23,252 |
| Description / ready duration populated | 25,119 / 18,668 |
| Price / Deck / Linux observations populated | 20,847 / 25,263 / 25,246 |
| Completed / Slept | 11,876 / 4,104 |
| Nonempty notes | 0; keep the supported feature |
| Missing exact observed minutes | 1,262, corresponding to family rows |

Physical relation measurements at a nearby snapshot: `user_games` 106,274,816 bytes, including 46,710,784 index bytes; `catalog_games` 49,979,392 bytes; duration evidence 16,990,208 bytes. Table-statistics row counts are estimates; exact counts above came from aggregates. Writes continued on production during review, so do not treat separate queries as a transactionally consistent export.

`user_game_state` contains 24,428 rows but differs from current `user_games` in completion state and hundreds of activity observations. It was a staging/backfill experiment, not a synchronized replacement. The production database includes Family Sharing and schema changes absent from parts of the local migration history. Source code, deployed behavior and live definitions must all be reconciled.

Unknowns to measure: real DAU and peak concurrency, audience geography, current paid-tier limits, exact query p95/p99, update churn, cache hit rate, and recommendation outcome quality. Do not substitute registered-user count for traffic. The US target already exists; co-locate compute there, but do not claim the audience is predominantly US without evidence.

## 3. Product contract inventory

VaultShuffle is a personal backlog decision tool with guest preview, public Steam profile imports, verified Steam login, promotion/merge, library refresh, status/progress, sleep/restore, completion suggestions/history, three ordered pins, snoozes, current pick, custom/smart collections, inferred Family Sharing shelves, dashboard trends, guest discovery and a guided recommender.

These behaviors are acceptance requirements:

- Public-profile accounts are browser-controlled workspaces, not proof that the visitor owns that Steam identity. Multiple unverified workspaces can use the same public Steam ID. Only verified Steam identity is unique.
- Preserve `vault_session`, the `manual.` token prefix, HMAC algorithm and `SESSION_SECRET`, cookie host/path/security attributes and expiry behavior during migration. Keep existing account UUIDs as public IDs. A database failure is a 503/retriable failure, not forced logout or guest conversion.
- Promotion requires current manual session, matching single-use intent, validated Steam OpenID and nonce checks. A normal login and a promotion both lock the same verified Steam identity before creating/merging it.
- Personal ownership wins over family access. Never assign the lender's hours or achievements to the current account. Family presence is inferred from public profiles and metadata, not a guaranteed Steam family entitlement or available license seat.
- Completed is an explicit user assertion, not inferred from playtime or achievements. Preserve sleep/restore, prior active state where still needed, completion dismissals and their playtime baselines, undone completion events, pin times/baselines and scoped pin ordering.
- A lifetime-playtime increase establishes an interval between observations, not an exact session or day played. Exact Steam timestamps and inferred intervals remain distinguishable.
- Custom collections retain ordering, notes and unavailable members; unavailable entries can be shown with an access label but are excluded from playable counts. Smart rules operate on current accessible games using the same global filter semantics as the Library and dashboard.
- User actions/history survive losing ownership or a lender. Inaccessible games cannot remain the active playable pick; their historical pick/event remains.
- Guest preview stays inexpensive, works with a bundled fallback, and keeps guest mutations ephemeral.
- Daily aggregate playtime history cannot be reconstructed from today's library; preserve it. Current shelf value is a price estimate, not actual purchase spend. Exclude family games and report price coverage; never sum mixed currencies.

Evidence anchors: `lib/auth.ts`; `lib/manual-profile-security.ts`; `lib/steam-import-jobs.ts`; `lib/steam-owned-games.ts`; `lib/family-sharing.ts`; `lib/family-members.ts`; `lib/pinned-playtime.ts`; `lib/completion-check.ts`; `lib/completion-events.ts`; `lib/playtime-snapshots.ts`; `lib/backlog-stats.ts`; `lib/global-filters.ts`. Current `/purge` redirects to the slept Library tab; keep the redirect, not a new purge subsystem.

## 4. Runtime and trust boundaries

```text
Browser ── public assets/guest data ── Vercel CDN
   │
   └── private API / server rendering ── Next.js Node runtime, iad1
                                             │
                                    server-only data access
                                             │
                                  Supavisor transaction pooler
                                             │
                                   Supabase PG17, us-east-1
                                    │                  │
                              durable jobs       shared feature data
                                    │
                          bounded provider workers
                                    │
                          Steam / IGDB / other providers
```

The app already has a BFF; retain it and improve its contracts. Use `postgres.js` with parameterized SQL, `prepare: false` for Supavisor transaction pooling and a small bounded connection pool per process (start at 3–5; tune with measured concurrency). Use TLS certificate verification. Do not query as `postgres` or a service-role superuser from ordinary requests. Use session/direct connections for migrations and consistent exports. Transaction pooling is intended for transient clients; session settings, session advisory locks and prepared statements must not be assumed to persist. [Connection modes](https://supabase.com/docs/guides/database/connecting-to-postgres).

Use `import 'server-only'` at runtime repository boundaries. Server Components call the same data access layer directly; do not call the app's HTTP API from itself to access the database. Route handlers validate input and delegate. Read installed `node_modules/next/dist/docs/` before implementing framework changes. This installed Next version deprecates route-level `preferredRegion`; set Vercel project/`vercel.json` regions and verify deployment placement instead. [Vercel configuration](https://vercel.com/docs/project-configuration).

### Authorization design

Create private schemas `app`, `catalog`, `reco`, `ops`, and `migration`. Keep v2 domain tables outside exposed Data API schemas. Disable unnecessary exposure rather than granting browser table access. New Supabase defaults are changing; migrations explicitly revoke `PUBLIC`, `anon`, and `authenticated` access instead of assuming defaults. [Securing Data API](https://supabase.com/docs/guides/api/securing-your-api).

Use NOLOGIN group roles `vault_app` and `vault_worker`, neither owner nor BYPASSRLS; provision separate login credentials outside migrations. A narrowly scoped private `SECURITY DEFINER` session-resolution function checks a server-produced token digest and expiry, returns the minimum principal, has a fixed/empty search path with qualified references, and is executable only by the runtime group. Custom Steam sessions do not provide `auth.uid()`; do not pretend they do.

Each user repository operation runs in a transaction that sets the verified account using `set_config('app.account_id', ..., true)`. RLS uses this transaction-local principal in both `USING` and `WITH CHECK`. Missing context fails closed. Never take the account ID from an HTTP body as the principal. Context-setting is trusted server code, a defense against accidental missing tenant predicates, not a defense against arbitrary SQL execution by a compromised runtime. Test pooled connection reuse and failed transactions for cross-account leakage.

Keep explicit account predicates too. Compound foreign keys ensure a collection, family member, event or pin cannot reference another tenant's parent. Worker grants cover only necessary functions/tables, not sessions or blanket user-data access. Public catalogue reads may bypass tenant predicates but not write authorization. Rate-limit abuse-prone lookups, imports and draw writes globally and by session/account. Validate Origin for cookie-authenticated mutations; retain explicit OpenID state/replay checks. Credentials and raw session hashes never enter logs, client DTOs or migration files.

## 5. Relational data model

These are logical contracts; migration SQL is the executable schema. Use readable text/check constraints for small configuration/state tables; smallint codes only where a stable mapping has a useful storage/query benefit. Use integer account and game internal keys, bigint for high-volume event identities, UUID public IDs for externally addressed entities. SteamID64 is a decimal string in JavaScript/JSON and bigint in PostgreSQL. Steam AppID is bigint in storage with provider-range validation, never truncated to signed int32. Canonical game IDs do not imply access.

### 5.1 Accounts and sessions

| Relation | Required shape/invariants |
|---|---|
| `app.accounts` | int identity PK; UUID `public_id` unique (existing UUID on migration); account kind; created/last-seen times; library/state revisions; optional locale/store country/currency; lifecycle status |
| `app.steam_profiles` | account PK/FK; SteamID64; verified flag; display/Steam names and avatar/profile URLs; partial unique SteamID for verified rows |
| `app.sessions` | bigint PK; account FK; unique 32-byte HMAC digest; session kind, created/last-seen/expiry/revocation; indexed expiry and account lookup; no raw token |
| `app.account_capabilities` | account PK; separate library/playtime/last-played visibility and checked-at/status; unknown distinct from hidden |
| `app.account_preferences` | account PK; versioned bounded JSON for durable global filters/preferences; import browser-local values once with explicit conflict precedence |
| `ops.auth_intents`, `ops.account_merges` | expiring single-use promotion/nonce state and a minimal merge audit; restrict sensitive access |

Throttle last-seen writes (currently hourly); do not update on every request. Keep Steam verification and workspace ownership separate. Preserve merged-account aliases long enough for cookies, cached URLs and event references to resolve; never transfer unverified access into privileged proof.

### 5.2 Compact active library and retained facts

```sql
create table app.library_games (
  account_id integer not null references app.accounts(id) on delete cascade,
  game_id integer not null references catalog.games(id),
  playtime_minutes integer check (playtime_minutes >= 0),
  primary key (account_id, game_id)
);
```

`NULL` means unknown; zero means explicitly observed zero. Preserve exact minutes. Do not add per-row UUID, repeated status/ownership strings, generated percentage, catalogue metadata or import timestamps. One account-level library-sync record gives snapshot provenance/freshness for the bulk import; sparse activity observations handle subsequent per-game updates.

The PK supports account-scoped scans. Do not add a reverse library index unless a measured query requires it; soft-retire catalogue identities so routine catalogue deletion does not force a huge unindexed FK scan. Account deletion uses the leading account key. Test how other child FKs are deleted and index the referencing columns where those paths actually run.

| Relation | Required shape/invariants |
|---|---|
| `app.game_state` | account/game PK; explicit completed/slept dates and restore metadata, nullable manual progress, notes, review requests, dismissal date/baseline; revision/update time; only meaningful state rows |
| `app.game_activity` | account/game PK; last valid observation and optional last-played timestamp; evidence source and interval start/end; no fabricated precise play session |
| `app.retired_library_games` | account/game PK; last known personal playtime and observation/access-loss provenance; created on removal, folded back on reacquisition; preserves evidence without widening active rows |
| `app.library_sync_state` | account PK; generation, in-flight job identity, authoritative snapshot time/hash, applied generation, counts and last result |
| `app.playtime_daily` | account/day PK; aggregate observed minutes, coverage/capabilities and recorded-at; preserve existing useful trend data |

Missing/hidden playtime never overwrites known minutes. A provider decrease is an anomalous observation, not automatic loss of earned progress: preserve the previous value pending a deliberate correction policy and expose stale provenance. Achievement resets use different semantics (section 10). Store unusual observation errors sparsely; do not add a quality document to every library row.

Completion and sleep transitions, pin clearing, current-pick clearing and their durable domain event commit atomically. A repeated request key does not create duplicate completions/events. Undo changes current state and marks/reverses the corresponding history without deleting evidence. A manually overridden percent is separate from derived percent. Current legacy `completion_percentage` is usually derived; do not migrate it as an authored override without provenance.

### 5.3 Family, collections and commitments

| Relation | Required shape/invariants |
|---|---|
| `app.family_members` | internal and UUID public IDs; account; unique account/SteamID; candidate AppID snapshot, counters, checked-at/error status; maximum five other members enforced under account lock |
| `app.family_game_access` | account/game/member PK; composite FK to member+account; inferred/checked-at provenance; no lender playtime; multiple lenders allowed |
| `app.collections` | internal ID, retained UUID public ID, account, custom/smart kind, name/description, versioned rules, timestamps/revision |
| `app.collection_games` | collection/game PK plus account for compound FK/RLS; position, note; no dependency on current ownership |
| `app.pins` | account/scope/slot PK; unique account/scope/game; slots 1–3 initially; pinned-at and nullable personal minute baseline |
| `app.snoozes` | account/game PK; nullable until time (null means indefinite); reason/source if needed; indexed expiration, never a `now()` partial predicate |
| `app.vault_state` | account PK; canonical current game, current draw reference, revision; validate current access when serving/actioning |
| `app.completion_events` | account, game, occurred-at, undone-at and source/dedupe key; preserves existing product history |

Do not erase pin scope from the schema merely because all 52 current pins use the library scope. Family removal deletes only that member's access; another lender or owned access keeps a game playable. Verify shared eligibility asynchronously, show unknown as pending, and label inferred access honestly.

### 5.4 Catalogue, evidence and discovery

| Relation | Required shape/invariants |
|---|---|
| `catalog.games` | int PK; unique nullable Steam AppID; stable title/normalized sort title; type, lifecycle/release metadata; provider-independent identity permits another storefront later |
| `catalog.game_metadata` | game PK; display text/art URLs, raw genres/categories/weighted tags, attribution and provider fetched-at; escape all untrusted text |
| `catalog.game_features` | game PK; versioned filter/ranking features, tri-state platform/Deck/family compatibility, duration outputs/confidence, review/popularity features; no universal price |
| `catalog.duration_estimates` | game/provider identity; provider timestamps, match evidence and uncertainty; manual decisions and competing estimates preserved |
| `catalog.review_decisions` | sparse quarantine/approval/duration override decisions and reason/provenance; automated refresh cannot overwrite a human decision |
| `catalog.provider_state` | game/provider PK; success freshness, retry-after, terminal rejection/unsupported status and rule/version; persists independently from disposable queues |
| `catalog.offers` | offer/provider identity, game/product/package mapping; do not model packages or bundles as a game ID |
| `catalog.offer_prices` | offer/country/currency PK; observed availability, initial/final amount in documented currency minor units, discount, fetched-at/expiry, source; unknown fields nullable |

Keep raw provider facts distinct from derived features and manual overrides. An empty/missing field does not erase verified prior evidence unless provider semantics explicitly mean removal. Cold provider snapshots can go to private object storage with TTL when needed; do not retain every HTTP body forever.

Preserve the existing enriched corpus and duration research. Add a minimal discovery index through supported Steam app-list updates, then enrich on demand/popularity/coverage gaps. Keep non-games, unsupported and rejected identities as lightweight classifications to avoid repeatedly rediscovering them. Do not require rich enrichment of all Steam apps before launch. Current `cc=US` prices migrate as US observations, never inferred GB/EU prices.

Use an ordinary normalized-title sort index for stable pagination and `pg_trgm` for search once used. Keep weighted tags as bounded provider JSON and derive frequently used facets; no EAV model for all metadata and no giant bitmap whose semantics cannot evolve. Catalogue feature changes publish a new revision and invalidate derived counts/models predictably.

## 6. Import and observation protocol

This is a correctness boundary, not just a bulk upsert optimization.

1. Authenticate/authorize, validate Steam identity, atomically reserve provider budget and obtain a per-account generation/lease. Coalesce duplicate refresh requests and return the existing job/status.
2. Fetch outside any database transaction with timeout and a bounded body. Request the complete owned-game scope, not a filtered subset.
3. Normalize exactly: valid distinct AppIDs, exact nonnegative integer minutes or null, valid names or explicit catalogue-stub fallback. Validate provider success, `game_count` and parsed record count. Never drop a malformed row and call the remainder complete.
4. Produce a typed result: `complete`, `unavailable`, or `invalid`. A complete result may contain zero games only if the provider explicitly confirms zero and has no contradictory payload. `{response:{}}`, authentication/HTTP errors and private/malformed responses cannot delete ownership.
5. Enter one bounded transaction; lock the account sync row, check generation/lease still current and idempotency key. No network calls inside this transaction.
6. Ensure minimal catalogue identities; bulk upsert changed personal minutes only (`IS DISTINCT FROM`); preserve known values for missing fields; record valid new activity evidence. Recheck pinned refresh observations so an older full snapshot cannot undo a newer personal observation.
7. Archive removed personal-game measurements, then delete only missing owned access. Leave authored state, collection memberships and history; invalidate unavailable active commitments. Family access is a separate relation and is never swept by owned sync.
8. Update snapshot/generation/count/revision and enqueue deduplicated shared enrichment in the same transaction. Commit, then return a summary. A client retry gets the same committed result.
9. Clear successful temporary import data promptly. For oversized snapshots, use TTL staging/object storage, validate the complete snapshot then atomically publish; never reconcile at the end of each partial chunk.

Start with JSONB recordsets for clarity and 10,000-game limits; benchmark arrays and `COPY` only when this misses targets. The internal canonical relation remains relational whichever transport wins. Import latency does not wait for tags, descriptions, durations, achievements or embeddings.

Fixture requirements: exact zero versus missing; genuinely empty versus private; count mismatch; duplicate/invalid records; >1,000 and 10,000 games; competing generations; crash after provider fetch; retry after commit/response loss; two workers finishing out of order; pinned refresh during import; retirement and reacquisition; unknown catalogue app; provider decrease; family-only game.

## 7. Jobs, budgets and operational state

Use PGMQ for durable transport and small `ops.jobs` records for coalescing, status, scheduling and attempt metadata. Queue messages contain job IDs and bounded references, not full libraries. Begin with interactive and background lanes; route job kinds within them. Separate lanes for achievements/prices are added when priority/worker budgets differ materially, not seven empty consumers on day one.

PGMQ's visibility window is not an exactly-once business transaction or strict global completion order. Consumers may receive a job again after crash/timeout. Claim briefly, fetch outside transaction, and commit data + applied-job marker + message acknowledgement together when possible. A generation/lease token fences stale consumers. Unique active semantic job keys coalesce shared `(provider, game, revision)` and personal `(account, game, refresh bucket)` requests. Renew visibility for valid long work; stale workers cannot ack newer work. [Queues](https://supabase.com/docs/guides/queues), [PGMQ API](https://supabase.com/docs/guides/queues/pgmq).

Use exponential backoff with jitter, provider `Retry-After`, capped attempts, bounded errors, terminal failures and replayable dead letters. Delete successful transport messages; retain provider terminal/retry state separately so cleanup cannot cause infinite refetch. Retries reserve quota too. A scheduler fills due jobs and cleanup work; it does not perform full catalogue scans inside an HTTP request.

Steam's published Web API terms allow 100,000 calls/day absent additional permission. It is a ceiling, not promised throughput or an allocation to spend fully. Reserve quota for every endpoint using the credential, including sign-in/profile/library requests; all deployed versions sharing a key share the budget. Begin with an 80,000/day internal cap, at most 50,000 background calls and the rest protected for interactive work; add a per-minute token bucket and adapt to 429/5xx. Preview uses fixtures by default so it cannot drain production quota. Do not assume undocumented Store endpoints share the same guarantees or rate limits. [Steam API terms](https://steamcommunity.com/dev/apiterms).

Example planning load at 10,000 DAU: 2 Web API calls per daily active user = 20,000/day; refreshing two selected achievement games each = another 20,000/day. At 50,000 DAU the same pattern exceeds the ceiling. Cache profile lookups, reduce refresh frequency, cap tracked hunts and degrade freshness rather than breaking sign-in. Budget by DAU, per-user cadence and changed games, never by eager registered-library scans.

Use short I/O-heavy Supabase Edge Functions close to the database (verify/pin region), or the existing Node worker runtime if operationally simpler. Edge limits currently include 256 MB memory and 2 seconds CPU/request, despite longer wall-clock windows; train models and generate large batches offline. Durable queues provide recovery; `after()`/background continuations alone do not. [Edge limits](https://supabase.com/docs/guides/functions/limits).

## 8. Page data and cache contracts

`/api/app-data` currently loads all joined games and many dependent tables; `AppDataProvider` supplies virtually every product screen. Adding a cursor to `/api/games` alone would break consumers. Replace their contracts together:

| Contract | Contents and behavior |
|---|---|
| Bootstrap | session-safe account DTO, revision tokens, small counts/settings, three pins and current pick; no full library or full preference corpus |
| Dashboard | scoped aggregates, trend summary, bounded highlights/completion suggestions; aggregate across the full eligible library, not a page |
| Library | page size default 50, maximum 100; sort/filter/search/access scope; cards only; next cursor, total/facet metadata and revision |
| Game detail | expanded metadata, personal facts/uncertainty, access sources, notes/history on demand |
| Collections | metadata/counts separately; custom and smart members paginated, order preserved; >1,000 membership fixture |
| Vault draw | validated explicit controls/collection, server-side candidate selection, draw ID, bounded deck/pick/reasons, policy version |
| Family | roster, inferred access state and sync progress; member removal preserves other access |
| Mutations | request idempotency key + expected revision, atomic effect, changed DTOs/revisions; stale conflicts return 409 and refresh |
| Achievements / Buy | independent opt-in queries with visible freshness/coverage; no work added to every app visit |

Use keyset cursors with a stable tie-breaker game ID and explicit null ordering. Cursor includes version, sort, filter hash and library/feature revision; reject mismatched/stale cursors with a restart response. Dynamic filter/sort fields are allowlisted SQL fragments, never raw user SQL. Smart rules have a versioned validated AST, bounded depth/size and a shared predicate definition. Cross-check SQL filters/counts against pure TypeScript fixtures to avoid two conflicting status algorithms.

Read narrow facts and shared features for all of one user's candidates on the server when scoring requires it. A few thousand compact rows server-side is acceptable; fetching them all repeatedly into the browser is the cost to remove. Load only display metadata for the returned page/deck. Do not silently cap the eligible library to the first 1,000 rows or a popularity-only subset.

Use TanStack Query or equivalent only after defining query keys: account public ID, endpoint, validated scope/filter hash, page cursor and revisions. Clear private cache on logout/account merge; abort or ignore stale responses; retain usable data on transient failure. Authenticated HTTP responses are private/no-store. Never shared-cache personalized responses. Cache public guest/catalogue DTOs by catalogue version/locale; on-demand details have explicit freshness. Make counts lazy if they are expensive, without showing page counts as totals.

## 9. Recommendation foundation and What to Buy

Preserve the current rule: explicit Session/Mood/Goal, global filters and access eligibility constrain the candidate set before learned taste reweights fit. Source code currently uses up to 64 deck entries and 10 finalists plus configurable `algorithm_weights`; migrate the versioned configuration and explanation behavior, not stale descriptions in older docs.

### Facts and semantics

Use an idempotent `reco.events` ledger for meaningful product facts, separate from PostHog. Store account/game, source event key, event kind, objective/context, occurrence time, source/confidence and schema version. Store bounded `reco.serves` with request/draw ID, candidate generator and ranker versions, actual sampled candidate IDs, seed/RNG policy and true serving probabilities where measurable. Record the displayed impression and subsequent action against that serve. Historical unknown probabilities remain null; do not fabricate them.

Machine-selected finalists were not a user choice set. Nonselected games are not negatives, and a random draw is not a positive preference. A Steam/store link click is intent, not proof of a launch or purchase. Ownership and never-played games are missing preference evidence. Completion/pin/like are stronger signals; sleep and reroll need reasons (time constraint versus dislike). Retain raw semantics; model weights belong to versioned models. State mutations and their events commit together; analytics delivery can be asynchronous and consent-aware.

Keep a shared feature/profile foundation with separate objective heads for play, hunt and buy. Avoid learning one objective's undesirable shortcut into all products. Bound each user's contribution to population priors, downweight unreliable/imported evidence, and do not count duplicated manual workspaces as independent verified users. No sensitive-profile inference is necessary.

### Initial retrieval and ranking

1. Build deterministic sparse content profiles from genres and weighted tags (normalized/IDF-weighted), credible durations and explicit preferences. Blend recency-decayed, log-capped personal playtime with stronger completion/like evidence; ownership alone has zero preference weight.
2. Generate candidates from several positive seed games, aggregate taste, a quality/popularity prior and a deliberate exploration slice. Cap similar franchises/near-duplicate editions and diversify across interests.
3. Enforce access/type/platform/explicit-hide constraints. For buying, exclude owned games and label or usually exclude inferred family access. With stale/private ownership data, state the limitation and do not promise that every suggestion is definitely unowned.
4. Rerank a bounded set (initially 100–300) using taste/quality/context/freshness, then diversify. Unknown platform or regional availability cannot satisfy a strict required-platform or purchasable-now constraint.
5. Explain using verified shared tags and actual positive seeds. No per-request LLM is required. Say “similar to games you played” only when that observation exists; never claim purchase attribution from an external click.

Buying uses country/currency/offer scoped observations with freshness. Separate free discovery from paid offers where helpful. Preserve unavailable/delisted/coming-soon/unknown states. A stale or unsupported price yields a clearly labelled store link, not an invented current deal. Historical regular US shelf values must not become actual user spend. Providers for Store data/price coverage are a dependency to validate; do not require user Steam cookies or promise official price endpoints that do not exist.

### Models deferred behind evidence

Embeddings are optional, not a prerequisite for What to Buy. Compare structured baseline against a selected text embedding model on an explicit evaluation set. Store model ID/revision, feature-text hash, dimension, normalization and generated-at; rebuild into a new version then atomically publish. Never mix dimensions or profile versions. Select exact search versus HNSW using recall/latency/memory measurements. For filtered approximate retrieval, test overfetch/iterative scans so ownership filters do not empty the result. pgvector documents exact search, approximate indexes, filtering and iterative scans. [pgvector](https://github.com/pgvector/pgvector).

Collaborative models are a later offline experiment, justified by reliable behavioral coverage and an improvement over the baseline, not a registered-user threshold. Use temporal splits, per-user leakage controls and coverage/diversity/popularity-bias metrics. Track NDCG/Recall@K where labels support them, and online explicit usefulness, qualified follow-through, reroll reasons and latency. Do not optimize raw clicks at the expense of user intent. Preserve a deterministic baseline and a model rollback pointer.

## 10. Achievement hunting

Steam player achievement queries are per player/app. Shared schema and global rarity have separate APIs. Eagerly fetching hundreds of played games for each of tens of thousands of users would exhaust quota; this feature must be opt-in and lazy. [ISteamUserStats](https://partner.steamgames.com/doc/webapi/ISteamUserStats).

Start with these boundaries:

| Relation | Shape |
|---|---|
| `catalog.achievement_schemas` | game/locale PK; schema identity revision/hash, definitions keyed by stable API name, active count, fetched-at/provider status; locale/display edits do not redefine identity |
| `catalog.achievement_rarity` | game PK; bounded API-name-to-global-percent document, observed-at; shared cache |
| `app.achievement_progress` | account/game PK; schema revision, provider status, last-good sync time, last attempt, typed counts and a bounded API-name-to-unlock document |
| `app.achievement_hunts` | account/game PK; selected target/preferences, priority and lifecycle; cap active automatically refreshed hunts |

Use a JSONB object keyed by immutable provider API name initially. Each unlocked entry records 64-bit epoch time or null if Steam reports unknown/zero. Validate duplicates, total limits and schema references. This avoids a row per user-achievement and the original plan's unsafe ordinal remapping. Benchmark JSONB against stable append-only integer ordinals/bitmaps using real large schemas before changing encoding. If ordinals are later used, never reuse them, and retain mappings referenced by snapshots.

Treat private, unsupported, no-achievements, partial/error and valid zero-unlocked separately. Do not replace last-good progress on an error. A validated later snapshot may relock/reset achievements; do not max-merge unlock counts forever. Added/removed/renamed definitions require API-name reconciliation; preserve unknown old names as historical evidence until resolved, and recalculate current totals. Game completion, achievement completion and completed hunt are distinct states.

Default refresh policy: user opens a game; active hunt; recent relevant playtime change; then shared stale schema/rarity as budget allows. Start at three automatically refreshed hunts/account, one coalesced progress refresh per tracked game per day unless explicitly requested and budget permits. Show last checked time. No automatic full-library backfill on login.

First product views: selected hunts, known nearly complete games, recently progressed games and remaining achievement list. “Nearly complete” means observed proportion/count, not inferred ease. Global rarity does not prove difficulty, hours remaining or whether an achievement is still obtainable. Hidden achievements need spoiler controls. Steam data does not reliably supply missable/multiplayer/server-shutdown/DLC prerequisites; add separately sourced, reviewed hunt metadata only if that feature is actually built. Never invent completion-time promises from rarity.

## 11. Capacity, indexing and benchmarks

Use 563 average active personal games as a conservative planning approximation, plus measured long-tail accounts. Initial ownership-only storage envelope of 70–120 bytes/row (heap + one index + headroom) is provisional, not a measured result.

| Imported users | Library rows | Provisional ownership storage |
|---:|---:|---:|
| 1,000 | 563,000 | 39–68 MB |
| 10,000 | 5,630,000 | 394–676 MB |
| 50,000 | 28,150,000 | 1.97–3.38 GB |
| 100,000 stress case | 56,300,000 | 3.94–6.76 GB |

These decimal estimates exclude sparse user state, shared catalogue, sessions, achievements, signals, queue churn, indexes on those tables, backups/WAL and free disk reserve. A paid production plan and backup/restore capability should be expected; verify actual platform pricing and limits at deployment. Do not contort the model to fit a free storage cap.

For each rehearsal record `pg_relation_size`, `pg_indexes_size`, `pg_total_relation_size`, query plans/buffers, WAL generated, update ratios, dead tuples/autovacuum, pool wait and app response bytes. Run changed and unchanged imports; an unchanged library should cause almost no per-game rewrites. Use deterministic synthetic data with a skewed shared catalogue and sparse decisions; uniform fake libraries alone hide contention and skew.

Benchmark a disposable target at 1k, 10k and 50k accounts; never run load generation on production. Profiles: 50, 563, 2,000, 5,000 and 10,000 games. Ramp mixed read traffic through 10/50/100 requests/s as stress probes (not forecasts), include imports, draw requests and workers concurrently, and measure p50/p95/p99 and errors. Record compute tier and warm/cold conditions. Do not proclaim 50k readiness after a 500k-row storage test.

| Initial objective, measured in same-region preview | p95 target |
|---|---:|
| Session SQL | 25 ms |
| First-page Library SQL | 100 ms |
| Dashboard scoped aggregate SQL | 150 ms |
| Vault candidate load + scoring | 250 ms |
| Private API response excluding third-party wait | 500 ms |
| 563-game sync database transaction | 1 second |
| 10,000-game sync database transaction | 5 seconds |
| Queue claim SQL | 50 ms |
| Bootstrap compressed payload | <= 25 KB; independent of library size |

Targets may change with measured product constraints; failure requires diagnosis or a revised accepted target, not omission. Instrument application histograms because `pg_stat_statements` reports counts/mean/min/max/variance, not percentile samples. [Statement statistics](https://www.postgresql.org/docs/17/pgstatstatements.html).

Do not partition core ownership at launch. Consider time partitions for large retained events once deletion/vacuum becomes costly; include partition key implications for unique idempotency keys. Use BRIN only for suitable time-correlated scans; account history still needs account/time indexing. A predicate containing `now()` is invalid for an index; index expiration values and compare at query time. [Index requirements](https://www.postgresql.org/docs/17/sql-createindex.html).

Upgrade on sustained pool waits, CPU/IO pressure, slow p95, insufficient cache, replication/backup stress or storage approaching 70% of allowance—not just account count. Add replicas, external cache or dedicated workers only when a measured bottleneck justifies them. Redis does not fix a full-library bootstrap or missing tenant index. Arrays remain reasonable for bounded event lists and provider snapshots, not canonical ownership: their whole-document rewrite and join/integrity costs work against the new paginated and concurrent access pattern.

## 12. Extensions and services

| Decision | Capability |
|---|---|
| Keep | `pg_stat_statements` |
| Enable as used in first delivery | `pg_trgm`, `pgmq`; `pg_cron` when scheduling is wired |
| Development validation | `pgtap`; `hypopg`/`index_advisor` only for a specific query investigation |
| Add when measured model warrants it | `vector` (target currently offers 0.8.2) |
| Add only for selected worker invocation | `pg_net` and Vault-backed HTTP credentials |
| Defer | Realtime for ordinary data refresh, Redis, GraphQL, FDWs, sharding, partition manager, separate vector database, full-text search service, `pg_repack` client dependency |

Target availability verified: PGMQ 1.5.1, pg_cron 1.6.4, pg_trgm 1.6, pgTAP 1.3.3, vector 0.8.2. Availability is not installation or a reason to enable every extension. Read current changelog before deploying: Data API exposure defaults and client-runtime support have changed; no v2 objects belong in platform-owned `auth`, `storage` or `realtime` schemas. [Supabase changelog](https://supabase.com/changelog).

## 13. Retention, privacy and recovery

| Data | Initial policy |
|---|---|
| Account/authored state/retired personal facts | retained while account exists; account deletion removes private derivatives too |
| Expired/revoked sessions | purge within 7 days; validation rejects immediately |
| Promotion/nonce intents | short expiry, purge within 24 hours; consumed state cannot be replayed |
| Successful import payload | delete after commit; failed staging TTL 24 hours unless explicitly quarantined |
| Successful job messages | delete after acknowledgement; job summaries 14 days |
| Failure/dead-letter detail | 30 days, bounded payload; terminal provider state retained separately |
| UI history | latest 100 draws / 90 days, separate from product completion history |
| Recommender raw semantic events | 180 days initially; stable authored facts retained; decayed aggregate profiles with deletion/rebuild support |
| Shared catalogue evidence/manual decisions | current useful evidence retained; bounded revisions; obsolete raw payload TTL |
| Achievement details | tracked/user-requested last-good state; cold raw payloads deleted when no longer useful; no full-library polling |
| Regional offers | current observations; obsolete snapshots purged, no perpetual price history |
| Migration staging/exports | encrypted/private; purge within 30 days of validated cutover unless recovery incident requires retention |

Cleanup is bounded and indexed; no huge blocking delete transaction. Do not run `VACUUM FULL` against live hot tables as routine maintenance. Account deletion/export covers sessions, family links, retained facts, events, profiles, cached responses and object storage. Rebuild or remove contributions to learned aggregates; pseudonymous event rows with an account key are still personal data. Keep PostHog consent and retention separate; do not duplicate every analytics event into PostgreSQL.

Before production activation update the existing data/privacy disclosures for achievement data, recommendations, retention and US storage. Steam terms explicitly address disclosure of stored Steam data and storage country; use the actual configured processors/regions, not boilerplate. Configure and test database backup restoration and a private export recovery path. Backups of database rows do not automatically constitute an object-storage backup plan. Track recovery point/time objectives (initially daily backup RPO <=24h; target <=1h restore rehearsal, improve with actual paid backup/PITR capabilities).

## 14. Exact migration approach

### 14.1 Reproducibility and source export

Create an independent v2 Supabase work directory. Do not replay the legacy chain on a blank project: initial objects and remote-only changes are missing, and three import/rate migrations are explicitly ignored in `.gitignore`. Export schema definitions, constraints, views, functions, triggers, grants and migration ledger from production read-only as an audit snapshot; create v2 from its own complete migration chain.

Use a read-only repeatable-read source transaction and a snapshot-consistent export for final/rehearsal relational data. Prefer direct/session connection and `pg_dump`/COPY with explicit schema/table manifest, or a streaming read-only exporter using one snapshot. Paginating HTTP calls while production changes is a useful exploratory copy, not a consistent migration proof. Never paste hundreds of thousands of user records or session hashes into chat/tool output. Export privately with restricted permissions and checksums; stream to target staging.

Mapping tables under `migration`: old account UUID -> new integer; AppID -> game ID; old user-game UUID -> account/game; collection/family/event identities as needed; run metadata, source snapshot watermark, counts, hashes, conflict report and applied steps. Mappings must be deterministic/restartable and validated unique. New account `public_id` retains the old UUID. New collection public IDs also retain old UUIDs. Set identity sequences above imported maxima.

### 14.2 Table disposition manifest

| Legacy source | Destination / rule |
|---|---|
| `app_accounts`, `app_users`, `manual_steam_profiles` | account/profile/capabilities; reconcile missing profiles and merge tombstones, do not silently drop two manual account records |
| `sessions`, `manual_profile_sessions` | unified sessions; decode valid hex digest to 32-byte bytea; preserve kinds, expiry and cookie/HMAC compatibility; reconcile invalid/colliding digests privately |
| `user_games` | authoritative owned library, family access, sparse state/activity, retired facts; exact observed minutes preferred; Wishlist tombstones become retired measurements |
| `user_game_state` | audit/reconciliation only; do not coalesce stale values into current state |
| `user_family_members` | family member rows and candidate snapshots; retain owner mapping and all simultaneous lenders |
| `collections`, `collection_games` | retained public IDs, owner-scoped game mapping, ordering/notes; versioned rules with legacy preset parity |
| `user_game_pins`, `user_game_snoozes`, `user_vault_state` | preserve scope/slot/time/baseline/indefinite suppression/current pick; validate access and account |
| `completion_events` | preserve occurred and undone states and source event identity |
| `user_playtime_snapshots` | preserve daily aggregate observed history and coverage; cannot rebuild past from current rows |
| `vault_draws`, `vault_draw_events`, `vault_events` | serve/impression/action history, IDs and source provenance; legacy sampling probabilities unknown; preserve bounded finalist lists without inventing negatives |
| `user_genre_preferences`, `genre_preference_globals`, `game_preference_globals` | versioned frozen warm-start snapshot if raw-history retention is insufficient; rebuild new model separately and compare; never blindly discard sole remaining preference evidence |
| `algorithm_weights`, `app_settings` | versioned validated configuration and feature/worker budgets; separate secrets from ordinary settings |
| `catalog_games` | identity/metadata/features; known US price observations; preserve raw weighted tags and authoritative manual duration override |
| `game_duration_estimates`, `game_duration_aliases`, `catalog_duration_reviews`, `catalog_game_quarantine` | provider evidence, aliases, manual decisions, review provenance and resolver parity |
| `catalog_ingest_queue`, `game_duration_jobs`, catalogue tags retry columns | rebuild due work; extract terminal rejections/backoff state so failed identities are not retried forever |
| `catalog_game_sightings`, seed/import run records | keep useful aggregate/provenance, bounded historical archive where needed; do not recreate hot duplicate counters blindly |
| `guest_catalogue_pool` | rebuild deterministic guest read model and validate coverage/fallback |
| `purge_reviews` | archive only needed historical evidence / explicit semantic decisions; no active purge table required |
| `manual_profile_security_intents`, `account_merges` | retain minimal merge audit/aliases; expire pending intents at final maintenance and restart the flow cleanly |
| `steam_import_jobs`, `api_rate_limits`, `metadata_worker_runs` | do not resume in-flight production jobs on preview; carry required cooldown/quota constraints at cutover, retain bounded audit, restart work safely |
| `contact_messages`, `feedback_submissions` | preserve support records in a private domain, with source account mapping and retention |

Every additional source table/column in the actual export needs a disposition before final import. Historical API fields `priority`, `rating`, `date_added`, `previous_active_status` and `completion_percentage` require explicit inspection: some were already dropped or are inferred placeholders. Preserve nondefault authored facts if any exist; otherwise document retirement. Do not reconstruct nonexistent user intent.

M3 clarification, 10 September: preserve legacy `app_users.last_login_at` in nullable `app.accounts.last_login_at`, separately from `app.accounts.last_seen_at` sourced from `app_accounts.last_visited_at`. The current `lib/auth.ts` visit writer explicitly distinguishes visits on long-lived sessions from interactive login. Preserve each original instant and NULL without deriving one from the other or applying a regional offset; both remain covered by account export/deletion.

### 14.3 Rehearsal validation

M3 evidence clarification (9 September): the current legacy visibility writer
and reader use `app_accounts`; `app_users` retains older copied observations.
Use the account observation as a tuple and reconcile any newer/conflicting
profile evidence. Legacy false flags are availability heuristics (for example,
no positive hours), not proof of provider privacy: preserve the raw flags/time/
count with provenance and project false/NULL to unknown unless independent
privacy evidence exists. True can establish visible. Exact evidence, exception
checks and test obligations are recorded in
[the capability decision](v2-m3-capability-decision.md).

Produce a machine-readable report per run with source snapshot, target revision, code commit, transform version and timings. Check every intended account, not just global counts:

- sorted personal/family AppID sets, exact known minutes plus unknown count, retired facts, completion/sleep/undo/dismissal state, notes and activity source/intervals;
- collection ownership, public IDs, sorted membership/position/note hashes and smart-rule counts;
- exact pins/scope/slots/baselines, snoozes and current pick; no orphan or cross-tenant references;
- returning verified and manual sessions using private fixture tokens; preserve account identities without exposing hashes;
- catalogue feature/metadata/manual-decision and duration resolver parity; no stale staging override;
- daily trend and completion history, serve/action IDs and provenance; profiles rebuilt or intentionally warmed;
- 100% table/column manifest coverage, zero unexplained conflicts and zero dropped private records.

Run source/target transformed row checksums under a common null/time/number canonicalization. Counts and total hours alone cannot detect switched game identities. Keep an explicit exception report; an exception requires a documented resolution before promotion.

### 14.4 Merge policy for v2

Implement account merge as one locked, idempotent domain operation with a complete table manifest. Retain verified target identity. Reconcile explicit state deterministically (completed wins unless a later explicit undo supersedes it), preserve conflicting nonempty notes through an audit/merge note rather than dropping them, preserve source collections/public IDs, latest current pick, longest/indefinite snooze, and scoped pin ordering with a deterministic overflow policy. Merge family rosters under the cap without silently dropping references; archive overflow/conflicts for user resolution. Preserve measurement provenance, completion history, achievement targets/progress and recommendation event uniqueness. Revoke/rotate source credentials rather than granting an old unverified session verified powers by accident. Test rollback on any failed domain transfer.

## 15. Cutover and recovery runbook

Use a brief measured maintenance window; temporary cross-database dual writes add more failure modes than value at the current size. Rehearse the complete window and publish realistic timing before executing it.

1. Require all parity/security/load/restore gates. Pin old and new build IDs, schema revisions and environment mappings. Take/verify backups and export restore procedures.
2. Put the old app into global write maintenance, covering every mutation, login/session renewal, admin writer and cron/Edge/offline worker—not just library imports. Let old in-flight leases finish or expire; record the final watermark. Keep readable old data where possible.
3. Export the consistent final source snapshot, transform/apply, migrate active sessions, run all hashes/invariants. Do not regard an earlier rehearsal as final data.
4. Switch the isolated deployment configuration to v2 and run private smoke tests while writes remain closed. Verify the actual Vercel runtime region, cookie continuity, role identity and target project marker.
5. Before opening writes, rollback is safe: restore old build/config and reopen the old writer, since no accepted production v2 writes exist.
6. Record the instant v2 becomes authoritative and enable writes exactly once. Fence old writers/cron invocations so a delayed request cannot write to the old database.
7. After this point prefer roll-forward fixes or temporarily read-only v2. Switching back to the stale old database loses user activity and is forbidden as an automatic rollback. A later return to v1 requires freezing v2, exporting/replaying all accepted changes through a tested reverse mapper, and validating before reopening v1. That reverse mapper is optional; absent it, the declared policy is roll-forward recovery.
8. Keep the old database and source exports for the recovery window (minimum one stable release cycle), restrict access and track cost. Retire only after recovery/data retention requirements pass. Old write maintenance does not mean the old system is a current replica.

## 16. Execution sequence and ownership

The execution ledger records actual status and commands/results. This section defines completion gates; unchecked steps remain required. Do not deploy a half-switched application or add future UI work to bootstrap before its contracts exist.

| Milestone | Deliverables | Gate / dependency |
|---|---|---|
| M0: design and isolation | this portable plan, source audit, new Git branch, verified empty target, preserved dirty-file inventory | scope and authority explicit; no production mutation |
| M1: reproducible foundation | independent CLI config/migrations, account/catalogue/library/state relationships, grants/RLS, project marker, schema tests | empty-target apply and fresh rebuild; non-owner cross-tenant tests; no secret in SQL |
| M2: safe import | pure provider normalizer, fenced SQL snapshot publish, changed-only upserts, retired facts, queue/outbox and quota boundary | adversarial snapshot/retry/concurrency fixtures; measured 10k-game transaction |
| M3: preserved data | snapshot exporter, complete manifest/mappings/transforms, rehearsal copy, private conflict report, checksum validator | complete real-data parity and measured bytes/user; no source writes |
| M4: page/data access | runtime connection/session repository, small bootstrap, Library/detail/dashboard/collection APIs; provider/UI migration in slices | returning sessions, no full-library bootstrap, matching filtered counts, >1k membership QA |
| M5: product parity | auth promotion/merge, state/history/pins/snoozes/family/guest, server draw + durable semantic events | complete user journeys, optimistic/concurrent/failed requests, current ranking parity |
| M6: operational readiness | queue workers/scheduler, backpressure, source budgets, TTLs, telemetry, load harness, restore drill | 1k/10k/50k mixed-load evidence; active alerts and tested recovery |
| M7: production migration | measured final freeze/export/cutover, privacy/data disclosures, operator runbook | all M0–M6 gates pass; record authority switch; no silent fallback |
| F1: achievement pilot | shared schema, opt-in hunts/progress, lazy provider sync, freshness/spoiler UI | real provider fixtures, quota model, private/zero/reset/schema-change QA |
| F2: What to Buy pilot | structured retrieval, larger minimal corpus, regional offers, exclusions/explanations/diversity | coverage and quality evaluation; valid regional price/availability source |
| F3: optional models | embedding experiment then optional offline collaborative model | measurable gain, version/rollback/deletion paths, acceptable cost; not required for M7 |

Dependency order allows independent work, not conflicting edits: database agent owns migrations/RLS/SQL tests; import agent owns pure provider contracts and adversarial fixtures; migration agent owns export/transform/validation tools; coordinator owns plan, integration and review. Later split repositories/API, UI query migration and worker jobs once contracts are frozen. Use at most three bounded subagents and reuse them; do not launch a new agent for every file or model experiment. Agents do not deploy to production or edit another agent's owned files without coordination.

Validation commands include existing `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, targeted v2 unit/SQL tests and actual preview browser journeys. Migrations must replay on a clean PostgreSQL 17/Supabase database. SQL smoke calls do not prove all deferred PL/pgSQL branches are valid: execute meaningful fixtures that cover each branch, constraints, tenant policies, error rollback and retry behavior. Fixtures and benchmark generators are deterministic and never generate real provider calls by default.

## 17. Handoff prerequisites and evidence sources

The local environment at review contained only the existing Supabase URL and service-role key. It did not contain a v2 runtime database URL/password, `SESSION_SECRET`, Steam key, or a PostgreSQL dump client. Supabase management tools can apply and test schema on the isolated target, but they are not an application connection credential or a source-consistent bulk export. Provision required secrets privately through the deployment secret store; never paste them into this plan. Keep pure/database work moving while a credential-dependent milestone remains pending. Record the exact dependency in the execution ledger rather than quietly pointing at production.

Source code: `app/api/app-data/route.ts`; `components/app-shell/AppDataProvider.tsx`; `lib/games.ts`; `lib/collections.ts`; `lib/vault.ts`; `app/(product)/vault/page.tsx`; `lib/genre-preference-worker.ts`; `lib/steam.ts`; the product-contract modules listed above; all live schema aggregates described in section 2. Installed Next guides: `01-app/02-guides/data-security.md`, `01-app/01-getting-started/15-route-handlers.md`, `01-app/03-api-reference/03-file-conventions/02-route-segment-config/preferredRegion.md`.

Primary provider sources additionally used: [Steam owned games](https://partner.steamgames.com/doc/webapi/IPlayerService), [Steam store catalogue list](https://partner.steamgames.com/doc/webapi/IStoreService), [Steam authentication](https://partner.steamgames.com/doc/features/auth). Store scraping, pricing rights, achievement difficulty metadata and audience geography are not established by these sources; retain explicit uncertainty until verified.

The plan is ready to execute in order. Production readiness is a measured gate, not an assertion attached to this document.
