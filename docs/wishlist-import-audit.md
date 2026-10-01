# Steam wishlist import audit — 20 September 2026

## What competitors actually expose

| Service | Evidence | Implication for VaultShuffle |
| --- | --- | --- |
| GG.deals | Its [current extension documentation](https://gg.deals/extension/) says list synchronization reads Steam pages while the user is signed in, including private-profile access. Its [historical support incident](https://forum.gg.deals/d/1509-is-steam-wishlist-sync-broken-or-is-it-just-me) explicitly describes a guest-page scraper failing when Steam stopped serving the wishlist page anonymously. | Extension access and server-side public access are different capabilities. Do not scrape the old wishlist HTML page or promise private import from OpenID sign-in. |
| IsThereAnyDeal | Its [profile API](https://docs.isthereanydeal.com/) documents linked remote profiles, stable Steam `app/ID` identities, and explicit sync behavior. Its [privacy policy](https://isthereanydeal.com/legal/privacy/) distinguishes Steam identity and country settings. | Use the connected SteamID, deduplicate stable AppIDs, distinguish import from bidirectional sync, and label price region. Public docs do not reveal its current server-side Steam ingestion implementation. |
| Augmented Steam (ITAD) | The public [WishlistExporter](https://github.com/IsThereAnyDeal/AugmentedSteam/blob/master/src/js/Content/Features/Store/Wishlist/Utils/WishlistExporter.ts) produces version-05 JSON with stable `gameid: [steam, app/ID]`, title and added-date fields. Its [repository](https://github.com/IsThereAnyDeal/AugmentedSteam) describes a browser extension. | A user-selected export file could be a future private-profile fallback without transferring Steam cookies. No extension, cookie extraction or export importer was added in this refinement. |
| Fanatical | Its [account-sync instructions](https://www.fanatical.com/en/blog/wishlist-and-win) describe Linked Accounts → Wishlist Sync; its [Assistant explanation](https://www.fanatical.com/en/blog/how-your-wishlist-helps-build-fanatical-bundles) describes reading the signed-in Steam wishlist with an extension and transferring titles available in its own store. | Explain which account is imported and what is retained. Do not assume a competitor's store-only filtering is suitable: our saved AppIDs can outlive catalogue coverage. |

These are documented product behaviors and inspected public source, not claims
about private competitor infrastructure. Older articles are labeled by context;
they are evidence of failure modes, not a current API contract.

## API choice and live evidence

We use `IWishlistService/GetWishlist/v1/?steamid=…`, not the former store
`wishlistdata` endpoint or wishlist-page HTML. Steam's distributed service
[protobuf schema](https://github.com/SteamTracking/Protobufs/blob/master/webui/service_wishlist.proto)
defines a repeated list of AppID, priority and added-date records. This method
has no page/start field; separate metadata requests supply names and prices.

A read-only live probe of a known public profile returned HTTP 200,
`x-eresult: 1`, and 42 items. A separate public Portal 2 appdetails request
returned a description and a GBP price. This proves endpoint availability for
that public case, not guaranteed availability for every Steam profile.

## Hardened behavior

- Fetch the session's connected 17-digit SteamID; never derive it from display
  name or accept a caller-selected account ID for writes.
- Do not cache wishlist imports, so privacy changes are reflected on retry.
- Check both HTTP status and Steam's `x-eresult`. Access denied is distinct from
  throttling, upstream failure, invalid JSON, and malformed item data.
- A protobuf response may omit an empty repeated field. `response: {}` is only
  accepted as empty when Steam explicitly returns success (`x-eresult: 1`). An
  ambiguous empty response fails safely instead of reporting an empty wishlist.
- Retry transient network/5xx failures once, with a 12-second timeout per attempt.
  Do not automatically retry access denied or rate limits.
- Validate the complete response before writing. One duplicate-safe database
  statement adds at most 10,000 AppIDs; no existing save is deleted or overwritten.
  Metadata loading is separate from the write, so a delisted game cannot make
  the whole import fail.
- Tell users both Profile and Game details must be Public, link Steam's privacy
  settings, and state that sign-in does not unlock private data. No Steam password,
  cookie, bearer token or personal API key is requested.
- Keep an inline result after completion; distinguish saved entries from a
  subsequent display-refresh failure. Counts describe Steam entries processed,
  not newly inserted rows.

## Verification boundary

Automated tests cover public list parsing/deduplication, confirmed-empty
transport status, ambiguous/private responses, HTTP and Steam rate limits,
transient retry, invalid JSON and invalid AppIDs. Hook tests cover batch event
outcomes, duplicate-click suppression, failed persistence and safe existing state.
The live probe is read-only. A real signed-in account import still needs its
normal user session to exercise that account's privacy state end to end.
