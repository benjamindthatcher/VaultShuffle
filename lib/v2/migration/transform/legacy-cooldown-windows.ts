/** Existing caller windows, verified against current source callers on 1 October.
 * This is migration evidence, not a new runtime rate-limit configuration.
 * Unknown buckets must remain holds; never give every bucket one guessed expiry.
 */
export const LEGACY_COOLDOWN_WINDOWS: Readonly<Record<string, number>> = Object.freeze({
  authenticated_write: 60,
  pinned_playtime_account: 60,
  pinned_playtime_steam: 60,
  steam_first_import: 300,
  steam_library_refresh: 300,
  steam_import_batch: 300,
  wishlist_import: 300,
  wishlist_search: 300,
  wishlist_details: 300,
  steam_auth_callback: 600,
  feedback_submission: 600,
  manual_profile_lookup: 600,
  duration_queue_password: 900,
  contact_submission: 1800,
  family_library_recheck: 3600,
  family_member_add: 3600,
  manual_profile_create: 3600,
  steam_app_lookup: 3600,
  nightly_worker_daily: 86400,
});
