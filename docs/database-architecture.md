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
- `games` is a temporary backwards-compatible view for the deployment cutover.
  Current application code does not read or write through it.

## Bounded user state and history

- `user_game_pins` still accepts the retired `wishlist` scope so historical
  rows remain readable; the current product only creates `library` pins.
- `user_game_snoozes` replaces an unbounded JSON array in `app_settings`.
- `user_vault_state` stores one current-pick row per user.
- `vault_draws` retains the latest 50 draws per user. `vault_draw_events`
  cascade when their parent draw is trimmed.
- `vault_events` and `purge_reviews` remain append-only audit sources. Retention
  must be introduced as an explicit product/data-retention decision rather
  than silently deleting existing history.

`app_settings` is reserved for genuine preferences, not collections of game
IDs or mutable domain state. Compatibility keys are retained for one release
so a rollback does not lose state.

## Deployment order

1. Apply the reviewed database changes through the production Supabase project.
2. Deploy the matching application revision.
3. Run the Supabase security and performance advisors.
4. Remove the compatibility snapshots and the temporary `games` view after
   the matching application revision has passed live verification.
5. Retire `steam_app_metadata`; its useful values have already been merged into
   `catalog_games` and the application no longer reads its queue.
