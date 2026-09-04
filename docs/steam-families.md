# Steam Families

Games the player can play but does not own. Experimental, live, and killable
with one environment variable.
Family games run through the normal pipeline and appear in the normal places -
the feature is mostly about the three points where treating them identically to
owned games would make the app say something false.

## Why it needs its own machinery

Steam Families lets six accounts share one library, and it is the most-requested
thing VaultShuffle does not do. The obvious implementation — pull the shared
games in through the normal import — breaks three things quietly:

1. **Playtime is the owner's.** If a family member has 500 hours in Elden Ring,
   that says nothing about this account. `hours_played = 0` currently means
   "never played" and the product says so out loud, so `access_source` is what
   tells everything downstream that the 0 means "never told".
2. **Money is real.** Every value figure on the dashboard is denominated in
   currency. Nobody paid for a family game, so counting one inflates the number.
3. **Ownership is reconciled.** The import treats Steam's `GetOwnedGames` as
   authoritative and retires anything missing from it. Family games are never in
   that response.

`lib/family-sharing.ts` is the one place those rules live.

## How it works

The player adds up to five Steam profile URLs. VaultShuffle reads each public
owned-games list with its existing developer key, drops what the player already
owns, and keeps what Steam marks as shareable.

The eligibility test is real evidence rather than a guess. Steam publishes
family-sharing eligibility as a **store category**, the same one `category2=62`
searches on, and the catalogue already stores `catalog_games.categories` for the
player-mode filter. So a candidate lands in one of four buckets:

| Bucket | Meaning |
| --- | --- |
| `eligible` | Categories include `Family Sharing`. Imported. |
| `not_shareable` | Categories are present and do not include it, or the catalogue has quarantined the AppID. |
| `free` | Free-to-play. Nobody needs a family to play it. |
| `unknown` | The catalogue has not fetched categories yet. **Held, not refused.** |

