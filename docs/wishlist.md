# Wishlist

`/wishlist` replaces the owned-library Play Next page. It is accessed through
**Wishlist** in the primary navigation, and
`/play-next` redirects to it. The Vault remains the place to choose what to play.

## Data and behaviour

- `user_wishlist` is keyed by account ID and Steam AppID, with source and added
  time. It does not write to `user_games`, pins, blacklist, or `app_settings`.
  AppIDs need not exist in the catalogue, so upcoming games can be saved.
- Browser roles cannot access the table. The existing server session checks and
  account-scoped service-role queries authorize every read/write. Writes are
  rate-limited and use the app's same-origin API middleware.
- Guests save locally under `vault-wishlist-guest-v1`. Guest saves and account
  saves are separate; signing in does not automatically transfer guest saves.
- Steam search uses the live store search endpoint; known results are enriched
  from the shared catalogue. Visible cards fetch Steam descriptions and prices for the selected region; the next nine are prefetched. Shared prices expire after six hours (30 minutes for discounts), and final checkout prices remain on Steam. Adding to a
  connected account validates the AppID against Steam's game metadata.
- Import reads the connected profile's public `IWishlistService/GetWishlist`
  response. It atomically adds up to 10,000 AppIDs, preserves existing saves,
  and skips duplicates. It never removes entries or writes back to Steam.
  Private/unavailable responses show an error instead of clearing any saves.
- Account lists page metadata in groups of 24. Unavailable games remain visible
  as AppIDs, with a store link and removal action.
- Recommendations use a dedicated shared wishlist catalogue, independent of the 1,000-game guest preview,
  not the account library. They exclude saved games, owned/family games, and
  alternate editions of owned games. Taste primarily comes from completed games and games played for at least three hours. Log-scaled playtime strengthens the signal without letting a single endless game dominate. Wishlist seeds have a smaller weight, capped at one per batch. Blacklisted
  games are not taste seeds. Nine picks are displayed per page. A session-seeded deck prepares up to 720 unique candidates, diversifies source games/reasons and franchises in each batch, then randomizes positions. Refresh history is kept separately for each tab and country. New decks exclude all previously shown games until the eligible pool is exhausted; restarting a depleted pool still excludes the last displayed batch. With limited history, discoveries honestly fill missing personal signals.
- Short & sweet requires a known finite main-story estimate of ten hours or less.
  The Budget picks tab checks actual Steam prices in the selected region on demand,
  requires at least 500 reviews and an 84% positive rating, prefers the local
  equivalent of £10, and broadens to £20 only when there are fewer than nine
  strong low-price candidates. At most 288 recommendation candidates are checked
  per preparation, stopping after 72 eligible lower-band games; the shared price
  cache prevents repeat Steam requests. Free, unknown-price and expired-price
  games are excluded. Highly rated uses a review-count-weighted rating. Each
  mode limits repeated series. Search is not limited to the recommendation catalogue.

## On-demand store cache (23 September 2026)

### Store regions (30 September 2026)

