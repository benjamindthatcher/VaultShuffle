/**
 * Database boundaries for the game domain.
 *
 * `user_games` is the mutable per-account record. `user_games_with_catalog`
 * is the read model that overlays the single canonical Steam catalogue row.
 */
export const USER_GAMES_TABLE = "user_games";
export const USER_GAMES_READ_MODEL = "user_games_with_catalog";
