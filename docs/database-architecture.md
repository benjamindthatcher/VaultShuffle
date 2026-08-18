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
  It is the physical ownership table and retains the stable UUID used by
  collections, pins, purge reviews, and other user state.
- `user_games_with_catalog` is a read-only, security-invoker view that joins
  every ownership record to exactly one `catalog_games` row.
- The ownership record's catalogue foreign key references the shared
  `catalog_games` row.
- Ownership, lifecycle status, playtime, progress, notes, and lifecycle
  timestamps stay on `user_games`.
- Shared title, genre, artwork, reviews, pricing, quarantine, and duration data
  never live on `user_games`; application reads receive them through
  `user_games_with_catalog`.

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

- There is no `games` compatibility object or `steam_app_metadata` table.
- `(user_id, catalog_steam_appid)` is unique and every ownership row has a
  valid catalogue foreign key.
- Steam refreshes upsert only ownership and per-user state. Catalogue and
  duration workers update shared AppID-keyed records once.
- The application service role has the minimum required table/view grants;
  browser roles have no direct access to private ownership data.
