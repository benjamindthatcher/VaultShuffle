# Library analytics

Active bulk Blacklist and Complete emit the existing confirmed status event for each saved game, with `surface: selection`, `bulk: true`, `batch_size`, and action `bulk_blacklist` or `bulk_complete`. Completion claims follow successful writes. Batch Undo carries the same bulk context; partial failures retain Undo for the games that saved successfully. No additional aggregate status event is emitted, so game counts are not doubled.

Library uses the existing consent-aware PostHog client. SiteExperience owns route pageviews, so Library does not emit a duplicate `$pageview`. Shared client properties identify guest versus account activity.

| Event | Meaning |
| --- | --- |
| `library_interaction`, action `details_opened` | A normal catalogue card or Playing Next game opened details. Includes game ID, shelf, surface and view mode. |
| `library_interaction`, action `selection_toggled` | The user entered or exited explicit selection mode. Includes enabled state and view mode. |
| `library_interaction`, action `replacement_opened` | Adding a game required choosing which Playing Next game to replace. This is intent, not a successful addition. |
| `library_interaction`, action `undo` | Undo was requested. Includes the original action and game ID; persistence outcomes are emitted separately. |
| `game_status_changed` | The shared provider confirmed a status change. Includes Library source, action and surface; Blacklisted is the public name for internal `Slept` status. |
| `playing_next_added`, `playing_next_removed`, `playing_next_replaced`, `playing_next_completed` | Confirmed commitment outcomes from the shared provider. See [Playing Next analytics](playing-next-analytics.md). |
| `game_mutation_failed` | Persistence failed. The shared queue reconciles the optimistic UI; a failed write does not emit a successful outcome. |

Existing completion claim/undo tracking remains after successful persistence. Normal and pinned details use the same device-aware Steam action: desktop launches Steam, while touch devices and guest previews open the store. `playing_next_game_launched` is emitted only for an actual client launch request for a game in Playing Next; store views and unpinned game launches are excluded.

Library interaction events do not contain search text or notes. Immediate UI updates and Undo remain independent of analytics availability or consent. Status and commitment outcome events are centralized in AppDataProvider to prevent duplicate capture across cards, details, and the replacement dialog.
