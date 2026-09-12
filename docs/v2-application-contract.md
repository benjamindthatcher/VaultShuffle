# VaultShuffle v2 application contract

Status: M1 application contract, provider-call inventory, and final M2 security review checkpoint, 7 September 2026. This document freezes
the compatibility boundary for the future repository and application migration.
M1 here means the foundational schema/session security boundary. It does not
claim M3 real-data parity or M4/M5 application and product parity. This document
does not implement the repository, change the legacy application, or define the
executable v2 SQL schema. The database agent owns that schema.

## 1. Scope and non-negotiable compatibility

The v2 data access layer must preserve the existing browser experience while it
is introduced behind the BFF. The following are externally observable contracts
and must survive the migration:

- The session cookie is named `vault_session`. It is host-only (the current code
  does not set `domain`), has `path=/`, `httpOnly=true`, `sameSite=lax`,
  `priority=high`, and is `secure` when `NODE_ENV=production`.
- A verified Steam token has a 30-day lifetime. A manual browser-profile token
  starts with the literal `manual.` and has a 365-day lifetime. The prefix is
  part of the discriminator and must be retained byte-for-byte.
- The token digest is HMAC-SHA256 using `SESSION_SECRET`, over the complete raw
  cookie value including `manual.` when present. The legacy representation is
  64 lowercase hexadecimal characters. v2 may store the digest as 32-byte
  `bytea`, but migration must decode the existing hex without changing the
  digest or secret. Raw tokens, secrets, and digests do not enter DTOs, logs,
  SQL migration files, or client storage.
- Expiry is checked at lookup time. Expired, revoked, or absent sessions resolve
  to no principal. A database/pool/session-resolution failure is a retriable
  503 condition and must never be converted to logout, guest mode, or a 401.
  A real missing session remains the only `session_required`/401 case.
- Existing account UUIDs remain the public account IDs. v2 may use an integer
  internal account key, but every application DTO, URL, analytics identity, and
  migration mapping continues to use the preserved UUID.
- Public Steam profile workspaces are browser-controlled, unverified accounts.
  The same public Steam ID may appear in multiple such accounts. A verified
  Steam OpenID identity is the only unique identity claim.

The account/session contract is deliberately independent from the legacy
Supabase service-role client. The future repository must resolve the cookie to a
principal once, establish transaction-local tenant context, and pass only
allowlisted account-scoped parameters to domain queries.

## 2. Current source contract and anchors

The current implementation is the compatibility authority until M7 cutover.
These anchors were read during the audit:

