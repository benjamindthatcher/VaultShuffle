import { lengthBucket } from "@/lib/game-classification";
import type { DemoGame } from "@/lib/demo-data";
import type { Game, SmartCollectionPreset } from "@/lib/types";

export const smartCollectionPresets: Array<{ id: SmartCollectionPreset; label: string; description: string }> = [
  { id: "backlog", label: "Backlog", description: "Owned games you have not started." },
  { id: "in-progress", label: "In Progress", description: "Games you are actively playing." },
  { id: "must-play", label: "Must Play", description: "Your highest-priority owned games." },
  { id: "short", label: "Short Sessions", description: "Games suited to shorter sessions." },
  { id: "unplayed", label: "Unplayed", description: "Owned games with no recorded playtime." }
];

export function matchesSmartPreset(game: Game | DemoGame, preset: SmartCollectionPreset) {
  const ownership = "ownership" in game ? game.ownership : "Owned";
  if (ownership !== "Owned") return false;

  const status = game.status;
  const hours = "hoursPlayed" in game ? game.hoursPlayed : Number(game.hours_played || 0);
  if (preset === "backlog") return status === "Not Started";
  if (preset === "in-progress") return status === "In Progress" || status === "Sampled";
  if (preset === "must-play") return game.priority === "Must Play";
  if (preset === "unplayed") return hours === 0;
  if ("sessionFit" in game) return game.sessionFit.includes("short");
  return ["Bitesize", "Short", "Endless"].includes(lengthBucket(game));
}
