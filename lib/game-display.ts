import { displayStatus, isCompletedGame } from "@/lib/game-classification";
import { genreDisplayLabel, primaryGenre as primaryTopLevelGenre } from "@/lib/genres";
import type { Game } from "@/lib/types";

export function statusClass(game: Game) {
  if (game.ownership === "Wishlist") return "wishlist";
  if (isCompletedGame(game)) return "completed";
  if (displayStatus(game) === "Sampled") return "sampled";
  if (displayStatus(game) === "In Progress") return "progress";
  return "";
}

export function statusIcon(game: Game) {
  if (isCompletedGame(game)) return "✓";
  if (displayStatus(game) === "Sampled") return "◐";
  if (displayStatus(game) === "In Progress") return "▶";
  return "↬";
}

export function primaryGenre(game: Game) {
  return primaryTopLevelGenre(game.genre, game.title);
}

export function displayGenres(game: Game) {
  return genreDisplayLabel(game.genre, game.title);
}

export function formatLastPlayed(value?: string | null) {
  if (!value) return "Never";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