| Contract | Current source anchor | Observed behavior |
| --- | --- | --- |
| Cookie name, token branch, HMAC, lookup errors | [`lib/auth.ts`](../lib/auth.ts#L9), [`lib/auth.ts`](../lib/auth.ts#L46), [`lib/auth.ts`](../lib/auth.ts#L67), [`lib/auth.ts`](../lib/auth.ts#L126) | `vault_session`; HMAC-SHA256; prefix selects manual/verified lookup; DB errors throw `SessionLookupError`. |
| Manual session lifetime and sliding last-seen | [`lib/auth.ts`](../lib/auth.ts#L10), [`lib/auth.ts`](../lib/auth.ts#L153) | Manual rows start with a 365-day expiry and refresh `last_seen_at`/expiry at most hourly; verified rows use a fixed 30-day expiry and are not renewed on lookup. |
| Session creation and promotion RPC boundary | [`lib/auth.ts`](../lib/auth.ts#L235), [`lib/auth.ts`](../lib/auth.ts#L263), [`lib/auth.ts`](../lib/auth.ts#L282), [`lib/auth.ts`](../lib/auth.ts#L327) | Server creates random raw tokens; only HMAC digests cross into the database RPC. |
| Cookie flags and expiry | [`lib/auth.ts`](../lib/auth.ts#L419), [`lib/auth.ts`](../lib/auth.ts#L435), [`lib/auth.ts`](../lib/auth.ts#L441) | Host-only, root path, `httpOnly`, `lax`, production `secure`, high priority; manual refresh reattaches the 365-day cookie. |
| Manual security cookie and stable error codes | [`lib/manual-profile-security.ts`](../lib/manual-profile-security.ts#L17), [`lib/manual-profile-security.ts`](../lib/manual-profile-security.ts#L19) | Callback-scoped `vault_profile_security`; database markers map to a fixed browser-facing error union. |
| Manual lookup token signing | [`lib/manual-steam-profile.ts`](../lib/manual-steam-profile.ts#L143), [`lib/manual-steam-profile.ts`](../lib/manual-steam-profile.ts#L154) | Separate HMAC-SHA256 domain string `manual-profile\u001f`; 15-minute signed lookup token; this is not the session token. |
| Session DTO | [`lib/session-payload.ts`](../lib/session-payload.ts#L7), [`lib/types.ts`](../lib/types.ts#L111) | `logged_in`, `account_type`, `identity_verified`, public `user_id`, Steam/profile display fields, key/capability visibility. |
| BFF bootstrap and 503 behavior | [`app/api/app-data/route.ts`](../app/api/app-data/route.ts#L18), [`app/api/app-data/route.ts`](../app/api/app-data/route.ts#L25), [`app/api/app-data/route.ts`](../app/api/app-data/route.ts#L30) | Guest returns session only; signed-in path currently loads the full library and dependent state; domain-load failure returns 503 with session and `data_error`. |
| Bootstrap consumer | [`components/app-shell/AppDataProvider.tsx`](../components/app-shell/AppDataProvider.tsx#L41), [`components/app-shell/AppDataProvider.tsx`](../components/app-shell/AppDataProvider.tsx#L230), [`components/app-shell/AppDataProvider.tsx`](../components/app-shell/AppDataProvider.tsx#L260) | Client expects full `Game[]`, collections, memberships, vault state, preferences and playtime in one payload. |
| Client failure distinction | [`lib/api-client.ts`](../lib/api-client.ts#L15), [`lib/request-failure.ts`](../lib/request-failure.ts#L11) | Only HTTP 401 becomes `unauthorized`; 503/504 remain retryable request failures. |
| Promotion/OpenID checks | [`app/api/auth/steam/callback/route.ts`](../app/api/auth/steam/callback/route.ts#L37), [`app/api/auth/steam/callback/route.ts`](../app/api/auth/steam/callback/route.ts#L65), [`app/api/auth/steam/callback/route.ts`](../app/api/auth/steam/callback/route.ts#L159) | Security flow is tied to the callback cookie, verified OpenID is required, current manual session is rechecked, and promotion/merge is a single RPC. |
| Legacy SQL identity/atomicity | [`supabase/migrations/20260829224140_add_manual_steam_profiles.sql`](../supabase/migrations/20260829224140_add_manual_steam_profiles.sql#L127), [`supabase/migrations/20260830151421_secure_manual_profiles.sql`](../supabase/migrations/20260830151421_secure_manual_profiles.sql#L133), [`supabase/migrations/20260830151421_secure_manual_profiles.sql`](../supabase/migrations/20260830151421_secure_manual_profiles.sql#L206) | Manual IDs are intentionally non-unique by Steam ID; normal login and promotion use a SteamID advisory lock; promotion is atomic. |

The installed Next.js data-security guide also requires the future DAL to be
server-only, authorize before querying, and return minimal DTOs. Route handlers
must validate input and delegate. The installed route-handler guide confirms
that handlers are request-time by default and GET caching is opt-in. The
installed `preferredRegion` guide marks route-level `preferredRegion` deprecated;
placement belongs in Vercel configuration and deployment verification.

## 3. Exact session and cookie behavior

### 3.1 `vault_session`

`getCurrentSession()` reads one cookie. No cookie returns `null`. A token whose
value begins with `manual.` resolves through the manual session relation; every
other token uses the verified Steam session relation. The complete raw token is
hashed before the lookup, so the prefix is part of the HMAC input as well as the
branch discriminator.

The current implementation creates a verified session with a fixed 30-day
expiry. It does not renew that expiry or its session `last_seen_at` during a
lookup. A manual session starts with a 365-day expiry; when its `last_seen_at`
is older than the one-hour visit window, the lookup best-effort refreshes
`last_seen_at` and sets expiry to another 365 days from the refresh time. The
response path also reattaches the manual cookie with a 365-day browser lifetime.
This difference is part of the compatibility contract: verified expiry is fixed,
manual expiry is sliding.

Both branches reject an expired session. The current PostgREST calls pass an
application-generated ISO timestamp for that comparison; this is an
implementation detail of the legacy client, not a requirement for the v2
resolver. Ordinary runtime resolution must not depend on a caller-controlled
clock. The database boundary should compare expiry with its own current time
(`CURRENT_TIMESTAMP` or an equivalent server-side clock) while resolving the
digest and expected kind.

The repository replacement must preserve these semantics while changing the
database call shape:

1. Read the host-only cookie in server code.
2. Compute HMAC-SHA256 with `SESSION_SECRET` over the exact cookie value.
3. Resolve the digest through the private session function/repository.
4. If zero rows are returned, return `null` and let the route decide whether a
   session is required.
5. If the database, pool, transaction, or security-definer function fails,
   throw a typed session lookup failure. Route handlers return 503 with a stable,
   retryable error; they do not clear the cookie.
6. For a manual session, refresh `last_seen_at` and sliding expiry no more than
   once per hour. This write is best effort and must not turn a successful
   session read into a failure. Preserve the current 365-day refreshed expiry.
   A verified session keeps its original fixed 30-day expiry.

`attachSessionCookie` and `clearSessionCookie` must keep the same name, flags,
host/path scope, and max-age behavior. `clearSessionCookie` clears the root-path
cookie with `maxAge=0`; it does not delete a database account. Logout may revoke
or delete the current session, but its database error handling must be explicit
and must not make a successful cookie clear look like a data migration.

Other callback cookies are also compatibility-sensitive:

| Cookie | Current attributes and purpose |
| --- | --- |
| `vault_profile_security` | `httpOnly`, `lax`, production `secure`, `priority=high`, `path=/api/auth/steam/callback`, max-age equal to the remaining intent lifetime (application creates a 10-minute intent; SQL permits at most 15 minutes). |
| `vault_auth_trace` | `httpOnly`, `lax`, production `secure`, callback path, 15-minute max-age; diagnostic-only and cleared by the callback. |
| `vault_steam_import` | non-HTTP-only, `lax`, production `secure`, root path, five-minute max-age; UI import marker only. |

Do not broaden callback-cookie paths or make the session cookie readable by
client JavaScript as part of the repository work.

### 3.2 Required SQL principal boundary

The M1 database contract must expose one private session-resolution function (or
an equivalent repository-owned SQL boundary) with a stable, documented result.
It accepts the 32-byte token digest and the expected session kind derived by
server code from the cookie prefix. It never accepts or returns a raw token or
secret. Ordinary runtime resolution does not need a caller-supplied current-time
argument: expiry is checked against the database server clock inside the
boundary.

The minimum principal result needed to establish tenant context is:

```text
account_id    integer  -- internal tenant key
session_kind  text     -- 'manual' | 'verified_steam'
```

The approved narrow resolver row may also contain these non-secret session and
account fields, without profile text or any token material:

```text
session_id        bigint
account_public_id uuid
account_kind      text       -- 'manual' | 'steam'
identity_verified boolean
expires_at        timestamptz
```

Application acceptance needs only the tenant pair above; the additional fields
support compatibility and exact session handling. Profile and display material
remain optional follow-up data.

The application may obtain profile fields or capability values through an
authorized, tenant-scoped follow-up. A follow-up that needs the current session
row must use the server-held digest together with this principal (or an
equivalent private touch function), so manual sliding refresh targets this
cookie's session rather than every manual session for the account. Those
optional profile reads must return `null` for unknown values at the SQL boundary;
the TypeScript DTO can retain legacy empty-string presentation values where
existing consumers require them. Profile material is not required in the
resolver result itself.

The prefix is part of the HMAC input and selects the expected kind. The resolver
must match both digest and kind, so a kind mismatch yields no principal; the
repository must never strip `manual.` before hashing or treat a public Steam ID
as proof of verified identity. The boundary must enforce digest uniqueness,
database-clock expiry, revocation state, valid account linkage, and the
session/account kind relationship. A verified Steam session requires a verified
Steam profile; manual workspaces may share a Steam ID and remain unverified.

The function runs as a narrow `SECURITY DEFINER` boundary with an empty/fixed
search path and qualified references. Only the runtime group may execute it. A
missing `app.account_id` context must fail closed for all subsequent tenant
queries.

## 4. Identity, promotion, and merge semantics

These are downstream M5 product and authentication checks. M1 establishes the
account/session storage and resolver security boundary; it does not claim that
promotion, merge, OpenID replay protection, or the complete journey is already
implemented.

The current promotion flow is a security boundary, not a profile edit:

- A manual profile is created from a successfully checked public Steam profile.
  Its session proves control of this browser only. It does not prove control of
  the Steam account and must remain usable as an unverified workspace.
- Starting secure-profile creates a short-lived, single-use intent bound to the
  current manual account and exact manual session. The intent token is HMACed;
  its raw value is kept only in the callback cookie.
- The callback validates Steam OpenID and extracts the verified Steam ID. A
  cancelled, missing, invalid, replayed, expired, or mismatched callback creates
  no verified session and does not set `vault_session`.
- Completion rechecks the manual session, intent, manual profile Steam ID,
  OpenID response nonce, and verified Steam ID in one transaction. The normal
  login path and promotion path lock the same verified Steam identity before
  creating or selecting the verified account.
- If no verified account exists, the manual account is promoted in place so its
  existing UUID remains the public ID. If one exists, the manual account is
  merged into that verified target atomically. The target receives a new
  verified session. The merge audit records source, target, verified Steam ID,
  and mode; analytics delivery is asynchronous and cannot roll back the merge.
- A verified target's identity and privileges win. An old manual cookie must not
  gain verified powers, and an unverified workspace must never be treated as a
  unique Steam identity. v2 must retain a source-account alias/tombstone long
  enough for old cookies, cached URLs, and historical event references to
  resolve safely after a merge. The merged source account remains a non-active
  `lifecycle=merged` row during that retention period; M5 must not hard-delete
  it as part of the merge. Any foreign-key cascade applies only to an intentional
  later purge after alias/tombstone retention expires.

The M4/M5 repository should expose typed operations corresponding to these
existing boundaries: `resolveSession`, `createVerifiedSession`,
`createManualSession`, `createManualSecurityIntent`, `completeManualSecurity`,
and `revokeCurrentSession`. Domain operations must receive the resolved
principal, not an account ID copied from an HTTP body.

## 5. Session DTO contract

The current `/api/session` and `/api/app-data` session object is the compatibility
DTO. Keep these keys during the bridge:

```ts
type SessionPayload = {
  logged_in: boolean;
  account_type: "guest" | "steam" | "manual";
  identity_verified: boolean;
  user_id: string;                 // preserved UUID; empty for guest
  steam_id: string;                // decimal SteamID64; empty for guest
  display_name: string;
  steam_display_name: string;
  avatar_url: string;
  has_steam_key: boolean;
  steam_playtime_visible?: boolean | null;
  steam_last_played_visible?: boolean | null;
};
```

`identity_verified` is derived from the verified account branch, not from the
presence of a Steam ID or a public profile URL. `has_steam_key` is server-derived
configuration state. Capability visibility is tri-state: `true`, `false`, and
`null`/unknown have different meanings. Do not expose internal account IDs,
session IDs, token state, merge intent IDs, or raw provider errors.

The minimal resolver principal does not need to contain profile fields. Session
metadata (display name/avatar and capability reads) can come from a private
follow-up keyed by the resolved principal and may be best-effort, as today. A
profile refresh failure must not invalidate a good session. A failed required
session lookup must remain a 503 and must not be represented as
`{ logged_in: false }`.

## 6. Bootstrap and consumer migration boundary

The current `AppDataProvider` is the main reason `/api/app-data` cannot simply
gain a cursor. It expects one payload containing all `games`, collections,
memberships, vault state, learned preferences, game preferences, and playtime;
it then maps and filters full arrays in the browser. In particular, the provider
currently:

- destructures `games`, `collections`, `memberships`, and `vaultState` as a
  complete live dataset;
- derives collection membership and smart collection results from those arrays;
- calculates visible/all-game counts and global-filter results locally;
- refreshes the separate family, import, pin-playtime, and vault-history
  endpoints; and
- keeps a guest fallback and fetches `/guest-catalogue` separately.

M4 must migrate the BFF and this consumer as a coordinated slice. The sequence
and boundary are:

1. Keep the guest branch inexpensive and compatible. Guest bootstrap may remain
   session-only, with `/guest-catalogue` separately cacheable and its bundled
   fallback intact.
2. Define a versioned authenticated bootstrap containing only the session-safe
   session DTO, account/library/feature revision tokens, small counts/settings,
   three pins, and current pick. It must not contain the full library or full
   preference corpus, and authenticated responses are private `no-store`.
3. Add the Library page contract (default 50, maximum 100) with allowlisted
   filters/sorts/search, stable keyset cursor, facet/total metadata, and the
   library revision. Return display cards only. Counts must represent the full
   eligible scope even when the page is bounded.
4. Move dashboard aggregates/trends, game detail, collection membership pages,
   and optional achievements/buy data to their own bounded contracts. Family
   roster remains a separate enhancement request. Vault draw candidate
   selection remains server-side and returns a draw ID plus bounded reasons.
5. Update `AppDataProvider` and page consumers to use query keys containing the
   account public ID, endpoint/scope/filter hash, cursor, and revision. Clear
   private query state on logout/merge; retain usable data on transient 503s.
6. Remove the full-library bootstrap dependency only after all consumers no
   longer assume `Game[]` is authoritative. A compatibility response may exist
   during the bridge, but it must have one authority and an explicit removal
   milestone; adding a cursor to `/api/games` while leaving the provider on the
   old payload is not a valid migration.

Mutations must carry an idempotency key and expected revision. A committed
mutation returns changed DTOs/revisions; stale revisions return 409 and prompt a
refresh. A session lookup failure stays 503. Only a confirmed absent session is
401 and eligible for the existing client `unauthorized` path.

### 6.1 Steam provider call inventory and M2 handoff

This is the repository inventory for the provider boundary described by
architecture sections 6–7. It records the callers that exist today; it does not
make the current legacy rate limits or process-local caches a v2 quota design.
Every runtime request that uses `STEAM_WEB_API_KEY` must eventually consume the
same deployed-provider budget, regardless of whether it started in a route,
session metadata lookup, family setup, or a worker. No key value, raw provider
body, or full URL with credentials may be logged or placed in a job/result DTO.

#### Steam Web API runtime requests

| Steam Web API request | Current callers and scheduling path | Priority | Current key, cache, and quota behavior | M2 consumer boundary |
| --- | --- | --- | --- | --- |
| `ISteamUser/GetPlayerSummaries/v0002` | [`lib/steam.ts`](../lib/steam.ts#L113) is called by the verified-login callback ([`app/api/auth/steam/callback/route.ts`](../app/api/auth/steam/callback/route.ts#L73)), missing-profile session metadata ([`lib/session-payload.ts`](../lib/session-payload.ts#L18), reached by `/api/session` and `/api/app-data`), manual profile lookup ([`lib/manual-steam-profile.ts`](../lib/manual-steam-profile.ts#L102)), and family-member add ([`lib/family-members.ts`](../lib/family-members.ts#L174)). | Interactive. The callback treats it as optional profile metadata; session metadata is also optional and only runs when display/avatar data is missing. Manual and family setup use `fresh=true`. | Server-only `STEAM_WEB_API_KEY`. A 30-minute in-process cache is keyed by a non-secret key prefix and Steam ID; `fresh=true` bypasses it. The shared Web API wrapper uses `no-store`, a 12-second timeout, and typed 429/no-retry errors. The callback has a request-fingerprint bucket of 20/10 minutes; manual lookup has 20/10 minutes per request fingerprint; family add has 12/hour per user. There is no shared provider-call reservation. | Reserve a profile call in the interactive lane. Same-identity fetch reuse may be added as an optimization, but each authorized flow still gets its own lease/outcome and profile follow-up. The callback must reserve only after OpenID validation and must not make profile metadata a prerequisite for session creation. Session metadata failures remain best-effort. |
| `IPlayerService/GetOwnedGames/v0001` with complete scope (`include_appinfo=1`, `include_played_free_games=1`) | [`lib/steam.ts`](../lib/steam.ts#L157) feeds the first/refresh fetch in [`app/api/steam/owned-games/route.ts`](../app/api/steam/owned-games/route.ts#L61), manual onboarding lookup ([`lib/manual-steam-profile.ts`](../lib/manual-steam-profile.ts#L103)), family-member add ([`lib/family-members.ts`](../lib/family-members.ts#L174)), and the bounded nightly sweep ([`lib/nightly-metadata.ts`](../lib/nightly-metadata.ts#L16)). The owned-games route then stages the response and [`lib/steam-import-jobs.ts`](../lib/steam-import-jobs.ts) claims/imports batches; those post-fetch batches do not call Steam, but register catalogue misses for the scheduled metadata queue. Manual create reads the 15-minute setup snapshot and also does not call Steam ([`app/api/manual-profile/create/route.ts`](../app/api/manual-profile/create/route.ts#L62)). Family sync/recheck and family-member removal also operate on stored candidates/catalogue rows and do not call Steam ([`app/api/family/sync/route.ts`](../app/api/family/sync/route.ts#L21), [`app/api/family/[id]/route.ts`](../app/api/family/[id]/route.ts#L18)). | Interactive for owned-games refresh, manual lookup, and family add; background for `/api/cron/nightly-metadata` ([`app/api/cron/nightly-metadata/route.ts`](../app/api/cron/nightly-metadata/route.ts#L6)). | Server-only `STEAM_WEB_API_KEY`; no response cache, 12-second timeout, no automatic retry. The owned-games route charges `steam_first_import` at 10/5 minutes or `steam_library_refresh` at 1/5 minutes per user and best-effort releases that reservation when no fetch occurred; resume batches use `steam_import_batch` at 45/5 minutes. Manual lookup uses `manual_profile_lookup` at 20/10 minutes per request fingerprint; family add uses `family_member_add` at 12/hour per user. Nightly runs behind `nightly_worker_daily` (one reservation per worker name/day), reads at most 150 identities with concurrency three, and stops starting later batches after a 429. These are legacy guards, not a shared Steam call budget. | Atomically reserve the complete owned scope before network I/O, then acquire an independent per-account/identity refresh generation and lease. Duplicate work for that account should return the existing job/status. A shared raw fetch cache/fanout keyed by Steam identity and refresh bucket is optional future optimization; it must preserve independent authorization, generation, failure, and publication outcomes for every account. A family-owned payload may enter only family candidate/shared-access rows and must never be mapped into the current account's personal ownership or minutes. Fetch and bounded body validation stay outside the publish transaction; publication checks the account generation/lease and only then acknowledges the job. |
| `IPlayerService/GetOwnedGames/v0001` with `appids_filter` (pinned playtime) | [`lib/steam.ts`](../lib/steam.ts#L175) is called by interactive [`lib/pinned-playtime.ts`](../lib/pinned-playtime.ts#L49), exposed at [`app/api/steam/pinned-playtime/route.ts`](../app/api/steam/pinned-playtime/route.ts#L11), and by the background [`lib/pinned-playtime-worker.ts`](../lib/pinned-playtime-worker.ts#L13) at [`app/api/cron/pinned-playtime/route.ts`](../app/api/cron/pinned-playtime/route.ts#L6). The interactive path derives at most three current library pins from the database; it never accepts a client Steam ID/AppID list or falls back to a full-library request. | Interactive dashboard refresh and background pins-only worker. | Server-only `STEAM_WEB_API_KEY`; at most 100 filtered AppIDs are accepted by the helper. Interactive refresh uses `pinned_playtime_account` and `pinned_playtime_steam`, each 1/60 seconds. The worker uses the daily worker guard, at most 150 candidates/run, concurrency four, and in-run deduplication by `(steam_id, sorted AppIDs)`; it has no provider-wide reservation. | Reserve filtered calls in separate interactive/background lanes, keyed by the authorized account and current pin revision. Acquire a short per-account refresh lease and fence stale writes. Shared Steam-identity reuse is optional and must not merge pin revisions or outcomes across accounts; never turn a pin refresh into a complete-library job. Retries and 429 responses still consume or defer an explicit reservation according to the M2 policy. |
| `IPlayerService/GetRecentlyPlayedGames/v0001` | [`lib/steam.ts`](../lib/steam.ts#L207) is called only by the background nightly path ([`lib/nightly-metadata.ts`](../lib/nightly-metadata.ts#L62), applied by [`lib/recency-sync.ts`](../lib/recency-sync.ts#L17)). The nightly run shares one pending read per Steam ID across verified/manual identity rows. | Background, secondary to a successful owned-library read. | Server-only `STEAM_WEB_API_KEY`; no cache or endpoint-specific rate bucket. Failures are recorded separately and must not fail the owned-library import; after a known 429 the nightly path suppresses later recent reads. | Reserve as a secondary bounded read when the library refresh plan allows it, or defer it with a typed outcome under pressure. Its failure must never publish “no recent games” or invalidate a complete library snapshot. |
| `ISteamUser/ResolveVanityURL/v0001` | [`lib/manual-steam-profile.ts`](../lib/manual-steam-profile.ts#L67) resolves vanity/profile input for [`app/api/manual-profile/lookup/route.ts`](../app/api/manual-profile/lookup/route.ts#L17). The same request is implemented in [`lib/family-members.ts`](../lib/family-members.ts#L119) for [`app/api/family/route.ts`](../app/api/family/route.ts#L35); a supplied 17-digit Steam ID skips this request. | Interactive setup. | Server-only `STEAM_WEB_API_KEY`; 12-second timeout through the shared Web API wrapper and no automatic retry. It inherits the manual-lookup 20/10-minute request-fingerprint or family-add 12/hour per-user guard; there is no shared provider reservation. | Reserve and lease the reference-resolution step as part of the onboarding operation. A duplicate vanity check may coalesce, but an invalid or unresolved reference must not create an account/member or consume a complete-library publish lease. |

`https://steamcommunity.com/openid/login` is adjacent to, but is not, the Steam
Web API. [`verifySteamOpenId`](../lib/steam.ts#L89) posts the callback parameters
from [`app/api/auth/steam/callback/route.ts`](../app/api/auth/steam/callback/route.ts#L64)
with no Web API key. The callback's 20/10-minute request-fingerprint guard is
the current abuse control. M2/M5 must keep this verification and the
single-use/session-bound promotion intent separate from provider-key budget
accounting; a failed OpenID check must prevent the optional profile request and
all account/session writes.

[`app/api/auth/steam/route.ts`](../app/api/auth/steam/route.ts#L8) only builds the
OpenID redirect; it does not make a server-side provider request. The production
background schedules in [`vercel.json`](../vercel.json) are pinned playtime at
`0 1 * * *`, nightly library/recency at `0 3 * * *`, Store catalogue metadata at
`0 4 * * *`, and SteamSpy tags at `0 5 * * *`. The `0 6 * * *`
`genre-preferences` job is database-only and has no Steam provider consumer.
Each provider cron route goes through `runNightlyWorker`, which rejects
non-production execution and reserves one `nightly_worker_daily` run per worker
name/day before doing work.

The planned complete-scope adapter
[`lib/v2/import/steam-owned-fetch.ts`](../lib/v2/import/steam-owned-fetch.ts#L113)
has no production caller yet. It deliberately accepts only the complete owned
scope, bounds timeout/body/game count, returns typed `complete`/`unavailable`/
`invalid`, and states that authorization, quota, and generation/lease must be
reserved before invocation. Treat it as an M2 integration seam, not as an
already-wired replacement for the legacy callers above.

#### Steam Store requests (undocumented runtime endpoints)

These requests use no Web API key and must not inherit the Web API's published
terms, quota, or rate ceiling. They still need an explicit bounded Store policy
before v2 allows them to compete with interactive work.

| Store request | Current callers and scheduling path | Priority | Current behavior | M2 consumer boundary |
| --- | --- | --- | --- | --- |
| `/api/appdetails` plus `/appreviews/{appid}` | [`lib/steam.ts`](../lib/steam.ts#L247) composes both requests. Interactive game detail goes through [`app/api/steam/apps/[appid]/route.ts`](../app/api/steam/apps/[appid]/route.ts#L11); background catalogue enrichment claims rows in [`lib/catalogue.ts`](../lib/catalogue.ts#L118) from [`app/api/cron/catalogue-metadata/route.ts`](../app/api/cron/catalogue-metadata/route.ts#L6). `fetchSteamAppDetailsBatch` exists in [`lib/steam.ts`](../lib/steam.ts#L218) but currently has no caller. | Interactive detail lookup and background metadata queue. | No key. App details have a 60-minute in-process cache and a 650ms in-process spacing gate, a 15-second timeout, typed 429/`Retry-After`, and bounded queue retries/defer behavior. Reviews are best-effort, have no spacing gate or explicit timeout, and failures become `null`. The detail route charges `steam_app_lookup` at 30/hour per user. Catalogue cron has the daily worker guard and an explicit 40-game/run cap; one game may require both detail/review and a Deck request. | Use a separate Store endpoint class and reservation/lease policy. Coalesce `(appid, catalogue revision)` enrichment jobs, keep detail route calls bounded separately from background work, preserve authoritative-vs-best-effort review semantics, and record 429/terminal outcomes without assuming Web API guarantees. |
| `/saleaction/ajaxgetdeckappcompatibilityreport` | [`lib/steam.ts`](../lib/steam.ts#L432) is called from [`lib/catalogue.ts`](../lib/catalogue.ts#L350) only when a stored catalogue row lacks a Deck value; the same request is included in local backfill [`scripts/catalogue/fetch-steam-device-mode-gaps.mjs`](../scripts/catalogue/fetch-steam-device-mode-gaps.mjs#L11) and optional [`scripts/catalogue/fetch-steam-metadata-local.mjs`](../scripts/catalogue/fetch-steam-metadata-local.mjs#L101). | Background catalogue enrichment; local backfill is operator-run. | No key, no shared pacing gate, and no explicit timeout in the runtime helper. Non-2xx, malformed, and network failures become `null`; the value is fetched once per catalogue row when missing. | Give this undocumented Store call its own bounded budget/lease accounting, ideally coalesced with the catalogue AppID job but counted as an additional request. A failed optional Deck check must not make a valid title/ownership observation unavailable. |
| `/search/results/` with Mac/Deck filters | [`scripts/catalogue/fetch-steam-device-mode-index.mjs`](../scripts/catalogue/fetch-steam-device-mode-index.mjs#L138) only; it reads paginated HTML embedded in a Store JSON response and writes a local checkpoint/artifact. | Operator-run local backfill; no runtime route or cron caller. | No key. Defaults are page size 100, 3-second request spacing, concurrency one, four attempts with backoff and checkpoint resume. | Keep outside production M2 runtime reservations. If ever hosted, classify it as Store search with a separate cap and lease; never count it as Web API budget. |

The other operator-run Store backfills are also provider consumers even though
they have no route or cron caller: [`scripts/catalogue/fetch-steam-device-mode-gaps.mjs`](../scripts/catalogue/fetch-steam-device-mode-gaps.mjs#L11)
fetches AppDetails and Deck compatibility together, while
[`scripts/catalogue/fetch-steam-metadata-local.mjs`](../scripts/catalogue/fetch-steam-metadata-local.mjs#L88)
fetches AppDetails and optionally reviews and Deck compatibility. They use a
1.1-second request interval, a 20-second timeout, up to four attempts and local
backoff/checkpoint output. Keep these backfills outside production M2
reservations; if hosted later, classify each Store request explicitly and
charge the extra Deck/review calls separately.

#### Other provider and offline paths

- [`lib/steam-tags.ts`](../lib/steam-tags.ts#L170) calls the third-party SteamSpy
  `request=appdetails` endpoint from `/api/cron/steam-tags`. It is not Steam Web
  API or Steam Store. The job is behind the daily worker guard, claims up to 60
  rows (clamped to 220), spaces requests by 1.1 seconds, honors 429 retry data,
  defers the rest, and stops after repeated failures. M2 should give SteamSpy a
  separate provider class and queue lease; its public response must not consume
  the Steam Web API budget.
- [`scripts/catalogue/fetch-steamspy-top.mjs`](../scripts/catalogue/fetch-steamspy-top.mjs#L6)
  fetches one SteamSpy owner-ranked page; [`scripts/catalogue/fetch-steamspy-owners.mjs`](../scripts/catalogue/fetch-steamspy-owners.mjs#L20)
  fetches paged owner rankings with a default 61-second interval and a local
  cache; and [`scripts/catalogue/extract-steamspy-metadata.mjs`](../scripts/catalogue/extract-steamspy-metadata.mjs#L22)
  reads those cached pages without network access. These are local catalogue
  preparation, outside runtime M2 reservations. The local consolidation/import
  scripts consume artifacts and do not add provider calls.
- [`scripts/catalogue/audit-catalogue-quarantine.mjs`](../scripts/catalogue/audit-catalogue-quarantine.mjs#L21)
  reads Steam PICS data through `api.steamcmd.net` with concurrency 24 and
  bounded retries. That is an operator-run third-party PICS proxy audit, not a
  Steam Web API or Store request; it reads the existing catalogue and prints a
  report, so it has no runtime M2 consumer and must never receive production
  runtime credentials through a hosted route.
- [`lib/steam-images.ts`](../lib/steam-images.ts) and the catalogue scripts can
  construct static Steam CDN image and Store-page URLs. URL construction is not
  an API request and does not consume a provider budget.

#### Logical M2 interface expected by these consumers

The following are application-level obligations, not a physical SQL schema. The
database owner decides the tables, columns, queue transport, and function names.
Before an account-owned runtime provider call, the caller must provide an
authenticated principal; a background call must provide an explicitly
authorized worker identity. Every call still needs an allowlisted endpoint
scope and an idempotency/refresh bucket. The pre-session profile/vanity
exception uses the no-tenant generic reservation described in section 6.2 and
does not establish a principal. The shared boundary then needs logical
operations equivalent to:

1. `reserveProviderBudget(provider, endpointClass, lane, estimatedCalls, refreshBucket)`:
   atomically reserve the call allowance across all deployed versions. It must
   support the architecture's internal 80,000/day cap, at most 50,000/day for
   background work, and a per-minute token bucket, while retaining upstream
   429/`Retry-After` feedback. The provider credential is selected server-side;
   callers never submit a key.
2. `acquireRefreshLease(accountOrIdentity, scope, semanticKey, expectedRevision)`:
   atomically coalesce duplicate work and return an existing job/status when one
   is active. The required correctness key is the authorized account/identity
   plus scope and refresh generation; account publication gets its own lease
   fence. A shared raw Steam-identity fetch may be layered on later, but it is
   optional and cannot replace per-account authorization, outcome, or publish
   fencing. A lease can be renewed, finalized, or marked deferred, and stale
   workers must lose the right to publish or acknowledge newer work.
3. `recordProviderAttempt(reservation, outcome, callsUsed, upstreamStatus, retryAfter)`:
   record bounded typed outcomes (`complete`, `unavailable`, `invalid`,
   `rate_limited`, or terminal failure) without provider bodies, keys, or raw
   errors. Retries reserve quota explicitly. A reservation is not silently
   refunded after a network request; a no-network cancellation/refund policy,
   if any, must be atomic and explicit.
4. `publishAndAck(lease, validatedResult)`:
   commit the normalized result, applied marker, generation/revision and job
   status in one bounded transaction, then acknowledge transport. Network I/O
   never runs inside that transaction. This applies to the complete library,
   pinned observations, recency evidence, and Store catalogue jobs, with the
   Store calls using their own provider class.

The concrete consumers are therefore: interactive complete-library refresh,
manual profile and family onboarding, the nightly account-scoped library sweep
(with optional shared-identity read reuse), secondary recent-played evidence,
interactive/background pinned playtime, interactive/background Store catalogue
enrichment, and the separate SteamSpy tag worker. The legacy per-user buckets and `nightly_worker_daily`
guard remain useful compatibility/abuse controls during the bridge, but they do
not replace this atomic cross-route provider budget and lease contract. Offline
catalogue scripts remain operator-run and must not use production runtime
secrets or queues.

### 6.2 M2 authorization and account-lifecycle review

This is an application integration review of the approved physical
[`database/v2/M2-contract.md`](../database/v2/M2-contract.md); it does not add
SQL objects or change the database owner's schema. Three
boundaries must remain explicit when these consumers are wired:

1. **Pre-session profile and vanity calls need explicit generic-reservation semantics.**
   The approved M2 contract has
   `ops.consume_provider_attempt(p_endpoint, p_job_id default null, ...)` and
   allowlisted `profile`/`vanity` endpoints. The raw `ops` helper is a worker
   boundary; the browser/runtime uses the narrower
   `app.consume_provider_attempt(p_endpoint, p_units, p_attempt_id, ...)`
   wrapper, which has no job or game arguments and is limited to pre-session
   lookup endpoints. The nullable-job path must be usable before a
   session/account principal exists and an opaque request/flow idempotency key
   (whether mapped to `p_attempt_id` or a later application key) must bound
   duplicate charges. `app.request_owned_snapshot(...)`
   remains account-scoped: it derives `app.current_account_id()`, and its
   current `owned_snapshot` job shape requires an account and an authorized
   stored profile. A verified profile is required for a `steam` account; an
   active manual account may use an unverified stored Steam ID. Duplicate
   unverified workspaces may share a Steam ID, while only a verified Steam
   account gets strict verified-profile consistency and uniqueness. Using a
   manual profile here must never elevate it to verified authority, and each
   account still needs its own generation/lease and
   publication outcome. Consequently, the optional `GetPlayerSummaries` call
   after a validated OpenID callback, and `ResolveVanityURL`, profile, and the
   complete-library call in manual lookup cannot silently rely on that
   account-owned job path. The
   generic reservation must accept no internal account ID, public account ID,
   client Steam ID, provider key, or provider body; it must not set tenant
   context, create an account/session, or authorize provider data. OpenID
   verification must complete before its optional profile reservation, and
   manual lookup's request-fingerprint guard remains an abuse control. A manual
   profile/vanity input is lookup input, not identity proof. Manual lookup
   should reserve its known plan before I/O: one `vanity` call only for vanity
   input, followed by the `profile` and complete `owned_snapshot` calls; a
   direct Steam ID skips the vanity unit. The current SQL wrapper provides this
   nullable-job, principal-free reservation and rejects a fresh call when a
   transaction already has an account principal; only a previously recorded
   attempt may be replay-checked there. The raw helper has no runtime-role
   execute grant. Its only current job caller is the claim path, which supplies
   the queue/job serialization and a fresh attempt; any future internal job
   wrapper must reject a fresh reservation for an already leased job and allow
   only an exact existing-attempt replay. An authenticated account lookup uses
   its account-owned path. In either case, route DTOs discard internal account
   and subject fields.
2. **Body-less account operations must derive the tenant from the resolver.**
   A browser/route caller may send only an idempotency key to request or
   inspect an owned job. The session resolver must establish the
   transaction-local principal; `app.request_owned_snapshot(...)` must derive
   the account from it, and `app.get_owned_snapshot_status(p_job_id)` must
   additionally prove that the job belongs to that current account before
   returning even bounded status. A job ID, public account ID, Steam ID, or
   request body must never establish tenant context. A worker-only scheduler
   target such as `ops.request_owned_snapshot_for_account(p_account_id, ...)`
   is a separate trusted work-selection input: it must revalidate the active
   account/profile and must not set `app.account_id` from an untrusted caller.
   Worker claim/publish likewise derives the account from the job and checks
   active lifecycle plus the current generation/lease before writing. Full
   publish must also compare the current stored Steam ID with the
   `provider_subject` bound to its charged attempt; an active account check
   alone cannot make a response for a replaced profile safe. The status helper
   must require an active account as well as matching the current principal, so
   a retained merged source cannot expose its old job state. This
   keeps the approved seven-field resolver principal sufficient for tenant
   binding while leaving profile/public-ID reads as a separate authorized
   follow-up. Any internal `account_id` or `provider_subject` returned to a
   trusted server wrapper remains server-only and is omitted from route DTOs.
3. **Deletion and merge state must fence in-flight personal work.**
   If an account is deleted or becomes a merged source after a worker claims a
   job, the lease/generation check must make publish and acknowledgement stale
   or cancelled, with no private rows written. The approved cascade of personal
   jobs/charge records and any account-owned outbox references may remove
   queued work; shared catalogue jobs remain independent. A retained
   `lifecycle = 'merged'` source row is an alias/recovery record during the M5
   retention period, not an active tenant for a new M2 snapshot. Status after
   deletion or merge must not expose the old account's private job state. A
   request must revalidate the profile after taking the account sync fence, and
   claim must reject an owned job whose sync pointer or generation is no longer
   current before charging it. Account/profile lifecycle writers must use that
   same fence when changing or merging an account. Terminal retry/dead-letter
   paths must clear the sync pointer atomically with the terminal job status;
   deferred work deliberately retains its fence for explicit operator handling.
   A family-owned payload remains in
   family/shared-access data and cannot be remapped to the current account's
   personal ownership or minutes.

#### Final M2 SQL review checkpoint

The final applied migration is
[`database/v2/supabase/migrations/20260907163356_m2_jobs_quota_publish.sql`](../database/v2/supabase/migrations/20260907163356_m2_jobs_quota_publish.sql),
SHA-256 `f09d7ca900f3cdaaee81eff0f507adc5869865f16eb7f340eeb1729223bc5aba`.
The read-only application review below was captured against the preceding
7 September snapshot at 3,159 lines and 142,771 bytes, SHA-256
`669a577aca0d434bb14a3e251f2016cc4d7f34a62063884d9bd4688682362ac`. It records
application-facing findings only; the database agent owns the SQL and its
fixtures. The final positive-epoch/capability delta passed coordinator local
and target adversarial regressions; M2 was signed off on 9 September. The
earlier hash records review provenance, not the content at the current link.

The earlier findings and the two lifecycle findings are closed in this frozen
snapshot. `ops.jobs` is the single lease/fetch authority, with
`library_sync_state` retaining the account pointer and generation fence; the
job-kind/provider row check is present; `job_requests` and provider charges use
compound account/job foreign keys; the request path rechecks the profile after
its sync lock; claim uses an exact pointer/generation check before charging and
recovers expired leases; terminal claim persists `queue_acknowledged`; and the
lane advisory lock is taken before all PGMQ operations and account/sync/job
locks. The generic app quota wrapper is principal-free only for
profile/vanity/public lookup, rejects a fresh reservation after a principal is
set, and the raw worker helper is not granted to either runtime role. Manual
unverified profiles remain authorized for public library and pinned reads.

The final lifecycle checks are explicit: `publish_owned_snapshot` rejects both
pointer mismatch and any sync generation that is not exactly the job
generation (migration lines 2478–2484). `renew_job_lease` and `retry_job` take
the sync fence under the lane lock, require that same exact pointer/generation,
and require an active authorized profile before extending the lease/charge or
mutating retry state (lines 1560–1585 and 1720–1745). They also bind the
charged attempt to the current stored provider subject. The adversarial fixture
advances and rewinds a leased job's generation and changes its active profile;
publish and retry return `stale`, while renew returns `ok = false`
(`database/v2/tests/m2_adversarial.sql`, lines 681–781). The pointer condition
also rejects a cleared or replaced pointer through the same `IS DISTINCT FROM`
check. No actionable issue remains in these changed paths.

`database/v2/M2-checkpoint.md` records the final rollback fixture, adversarial
fixture, two-connection concurrency harness, 10,000-game SQL benchmark, fresh
rebuild, and security/ACL evidence as passing. Background
pinned/recent/Store/SteamSpy adapters are an intentional M6 deferral, not an
M2 SQL blocker. No target or production database was changed by this review.

## 7. Future repository authorization dependency

This is the later M4 repository boundary. M1 only establishes and tests the
database-side principal setting and fail-closed policies with synthetic
fixtures; it does not require the runtime repository or page contracts to exist.

Every private request follows this shape:

```text
cookie -> HMAC digest + expected kind -> resolve_session
       -> principal(account_id, session_kind)
       -> optional private profile/public-id follow-up
       -> transaction-local app.account_id -> RLS + explicit account predicates
       -> narrow DTO projection -> route response
```

The repository is server-only (`import "server-only"`). Server Components may
call it directly; route handlers validate and delegate. The application must
use the bounded Supavisor transaction-pool contract (`prepare: false`, small
pool) and must not assume session settings, prepared statements, or advisory
locks persist across pooled requests. A transaction must establish and use
`set_config('app.account_id', ..., true)` before tenant queries. Keep explicit
account predicates in repository SQL as a second guard.

The runtime role is a non-owner, non-BYPASSRLS `vault_app` group role. Worker
access is a separate `vault_worker` role. Neither role receives session-table
blanket access or service-role superuser privileges. Public/anon/authenticated
browser roles must not read v2 domain schemas directly.

## 8. M1 foundational schema and security handoff

The database agent owns the executable SQL under `database/v2/**`. This section
records the application-facing obligations and review boundary; it is not a
second physical-schema design. M1 is the reproducible relational foundation and
session/RLS security gate. It does not include later data-parity or product-flow
claims.

Before M1 can be called complete, the database work must demonstrate:

1. **Private schema and exposure boundary.**
   [`database/v2/supabase/config.toml`](../database/v2/supabase/config.toml)
   exposes only `public`. That is intentional and correct for keeping the v2
   `app`, `catalog`, `reco`, `ops`, and `migration` schemas out of the browser
   Data API; `app` and `catalog` do not need to be added to the exposed-schema
   list. Verify that `PUBLIC`, `anon`, and `authenticated` have no v2 schema,
   table, sequence, or function access, while `vault_app` and `vault_worker`
   receive only explicit runtime grants. Session, intent, merge, and migration
   data remain private.
2. **Account and session foundation.** Add the internal integer account key,
   unique preserved UUID public ID, `manual`/`steam` account-kind relationship,
   lifecycle/revision timestamps, and the profile relation that distinguishes a
   verified Steam identity from duplicate unverified manual Steam IDs. Include
   capability visibility with an unknown state and bounded preference storage.
   Add unified sessions with a bigint identity, account FK, unique 32-byte
   digest, `manual`/`verified_steam` kind, expiry, revocation, and the indexes
   needed for account and expiry lookups. No raw token or secret belongs in the
   schema or fixtures.
3. **Minimal resolver boundary.** Implement the private resolver described in
   section 3.2. It matches the digest and server-derived expected kind, checks
   expiry using the database clock, revocation, active account linkage, and
   verified-profile consistency, and returns only the minimum principal needed
   to set tenant context. Public UUID and profile fields can be read in a
   separate authorized follow-up. The application-level 365-day manual sliding
   refresh and fixed 30-day verified lifetime remain compatibility requirements;
   their end-to-end behavior is a later application gate.
4. **Principal/RLS bridge.** Define the transaction-local principal mechanism,
   fail-closed policies using both `USING` and `WITH CHECK`, compound tenant FKs,
   and explicit grants for `vault_app`/`vault_worker`. Exercise missing context,
   failed transactions, pooled-connection reuse, and cross-account reads/writes
   with synthetic fixtures.
5. **Clean replay and SQL evidence.** Apply the independent chain to a clean
   PostgreSQL 17/Supabase target and run meaningful foundation fixtures for
   constraints, resolver digest/kind/expiry/revocation behavior, account-kind
   checks, tenant policy failures, rollback, and retry behavior. A schema apply
   or smoke RPC alone is insufficient evidence.

M1 does not require the actual promotion/merge journey, real-data account or
AppID mappings, a private preview with returning users, the runtime repository,
the session DTO, or the bounded bootstrap/page contracts. Those belong to later
gates: M3 owns source export, deterministic mappings and real-data parity; M4
owns the server-only repository, session DTO, bootstrap and bounded page access;
M5 owns OpenID promotion/merge and full product parity. Import normalization
belongs to M2.

## 9. Milestone handoff and acceptance checks

Keep the following checks attached to the milestone that can actually prove them:

- **M1 foundation:** A clean replay leaves v2 domain schemas private from the
  browser. Synthetic resolver fixtures prove digest plus expected-kind matching,
  database-clock expiry, revocation and verified-profile consistency. RLS and
  explicit grants fail closed without a transaction-local principal, and no
  secret or raw digest appears in SQL or test output.
- **M3 preserved data:** A consistent private export and rehearsal preserve
  account UUIDs, session digest compatibility, profile identity distinctions,
  library/state/history facts and deterministic mappings with no unexplained
  dropped private records.
- **M4 application access:** Returning verified and manual fixture cookies resolve
  to their preserved public UUIDs with the correct identity flag. The manual
  prefix/HMAC and cookie attributes remain compatible; verified expiry stays
  fixed at 30 days while manual expiry slides to 365 days after a throttled
  refresh. Required lookup failures produce retryable 503 responses; only a
  confirmed absent/expired/revoked session reaches the existing 401/guest path.
  The bootstrap is small and session-safe, and Library, dashboard, detail,
  collection, family, draw and optional feature queries are bounded with explicit
  revision/cache behavior. No route-level `preferredRegion` export is added.
- **M5 product parity:** Duplicate unverified workspaces using one Steam ID remain
  possible, while verified Steam identity stays unique under concurrent login and
  promotion. Promotion is bound to the exact manual session and single-use
  intent, validates OpenID and nonce, and either promotes in place or merges
  atomically without granting old manual credentials verified authority.

Until the M1 foundation checks pass, M1 remains in progress. Passing M1 alone
does not claim M3 data parity or M4/M5 session, bootstrap, authentication, and
product parity.
