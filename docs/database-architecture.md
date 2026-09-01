# Database architecture

VaultShuffle separates shared game facts from user-specific state.

## Shared, AppID-keyed data

- `catalog_games` is the canonical Steam game record. Titles, genres, artwork,
  reviews, prices, quarantine classification, and duration estimates belong
  here and are stored once.
- `catalog_ingest_queue` and `game_duration_jobs` contain at most one current
  job per Steam AppID.
- `catalog_user_imports` is the private many-to-many import ledger. Its
  `(user_id, steam_appid)` primary key prevents duplicate ownership records
  across repeated syncs.

Metadata refreshes must update these shared tables only. They must never fan
out an update across every user's copy of the same Steam game.

## Per-user game data

- `user_games` is the mutable per-account boundary used by application writes.
  It is the physical **access** table and retains the stable UUID used by
  collections, pins, purge reviews, and other user state. It was the ownership
  table until Steam Families; `access_source` is what now says whether a row is
  owned outright (`owned`) or reachable through a family member's library
  (`family`). Every pre-existing row is `owned`.
- `user_games_with_catalog` is a read-only, security-invoker view that joins
  every ownership record to exactly one `catalog_games` row.
- The ownership record's catalogue foreign key references the shared
  `catalog_games` row.
- Ownership, lifecycle status, playtime, progress, notes, and lifecycle
  timestamps stay on `user_games`.
- `ownership` no longer means "owned". It means "on the shelf", and `Wishlist`
  is the tombstone every read model filters out. What the account actually paid
  for is `access_source = 'owned'`, and that is what the money and value figures
  in `lib/backlog-stats.ts` count.
- Family rows deliberately store no playtime. The owner's hours are never copied
  across, so `hours_played` stays 0 and `access_source = 'family'` is what says
  that 0 means "never told" rather than "never played". Anything about to make
  that claim must check first; see `lib/family-sharing.ts`.
- Shared title, genre, artwork, reviews, pricing, quarantine, and duration data
  never live on `user_games`; application reads receive them through
  `user_games_with_catalog`.

## Family access

- `user_family_members` holds up to five Steam profiles per account, capped by a
  trigger as well as by the API. `candidate_appids` stores each member's whole
  public library so a re-check is a catalogue question rather than another read
  of six Steam profiles.
- Two doors write to `user_games`, with different rules.
  `upsert_user_steam_games` owns the `owned` rows and treats Steam's
  GetOwnedGames response as authoritative. `upsert_user_family_games` owns the
  family rows and never modifies an `owned` one.
- The ownership sweep in `lib/steam-import-jobs.ts` is scoped to
  `access_source = 'owned'`. Without that filter every Steam refresh would retire
  the entire family shelf, because family games are never in GetOwnedGames.
- Losing access is not the same as deleting history. Removing a member, or a game
  dropping out of an exact sync, deletes untouched family rows but retires ones
  carrying a note or a Completed/Slept status, so the player's own record of
  having played something survives losing the ability to play it.

## Bounded user state and history

- `user_game_pins` still accepts the retired `wishlist` scope so historical
  rows remain readable; the current product only creates `library` pins.
- `user_game_snoozes` replaces an unbounded JSON array in `app_settings`.
- `user_vault_state` stores one current-pick row per user.
- `vault_draws` retains the latest 50 draws per user. `vault_draw_events`
  cascade when their parent draw is trimmed.
- `user_genre_preferences` is derived, not authored. The nightly
  `genre-preferences` worker rebuilds it wholesale from `vault_draw_events`; the
  application only ever reads it. Because it is downstream of `vault_draws`, the
  50-draw trim above is also the ceiling on what the recommender can learn from
  — see `docs/vault-recommender.md`.
- `vault_events` and `purge_reviews` remain append-only audit sources. Retention
  must be introduced as an explicit product/data-retention decision rather
  than silently deleting existing history.

`app_settings` is reserved for genuine preferences, not collections of game
IDs or mutable domain state. Compatibility keys are retained for one release
so a rollback does not lose state.

## Current production invariant

- Steam Families is **not applied to production**. Its migration
  (`20260901193000_share_a_family_library.sql`) is written down but unapplied,
  and every surface is gated behind `NEXT_PUBLIC_FAMILY_SHARING`, which is set
  in `.env.local` only. See `docs/steam-families.md`.
- There is no `games` compatibility object or `steam_app_metadata` table.
- `(user_id, catalog_steam_appid)` is unique and every ownership row has a
  valid catalogue foreign key.
- Steam refreshes upsert only ownership and per-user state. Catalogue and
  duration workers update shared AppID-keyed records once.
- The application service role has the minimum required table/view grants;
  browser roles have no direct access to private ownership data.
