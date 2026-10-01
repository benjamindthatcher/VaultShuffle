# Source schema delta — 29 September 2026

Read-only browser inspection of source `pfvblcopcmairdfeqdep`. No account, session or game rows exported. The completed schema inventory is `database/v2/source-schema-inventory-20260929.json` in the isolated reconciliation worktree. It records **46 relations / 502 columns / 218 constraints / 57 application functions / one scheduled job**, plus indexes, table/function ACLs, policies, triggers and public view definitions. Earlier `source-schema-metadata-20260929.json` is the narrower columns/policy-count snapshot, not the operational export inventory.

Inventory constraints use non-pretty rendering with `IntervalStyle=postgres`, matching the exporter. Row exports remain UTC/ISO; do not shift instants for source Ireland/target Virginia.

Compared with the September 9 inventory: 44 / 486 becomes **46 / 502**, with no removed relations/columns or changed existing column type/nullability/ordinal. Exact constraint changes below exclude the interval-rendering difference, which was corrected from a fresh read.

| Change | Migration consequence |
|---|---|
| New `user_wishlist`: user_id UUID, steam_appid bigint, source, added_at | Durable owner/AppID saves; preserve source and exact instant, including absent catalogue games. Local V2 migration/transform and real synthetic 46-domain load now pass. |
| New `wishlist_store_cache`: AppID/country, game JSON, check/expiry/retry and lease fields | Explicit rebuild-only disposition; never restart source refresh leases. Current country/price/TTL behaviour must still be integrated. |
| `catalog_games`: player_mode, store_tags_checked_at, store_tags_state | Add existing catalogue destinations/transforms; preserve Store tag precedence. Player mode permits `single`, `coop`, `multi`, or null. |
| `user_games_with_catalog`: player_mode | Recreate derived view from retained catalogue; no duplicated durable rows. |
| New `manual_steam_profiles_steam_id_key` | Current URL resumption relies on unique Steam profile identity; retain current authentication behaviour. |
| New `catalog_games_player_mode_check` | Preserve the current classification domain. |
| `vault_draw_events_event_type_check` adds `play_now_intent` | Extend target/transform acceptance additively; retain the explicit intent and current learning meaning. |

Both new source tables have RLS enabled, no public/anon/authenticated table grants, and explicit service-role access. `user_wishlist` has account cascade, positive unsigned AppID bounds, source enum and owner/AppID primary key. `wishlist_store_cache` has AppID bounds, the five supported countries and AppID/country primary key. Its refresh RPC is security invoker and service-role-only. No production security changes were made.

Current source has `create_or_resume_manual_profile_session` (service-role-only, security definer). The old promotion/security-intent functions still exist; the local retirement migration is not yet applied. Keep retired promotion out of V2 runtime; coordinate its source/runtime release separately.

**Both live duration reconcilers still contain IGDB logic.** Local HLTB tooling cleanup has not changed that resolver. The next HLTB-only batch must remove provider rows/projections/obsolete retry provenance explicitly, retain human overrides and reviewed HLTB identities, and preserve confidence/identity/coherence rules. Do not treat estimates as accepted merely because their provider is HLTB.

Source functions `apply_user_vault_action`, `record_user_vault_draw` and their exact definitions/ACLs are recorded. The only scheduled job is active `api-rate-limit-cleanup`, schedule `23 * * * *`; command fingerprint is recorded instead of the raw command. No scheduled duration/metadata worker was listed. Do not infer external hosted schedules from pg_cron alone.

Target `vbjtbwelnhbbdfrqczyf` was resumed successfully. Fresh browser migration history lists only the five immutable September 6–12 migrations. None of the four prepared local migrations has been applied. Exact target marker/schema evidence, current-data export/load/parity, measured storage and current-app integration remain outstanding.

All schema reads ran in `BEGIN READ ONLY`. Browser download event capture was unreliable; the final inventory was saved from the visible SQL result in bounded DOM reads, then parsed and checked locally. No private browser state, network API workaround or credential search was used. Current browser audit query: `https://supabase.com/dashboard/project/pfvblcopcmairdfeqdep/sql/91512f73-2a20-4b75-815a-32e2cedebbc6` (the last query reads canonical constraints).

Full inventory SHA256: `991e99c1c106a6cb7bc62fef06b820bbc7966db95650cd1e7e1f6bc2e470af11`.
