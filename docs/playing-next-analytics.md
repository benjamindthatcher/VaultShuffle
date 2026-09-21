# Playing Next analytics

Playing Next continues using `user_game_pins` and the three existing slots. Browser events use the shared consent-aware PostHog client. Guest activity is marked by the existing `is_guest` and `data_scope` properties.

| Event | Meaning |
| --- | --- |
| `vault_play_now` | User accepted the result's Steam action. `launch_target` distinguishes `steam_client` from `steam_store`. |
| `vault_save_later` | User requested saving the current result. A full shelf may still need a replacement choice. |
| `vault_pick_another` | User drew again over the current recommendation. |
| `playing_next_added` | A new commitment was saved successfully. Includes source, game ID, Steam app ID, slot count, and draw ID when accepted from Vault. |
| `playing_next_replaced` | A confirmed addition displaced a commitment. Includes `replaced_game_id`; also emits `playing_next_added`. |
| `playing_next_removed` | A commitment was removed, including by blacklisting. Completion has its own event. |
| `playing_next_game_launched` | Steam client launch requested for a commitment. Store views are excluded. This is a launch attempt, not proof Steam opened or the game was played. |
| `playing_next_empty_slot_clicked` | Empty shelf spot led back to Vault. Includes slot count and slot number. |
| `playing_next_progressed` | At least 30 minutes of measured play since choosing, observed while visiting the app. Includes commitment timestamp and hours since choosing. |
| `playing_next_completed` | Completion persisted for a commitment, with hours since choosing and commitment timestamp where known. |
| `game_mutation_failed` | Persistence rejected a game/status/commitment change. Includes action, source and game ID. |

`vault_pick_launched` remains available for existing dashboards, but now only counts Steam client launch requests. Navigation events use sendBeacon with immediate sending. Pageviews remain owned by SiteExperience rather than being duplicated on each page.

Suggested funnel: `vault_draw_requested` → `vault_play_now` or `vault_save_later` → `playing_next_added` → `playing_next_game_launched` → `playing_next_progressed` → `playing_next_completed`. Segment store fallback by `launch_target` rather than treating it as a client launch. Analyse repeat launches of an existing commitment separately from newly accepted recommendations.

Progress is deduplicated per commitment per browser, using the game ID and chosen timestamp, with a capped local history. Clearing storage or using another device can produce a repeat progress observation; use person + game ID + chosen timestamp for cross-device deduplication. It is observed on return to the app, not a server-side record of the exact threshold crossing. Missing baselines and family-owner playtime are excluded. Existing commitments can qualify on their first visit after this event ships.

Successful writes emit after persistence; failure does not emit add/replace/complete success. Local optimistic changes remain instant; writes and undo are serialized, and failed queues refresh stored state. Re-adding after removal starts a new commitment under the existing pin API.
