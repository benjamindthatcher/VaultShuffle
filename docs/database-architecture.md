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

- `games` retains the stable UUID used by collections, pins, purge reviews,
  and other user state.
- `games.catalog_steam_appid` references the shared `catalog_games` row.
- Ownership, lifecycle status, playtime, progress, notes, and lifecycle
  timestamps stay on `games`.
- Legacy title, genre, rating, quarantine, and duration columns are
  compatibility snapshots. New reads overlay canonical catalogue metadata.
  They can be dropped in a later migration after all deployed clients use the
  catalogue-backed read model.

## Bounded user state and history

- `user_game_pins` stores both `library` and `wishlist` scopes, with three
  slots per user and scope enforced by unique constraints.
- `user_game_snoozes` replaces an unbounded JSON array in `app_settings`.
- `user_vault_state` stores one current-pick row per user.
- `vault_draws` retains the latest 50 draws per user. `vault_draw_events`
  cascade when their parent draw is trimmed.
- `vault_events` and `purge_reviews` remain append-only audit sources. Retention
  must be introduced as an explicit product/data-retention decision rather
  than silently deleting existing history.

`app_settings` is reserved for genuine preferences, not collections of game
IDs or mutable domain state. Migrated compatibility keys are retained for one
release so a rollback does not lose state.

## Deployment order

1. Apply Supabase migrations, including
   `20260726043000_normalize_multi_user_state.sql`.
2. Deploy the matching application revision.
3. Run the Supabase security and performance advisors.
4. After one stable release, remove the compatibility snapshot columns and
   retire `steam_app_metadata` once its remaining refresh workflow has been
   fully folded into `catalog_games`.