`unknown` is the load-bearing one. The catalogue fills in lazily, so a member's
shelf always contains titles nothing is yet known about. Calling those ineligible
would silently drop real games. They are counted out loud ("51 still being
checked"), and the whole candidate list is stored on the member row so the
re-check is a catalogue question rather than another six reads of Steam.

Only the games actually joining the library are pushed into the priority ingest
queue. The unjudged candidates exist as deliberately-stale catalogue stubs and
are left to the nightly sweep — queueing thousands of games nobody owns at import
priority would spend the Steam Store budget, and the Fluid CPU behind it, on
somebody else's shelf while real owned games waited.

## The tier that was dropped

Steam's own `IFamilyGroupsService/GetSharedLibraryApps` returns exactly what an
account can play, with owner IDs, copy counts and Valve's own exclusion reasons.
It was built and then removed.

It is authorised by the player's Steam Store session token, not by our developer
key, and `api.steampowered.com` sends no CORS headers, so a page on our origin
cannot call it from the browser either. The only defensible shape was talking the
player through fetching a token themselves in a logged-in Steam tab and pasting
back the result — VaultShuffle never touching the credential.

That worked, and it still was not worth it: it is a support burden, it teaches
several hundred people to handle a Steam credential by hand, and it could not
have been verified before shipping without a real Steam family to test against.
The accuracy it bought did not cover that.

If it ever comes back, the shape to reach for is a browser extension that does
the fetch locally and posts a finished list — not a paste box. `access_source`
would gain a second family value and `user_games` would need a `playtime_known`
column, since exact data does carry the requesting account's own playtime.

## What is deliberately not stored

**Playtime, on any family row.** A family game's hours belong to whoever owns it,
and copying them across is the single worst failure available here — it would
tell someone they had 500 hours in a game they have never launched. So
`hours_played` stays 0 and `access_source` is what says that 0 means "never
told".

Nothing substitutes a label for it. A card with no playtime line reads better
than a card that says "No playtime data", and the details panel carries the one
sentence that explains it.

## How it shows up

Family games run through the normal pipeline and appear in the normal places.
They are not a second class of object — but they are always identified, because
a shared game that looks owned is one the player will be surprised by later:
either it vanishes when a family member leaves, or the app tells them they have
never played something they have eighty hours in.

**The mark is everywhere a game is drawn.** `components/shared/FamilyMark`
exports `FamilyGameMark`, which decides for itself whether a game qualifies, so
no surface carries the rule. It appears on: the library grid and list, both
variants of the details panel, the Vault's pick and its deck, the pinned shelf
and the pin picker, draw history (list and detail), collections and their
thumbnails, the add-games dialog, the finished shelf, the completion
celebration, and the dashboard tiles.

That completeness is the point rather than thoroughness for its own sake. A mark
on some surfaces and not others is worse than none: people learn to read its
absence as "this one is mine", which is exactly backwards.

**Where there is room for words:**

- Details panel: "Shared from Sam's Steam library. Playtime is theirs, so none
  is shown here."
- The Vault draw gets its own insight, with its own icon, on **every** draw
  regardless of goal — "From Draygo's library". It was previously buried in the
  Something New branch, and the sentence overran the one-line clamp every insight
  detail uses, so it arrived cut off mid-word.
- The Family library card shows the real mark inline as a legend, so somebody
  meets the icon before their library fills with games wearing it.

**Where numbers would be lies:**

- Playtime and story progress go blank rather than reading `0h` / `0%` /
  "Fresh pick".
- A **pinned** family game gets a third dial state. Pin progress is inferred from
  playtime, so both the story bar and the run split are built from a zero that
  means "never told" — the first version showed a 0% dial and "No play since
  pinning" directly under the words "Playtime (all time): Not available". It now
  draws an empty dashed ring carrying the family mark, labelled "Family game ·
  From Draygo", and reads "Playtime not tracked" to a screen reader. Marking one
  complete still earns the full dial, because that is the player stating a fact
  rather than the app inferring one.
- Excluded from every value and money figure, with the gap named on the
  dashboard's "Games completed" card rather than left to be noticed.

**Where they are treated exactly like owned games:**

- **Included** in the Vault's Something New goal. Their playtime is unknown
  rather than zero, so strictly we cannot prove one is unplayed — but a game off
  somebody else's shelf is usually the most genuinely new thing in the library,
  and excluding the unknown would cut the best content out of the one mode built
  for it.
- A `Library` group in the global filters — All / Only mine / Family only —
  which appears only once there are family games to filter.

## Rollout state

**Live.** The schema change was applied to production on 2026-09-02, statement by
statement against the captured live definitions rather than via `supabase db
push` (production has drifted from `supabase/migrations`). What was applied:

- `user_games.access_source` (default `'owned'`, check-constrained), plus
  `family_owner_steam_id` and `family_verified_at`. All 319,284 existing rows
  came out `owned`.
- `user_family_members`, with RLS, the five-member trigger, and service-role
  grants only.
- `upsert_user_family_games` and `remove_user_family_member_games`.
- `user_games_with_catalog` rebuilt **from the live definition** with three
  columns appended, so nothing reordered. Grants survived.
- `notify pgrst, 'reload schema'` afterwards, then verified through PostgREST
  rather than assumed — this project has been bitten by a stale schema cache
  silently no-opping `rpc()` before.

Verified against production data, inside rolled-back transactions:

- The RPC writes family rows for a real account.
- **A family sync cannot touch a game you own.** An owned row given to
  `upsert_user_family_games` stayed `owned`, kept its playtime and its status,
  and gained no family owner.

`NEXT_PUBLIC_FAMILY_SHARING=0` in Vercel plus a redeploy removes every surface
and 404s every route. It does not undo the schema, and does not need to: the
column defaults to `owned` and the Steam import filters on it, so an account
that never uses the feature behaves exactly as before.

### How well the eligibility test can actually answer

Measured against the live catalogue on 2026-09-02:

| | |
| --- | --- |
| Catalogue rows | 25,907 |
| With Steam categories (so judgeable) | 22,494 — **86.8%** |
| Of those, carrying `Family Sharing` | 20,746 — **92.2%** |

So the `unknown` bucket is small for anything the catalogue already knows, and
the great majority of what it can judge comes back shareable. A first add should
read like "480 look shareable, 78 still being checked", not the other way round.

The caveat is games the catalogue has never seen at all: those are stubbed on the
spot with no categories, so they land in `pending` until the nightly sweep
enriches them. A family member with an unusually obscure library will therefore
see a bigger "still being checked" number on the first pass than these figures
suggest, and the re-check button is what resolves it.

### Not yet exercised end to end

Every environment variable lives in Vercel, so nothing signed-in runs on the dev
machine. The domain logic and filters are unit tested, and the two RPCs have been
exercised against production inside rolled-back transactions. Still unexecuted:
the Steam profile lookup, the catalogue eligibility pass over a real shelf, and
the rendered card. The first family member added will be the first time those run.
