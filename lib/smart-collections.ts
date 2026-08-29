import { describeRecency, idleForAtLeast, playedWithin } from "./recency.ts";
import { FINISHED_RATIO } from "./completion-check.ts";

/**
 * The same line the completion sweep asks on, so "Nearly Finished" and "we think
 * you finished this" cannot drift apart. They were 65 and 80 independently, which
 * meant a game could sit in Nearly Finished for months without ever being asked.
 */
const NEARLY_FINISHED_PERCENT = Math.round(FINISHED_RATIO * 100);
import type { DemoGame } from "./demo-data.ts";
import { gameProgress } from "./game-classification.ts";
import { estimatedTimeToBeatMinutes } from "./game-duration.ts";
import type { Game, SmartCollectionPreset } from "./types.ts";

export const smartCollectionPresets: Array<{ id: SmartCollectionPreset; label: string; description: string }> = [
  { id: "nearly-finished", label: "Nearly Finished", description: "Finite games at 65–99% progress." },
  { id: "quick-wins", label: "Quick Wins", description: "Finite games with eight hours or less left." },
  { id: "recently-played", label: "Recently Played", description: "Games played during the last 30 days." },
  { id: "fallen-off", label: "Fallen Off", description: "Started games left untouched for six months." },
  { id: "long-haul", label: "Long Hauls", description: "Active games estimated at 40 hours or more." },
  { id: "endless-rotation", label: "Endless Rotation", description: "Replayable and live-service games without a finish line." },
  { id: "untouched", label: "Untouched", description: "Owned games with no recorded playtime." }
];

export function matchesSmartPreset(game: Game | DemoGame, preset: SmartCollectionPreset) {
  const ownership = "ownership" in game ? game.ownership : "Owned";
  if (ownership !== "Owned") return false;

  const status = game.status;
  const hours = "hoursPlayed" in game ? game.hoursPlayed : Number(game.hours_played || 0);
  const active = status !== "Slept" && status !== "Completed";
  const progress = "steamAppId" in game ? Number(game.completionPercent || 0) : gameProgress(game);
  const duration = durationDetails(game);
  // Both shelves used to read the exact Steam timestamp, which most accounts
  // never receive, so both sat empty for almost everyone. They now read whatever
  // evidence VaultShuffle actually holds - see lib/recency.ts.
  const recency = "steamAppId" in game
    ? game.recency
    : describeRecency(
        game.recency_source
          ? {
              lastObservedPlayedAt: game.last_observed_played_at,
              recencySource: game.recency_source,
              recencyEvidenceAt: game.recency_evidence_at
            }
          // A row written before the inference existed still has its exact
          // timestamp, and that remains perfectly good evidence.
          : game.last_played_at
            ? { lastObservedPlayedAt: game.last_played_at, recencySource: "steam_exact" }
            : null
      );

  if (preset === "nearly-finished") return active && !duration.endless && progress >= NEARLY_FINISHED_PERCENT && progress < 100;
  if (preset === "quick-wins") {
    if (!active || duration.endless || !duration.hours) return false;
    const remainingHours = Math.max(0, duration.hours - hours);
    return remainingHours > 0 && remainingHours <= 8;
  }
  if (preset === "recently-played") return active && hours > 0 && playedWithin(recency, 30);
  // Requires evidence: a game we have never observed has not "fallen off", it is
  // simply one we have not watched yet.
  if (preset === "fallen-off") return active && hours > 0 && idleForAtLeast(recency, 180);
  if (preset === "long-haul") {
    return active && !duration.endless && progress < 65 && Boolean(duration.hours && duration.hours >= 40);
  }
  if (preset === "endless-rotation") return active && duration.endless;
  if (preset === "untouched") return active && hours === 0;

  // Legacy rules remain supported so existing collections do not silently empty.
  if (preset === "backlog") return status === "Not Started";
  if (preset === "in-progress") return status === "In Progress" || status === "Sampled";
  if (preset === "must-play") return game.priority === "Must Play";
  if (preset === "unplayed") return hours === 0;
  return active && !duration.endless && Boolean(duration.hours && duration.hours <= 10);
}

export function editableSmartCollectionPreset(preset?: SmartCollectionPreset): SmartCollectionPreset {
  if (preset === "backlog" || preset === "unplayed") return "untouched";
  if (preset === "in-progress") return "recently-played";
  if (preset === "short") return "quick-wins";
  if (preset === "must-play") return "nearly-finished";
  return preset ?? "nearly-finished";
}

function durationDetails(game: Game | DemoGame) {
  if ("hoursPlayed" in game) {
    const minutes = estimatedTimeToBeatMinutes(game.duration);
    return { endless: Boolean(game.duration?.endless), hours: minutes ? minutes / 60 : null };
  }

  const minutes = estimatedTimeToBeatMinutes({
    mainStoryMinutes: game.main_story_minutes,
    mainExtrasMinutes: game.main_extras_minutes,
    completionistMinutes: game.completionist_minutes
  });
  return { endless: game.duration_kind === "endless", hours: minutes ? minutes / 60 : null };
}
