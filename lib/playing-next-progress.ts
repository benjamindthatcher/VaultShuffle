import type { DemoGame } from "./demo-data.ts";
import type { VaultPin } from "./vault-state.ts";
import { pinProgressHours } from "./completion-celebration.ts";

/** A half-hour of measured play, never a launch click or somebody else's family hours. */
export function playingNextProgress(game: DemoGame, pin: VaultPin) {
  const hours = pinProgressHours(game, pin);
  if (!pin.pinnedAt || hours === null || hours < 0.5) return null;
  return { game_id: game.id, steam_app_id: game.steamAppId, chosen_at: pin.pinnedAt, hours_since_choosing: hours, milestone_minutes: 30 };
}
