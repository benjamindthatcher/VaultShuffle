import { gameProgress, isEndlessGame } from "@/lib/game-classification";
import { splitGenres, topLevelGenresFor } from "@/lib/genres";
import { steamCapsuleLargeImage, steamHeaderImage } from "@/lib/steam-images";
import type { Collection, CollectionGame, Game, SessionPayload } from "@/lib/types";
import type { DemoCollection, DemoGame } from "@/lib/demo-data";
import { collectionBanner } from "@/lib/vaultshuffle-assets";
import { deriveMoodScores, deriveSessionFits, moodTagsFromScores } from "@/lib/vault-matching";

export type CollectionDetailPayload = {
  collection: Collection;
  games: CollectionGame[];
};

export const guestSession: SessionPayload = {
  logged_in: false,
  user_id: "",
  steam_id: "",
  display_name: "Guest",
  avatar_url: "",
  has_steam_key: false
};

export function mapLiveCollections(details: CollectionDetailPayload[]): DemoCollection[] {
  const allCollection: DemoCollection = {
    id: "all",
    kind: "system",
    name: "Entire Vault",
    description: "All owned games currently eligible for tonight's draw.",
    artworkUrl: "/assets/vault/vault-stage-open.png",
    accent: "Everything in your owned library."
  };

  const mapped = details.map(({ collection, games }) => {
    const firstGame = games[0]?.game;
    const artworkUrl = collectionBanner(collection.name) ||
      firstGame?.header_url ||
      (firstGame?.steam_appid ? steamHeaderImage(firstGame.steam_appid) : "/assets/vault/vault-stage-open.png");

    return {
      id: collection.id,
      kind: collection.kind,
      name: collection.name,
      description: collection.description || (collection.kind === "smart"
        ? "Automatically updated from your live VaultShuffle library."
        : "Custom collection from your live VaultShuffle library."),
      artworkUrl,
      accent: `${games.length} game${games.length === 1 ? "" : "s"} currently assigned.`,
      smartPreset: collection.rules?.preset
    };
  });

  return [allCollection, ...mapped];
}

export function mapLiveGames(games: Game[], details: CollectionDetailPayload[]): DemoGame[] {
  const collectionIdsByGameId = new Map<string, string[]>();

  for (const detail of details) {
    for (const item of detail.games) {
      const current = collectionIdsByGameId.get(item.game_id) ?? [];
      current.push(detail.collection.id);
      collectionIdsByGameId.set(item.game_id, current);
    }
  }

  return games.map((game) => {
    const genres = normaliseGenres(game);
    const moodScores = deriveMoodScores([
      ...splitGenres(game.genre),
      ...topLevelGenresFor(game.genre, game.title)
    ]);
    return {
      id: game.id,
      title: game.title,
      steamAppId: Number(game.steam_appid || 753640),
      ownership: game.ownership,
      status: game.status === "Sampled" ? "In Progress" : game.status,
      hoursPlayed: Number(game.hours_played || 0),
      completionPercent: game.status === "Completed"
        ? Number(game.completion_percentage || 0)
        : gameProgress(game),
      priority: normalisePriority(game.priority),
      genres,
      description:
        game.notes?.trim() ||
        `${genres.slice(0, 2).join(" / ")} pick from your live VaultShuffle library.`,
      notes: game.notes || "",
      artworkUrl: game.capsule_url || steamCapsuleLargeImage(game.steam_appid || 753640),
      bannerUrl: game.header_url || steamHeaderImage(game.steam_appid || 753640),
      lastPlayedLabel: game.last_played_at ? formatDateLabel(game.last_played_at) : "Not played recently",
      lastPlayedAt: game.last_played_at,
      addedLabel: game.date_added ? `Added ${game.date_added}` : "Added recently",
      dateAdded: game.date_added,
      salePrice: formatSteamPrice(game.price_final, game.price_currency, game.is_free),
      saleOriginalPrice: Number(game.discount_percent || 0) > 0
        ? formatSteamPrice(game.price_initial, game.price_currency, false)
        : undefined,
      saleDiscount: Number(game.discount_percent || 0) > 0 ? `-${game.discount_percent}%` : undefined,
      collectionIds: collectionIdsByGameId.get(game.id) ?? [],
      sessionFit: deriveSessionFits({
        duration: {
          mainStoryMinutes: game.main_story_minutes,
          mainExtrasMinutes: game.main_extras_minutes,
          completionistMinutes: game.completionist_minutes,
          endless: isEndlessGame(game)
        },
        completionPercent: gameProgress(game),
        endless: isEndlessGame(game)
      }),
      moodTags: moodTagsFromScores(moodScores),
      moodScores,
      completedAt: game.completed_at,
      previousActiveStatus: game.previous_active_status === "In Progress" ? "In Progress" : game.previous_active_status ? "Not Started" : null,
      sleptAt: game.slept_at,
      completionSuggestionDismissedAt: game.completion_suggestion_dismissed_at,
      completionSuggestionDismissedPlaytime: game.completion_suggestion_dismissed_playtime,
      duration: {
        mainStoryMinutes: game.main_story_minutes,
        mainExtrasMinutes: game.main_extras_minutes,
        completionistMinutes: game.completionist_minutes,
        source: game.duration_source,
        sourceUpdatedAt: game.duration_source_updated_at,
        confidence: game.duration_confidence,
        endless: isEndlessGame(game)
      }
    };
  });
}

function formatSteamPrice(amount: number | null | undefined, currency: string | null | undefined, isFree = false) {
  if (isFree) return "Free";
  if (amount == null || currency !== "USD") return undefined;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount / 100);
}

function normaliseGenres(game: Game) {
  const split = splitGenres(game.genre);
  const topLevel = topLevelGenresFor(game.genre, game.title);
  const tags = [...topLevel, ...split].filter(Boolean);
  return Array.from(new Set(tags)).slice(0, 4);
}

function normalisePriority(gamePriority: Game["priority"]): DemoGame["priority"] {
  if (gamePriority === "Must Play" || gamePriority === "High") return gamePriority;
  return "Medium";
}

function formatDateLabel(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
