import { lengthBucket } from "@/lib/game-classification";
import { splitGenres, topLevelGenresFor } from "@/lib/genres";
import { steamCapsuleLargeImage, steamHeaderImage } from "@/lib/steam-images";
import type { Collection, CollectionGame, Game, SessionPayload } from "@/lib/types";
import type { DemoCollection, DemoGame, VaultMoodId, VaultSessionId } from "@/lib/demo-data";
import { collectionBanner } from "@/lib/vaultshuffle-assets";

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
    return {
      id: game.id,
      title: game.title,
      steamAppId: Number(game.steam_appid || 753640),
      ownership: game.ownership,
      status: game.status === "Sampled" ? "In Progress" : game.status,
      hoursPlayed: Number(game.hours_played || 0),
      completionPercent: game.status === "Completed"
        ? Number(game.completion_percentage || 0)
        : Math.min(99, Number(game.completion_percentage || 0)),
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
      sessionFit: deriveSessionFit(game),
      moodTags: deriveMoodTags(game, genres),
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
        userEstimateMinutes: game.user_estimate_minutes
      }
    };
  });
}

function formatSteamPrice(amount: number | null | undefined, currency: string | null | undefined, isFree = false) {
  if (isFree) return "Free";
  if (amount == null || !currency) return undefined;
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(amount / 100);
  } catch {
    return `${currency} ${(amount / 100).toFixed(2)}`;
  }
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

function deriveSessionFit(game: Game): VaultSessionId[] {
  const bucket = lengthBucket(game);
  if (bucket === "Bitesize" || bucket === "Short") return ["short", "evening"];
  if (bucket === "Weekend" || bucket === "Campaign") return ["evening", "weekend"];
  if (bucket === "Endless") return ["short", "evening", "weekend"];
  return ["weekend"];
}

function deriveMoodTags(game: Game, genres: string[]): VaultMoodId[] {
  const joined = `${game.title} ${genres.join(" ")} ${game.notes}`.toLowerCase();
  const moods = new Set<VaultMoodId>();

  if (/(cozy|sim|simulation|puzzle|casual|farm|relax|chill)/.test(joined)) moods.add("chill");
  if (/(action|shooter|souls|horror|roguelike|combat|intense)/.test(joined)) moods.add("intense");
  if (/(arcade|casual|cozy|sim|sandbox|roguelike)/.test(joined)) moods.add("brain-off");

  return [...moods];
}

function formatDateLabel(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