The selector presents 41 pricing markets: Steam's 37 live currencies plus its
four distinct regional USD markets (Latin America, Middle East & North Africa,
South Asia and CIS). Europe shares one EUR entry; it is not a 249-country menu.
The definitions follow [Steam's currency and market documentation](https://partner.steamgames.com/doc/store/pricing/currencies?l=english).
Each market uses a representative country for the existing pricing API/cache.
Prices are indicative of that market; availability and final checkout still
depend on the user's own Steam store. The underlying 249-country allowlist
remains valid for the API and V2 store repository. Search accepts market names,
currencies and constituent country names, with keyboard access and internal scrolling.
The selected market is remembered in this browser under
`vault-wishlist-store-region-v1` and restored on refresh or a return visit.
Valid old country preferences map into the corresponding market (DE to Europe,
BD to South Asia); missing or invalid values use GB.
Preference storage failures leave the current selection usable. Restoring a
preference does not emit a `store_region_changed` analytics event.

Budget picks use the selected market's representative Steam price and reported
currency, with rounded affordability bands for all 37 currently supported
[Steam currencies](https://partner.steamgames.com/doc/store/pricing/currencies).
This handles regional USD countries such as Türkiye, Argentina and Pakistan,
and euro countries without requiring a separate currency choice. Amounts use
Steam's hundredths convention, including JPY, KRW and KWD; they are not live FX
quotations. Prices from another country never qualify for the selected region.

`20260930153843_wishlist_all_store_regions.sql` is applied to the active legacy
cache. Its country constraint accepts the complete allowlist and retains all
existing rows, leases, expiry rules and access controls. The matching V2
follow-up is `database/v2/supabase/migrations/20260930153037_wishlist_all_store_regions.sql`;
it is staged after the pending M5 migration that creates the private cache.
No V2 activation or deployment is part of this change.

Verified: all 249 countries accepted by the live cache in a rolled-back test,
invalid country codes rejected, live JPY/BRL/EUR/regional USD prices returned by
the local API, regional Budget picks, desktop/mobile search, keyboard navigation,
anchoring and long country names. Existing wishlist analytics continues to
record the representative ISO country code without collecting the search text.

### Cache lifecycle

`wishlist_store_cache` stores Steam details per AppID/country, shared by all
visitors. Only requested cards and the existing next-batch prefetch populate it;
there is no scheduled scan, price-change feed, or external pricing provider.
The database holds the last successful check and expiry, plus numeric minor-unit
prices and currency inside the details payload. Free games have a zero amount;
missing prices stay unknown.

A server-only, security-invoker RPC takes a 30-second refresh lease. Local
promises also coalesce simultaneous requests. Other instances reuse fresh data
or briefly wait for a cold entry; they do not make duplicate Steam calls. Failed
refreshes back off for two minutes and retain descriptions but hide expired
prices. Crashed leases expire automatically. Database failures fail closed rather
than bypassing the cache and flooding Steam. Requests retain the existing route
rate limit and four-at-a-time upstream concurrency per request.

The browser respects server expiry and checks currently requested entries every
30 seconds while visible, and when returning to the tab. Fresh entries cause no
network request. Updating details does not change recommendation selection.

Migration `20260923010752_wishlist_store_cache.sql` is applied to the configured
Supabase project. The table and RPC deny access to anon/authenticated roles;
only the server service role can use them. The advisor's informational
[RLS-without-policy notice](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)
is intentional for this server-only cache.
`lib/wishlist-store-cache.test.ts` covers expiry, regional isolation, concurrent
requests, outage handling, retry backoff and recovery from crashed leases.

## Analytics

Wishlist uses the shared PostHog client and its consent, Do Not Track, Global
Privacy Control and account/guest context. `SiteExperience` owns the pageview;
the page does not send an additional one. Events include `app_area: wishlist`
except entry links, which retain the originating page's area.

| Event | Meaning and properties |
| --- | --- |
| `wishlist_action` | Navigation entry, filter changes, shuffle, budget-candidate loading, import panel/profile connection, saved pagination, outbound search/wishlist links, and failed updates. `action` identifies the interaction. |
| `wishlist_search` | Submitted search completes or fails; `outcome`, query length, result count on success, and duration. Aborted searches are not counted. |
| `wishlist_game_saved` / `wishlist_game_removed` | Successful persistence only; AppID, browser/account storage, resulting wishlist count, source surface and rank. Recommendation cards also include the selected mode. |
| `wishlist_import` | One started and one completed/failed event per batch. `steam_entry_count` is the Steam payload size, not the number of newly added games. Imports never emit per-game save events. |
| `wishlist_store_opened` | AppID, source surface/rank/mode, saved/owned state, and `store_button` control. Uses immediate sendBeacon transport. |

Typing, raw search queries, exception messages and card impressions are not
included in these custom events. Outbound links use the shared navigation
transport. Analytics failures do not block wishlist actions. Session replay
continues to follow the app's existing recording and masking policy.

Live ingestion requires `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` at build time.
Local verification uses the actual event handlers with a capture stub; no
synthetic events are sent to the production project.

## Verification

`lib/wishlist.test.ts` covers exclusion, taste, finite duration, ranking,
franchise diversity, invalid/private Steam payloads and corrupt guest storage.
`e2e/wishlist.spec.ts` covers saving, reloading, removal, Steam search, filter
changes, import guidance and legacy route redirection.
`lib/wishlist-analytics.test.ts` verifies persistence-before-success, failed
writes, batch import outcomes/duplicate clicks and Steam link context/transport.
`lib/steam-wishlist.test.ts` covers transport status, private/empty responses, malformed JSON, rate limits, and bounded transient retries.
The shared client's privacy and queued opt-out behavior is covered by
`lib/blog-analytics.test.ts`.

Migration `20260919155409_add_user_wishlist.sql` was applied to the linked
Supabase project on 19 September 2026. Local development requires
`SESSION_SECRET` and `RATE_LIMIT_SECRET`, as do existing account/write APIs.

## Refinement verification (20 September 2026)

- Wishlist uses the same centred `--vault-list-width` column (1040px maximum),
  18px page spacing, section-heading scale and card/well tokens as Dashboard,
  Library and Collections. Three-card desktop rows (nine recommendations per shuffle) adapt to two and one columns.
- Controls opt into `app/controls.css`: Steam actions use Steam blue, search is
  primary, save/refresh are secondary, and filters use an inset selection bar without ticks.
  Async operations show the shared busy state/spinner only on their own control.
  Page-specific blanket hover overrides have been removed.
- Hero removed; shared GuestPreviewNotice used. Guest catalogue entries are not
  treated as owned games or as evidence of personal taste.
- Cards use Steam's native 460×215 header ratio without image optimisation and
  a fixed 210px body with a two-line title slot. Recommendation reasons have three reserved lines and clip inside their rows. Game descriptions appear only in the details popup. Reviews and duration share a compact row with the price, keeping the full-size action buttons below. The saved wishlist uses the same three-column grid.
  The region listbox opens below its trigger and supports keyboard navigation. At a given viewport, card dimensions are locked across
  every shuffle. Catalogue titles stay stable while details load.
- Saving and removing games update buttons and the saved shelf without changing
  visible recommendations or scrolling. The prepared queue advances only on
  Refresh picks, and exhausted queues regenerate from current saves and library
  state. Both the icon-only refresh beside the filters and the Refresh picks button keep scroll position. Find your first game still
  explicitly scrolls and focuses search. The Vault remains in primary navigation.
- Only the dedicated View on Steam button opens a game store page. It uses
  Steam's official icon, served locally; the artwork and card do not navigate.
- New behavioral browser coverage checks four non-overlapping batches, locked
  dimensions under oversized text and search focus.
- Import results stay visible after the toast disappears. A successful write
  followed by a failed refresh explicitly asks for a reload instead of implying
  the visible list is current.
- Competitor findings and implementation decisions: [import audit](wishlist-import-audit.md).

### Wishlist preview and price loading

- Clicking a Wishlist card opens the Library-style details popup. Both routes render the same `GameDetailsDialog` component with the same artwork treatment, content order, spacing and modal behaviour. Wishlist supplies its save/store actions and purchase metadata; it does not append a separate recommendation paragraph. Full descriptions live only in this popup. Escape, backdrop click, focus trapping and focus restoration match Library. Hover alone does not open anything; the grid remains fixed.
- Budget picks publishes its first nine verified lower-band games immediately, then prepares up to three sets in the background. The higher price band is used only when the candidate scan cannot fill the lower band. Small four-game requests avoid holding the first set behind an entire 16-game response.
- Card enrichment and budget selection share page-local fresh regional data and pending requests. Prices retain the server expiry; country changes cannot reuse another region's price. Background results never replace the visible set.
- Analytics records details opens (card), top/bottom refresh and time to first budget set separately from the completed background price scan.

## Expanded selection (30 September 2026)

`lib/wishlist-catalogue-server.ts` selects Wishlist independently of the guest
preview: up to 6,000 general candidates plus 3,000 each for short games,
well-reviewed games and likely bargains. Each lane is paged explicitly against
the 1,000-row PostgREST cap. All excluded quarantine IDs are paged too.
Lightweight summaries are scanned first; eligible IDs are deduplicated before
hydrating their tag maps in bounded groups of four 500-game queries. No Steam
price refresh occurs while building this catalogue. Genre/niche selection,
metadata validation and quality gates remain; unknown-duration games can still
appear in For you or Highly rated, but cannot qualify for Short & sweet.

The snapshot is cached for an hour and concurrent requests share its promise;
the public route retains its CDN caching. Source USD prices are hints to guide
budget discovery, never user-visible regional prices or eligibility evidence.
The verified live snapshot has 5,518 unique games, 2,390 finite short candidates
and 3,622 games meeting the strong-review gate. Cold local loading was about
ten seconds; a warm local request took about 176 ms. These are development
measurements, not production latency guarantees.

Normal decks now hold up to 80 sets of nine. Scoring compares at most 512
candidates per slot and retains eight strong seed connections per game;
franchise/edition exclusions advance past blocked windows. A real 60-game taste
profile prepared 720 picks in about 500 ms in the local measurement. Budget
picks publishes the first nine as soon as available, warms up to eight sets,
and explores another unseen group when that reserve runs out. Existing cards
stay mounted while budget replenishment runs, preserving size and scroll.
Wishlist changes still never replace the currently displayed cards.

### Personalisation and remembered discoveries

For you now selects up to 120 played/completed library seeds by round-robin
gameplay interest, preserving smaller interests in libraries with hundreds of
games from one genre. Completed games and log-scaled playtime remain the primary
evidence; ownership alone, family games and blacklist entries do not supply taste.
Wishlist influence remains weaker and capped at one source per set.

Each batch scores a window of 256 strongest matches plus the best candidates
from each gameplay category (up to another 256), refilled for every batch.
This prevents a large dominant interest from hiding other relevant matches
beyond the old front window. A soft category penalty complements distinct
source-game reasons and franchise limits; single-interest players still receive
related games rather than forced unrelated genres. Seeded randomness changes
the choices and their positions without changing eligibility.

Shown AppIDs persist separately by account, tab and market under
`vault-wishlist-pick-history-v1:<account>`. Queued candidates are never marked
seen. Reloads and return visits skip served picks while eligible alternatives
remain; exhausted pools restart. History is bounded to 6,000 recent AppIDs per
tab/market and 12 markets per account. Corrupt/blocked storage falls back to
visit memory. No card impressions or private taste profiles are sent to analytics.

Verification covers contrasting player profiles, a library dominated by 150
strategy games with five smaller played interests, candidates beyond 1,000
dominant matches, and eight connected-account reload/navigation visits yielding
72 distinct games with real played-game reasons.

Verification includes 25 fresh sets on each non-price tab, 12 budget sets from
a cold reserve, stable saves, fixed geometry, page scroll, cache expiry, pricing
region isolation and per-tab eligibility. The existing V2 public discovery
integration remains a cutover gate: this loader fails closed under V2 authority
and never borrows the legacy database. No database migration or activation was
added by this selection expansion.
