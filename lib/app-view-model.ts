import { gameProgress, isEndlessGame } from "@/lib/game-classification";
import { describeRecency, UNKNOWN_RECENCY } from "@/lib/recency";
import { sessionabilityScore } from "@/lib/sessionability";
import { splitGenres, steamTagGenreLabels, steamTagLabels, topLevelGenresFor } from "@/lib/genres";
import { steamCapsuleLargeImage, steamHeaderImage } from "@/lib/steam-images";
import type { Collection, CollectionGame, Game, SessionPayload } from "@/lib/types";
import type { DemoCollection, DemoGame } from "@/lib/demo-data";
import type { CollectionMembership } from "@/lib/collections";
import { collectionBanner } from "@/lib/vaultshuffle-assets";
import { deriveMoodScores, deriveSessionFits, moodTagsFromScores } from "@/lib/vault-matching";
import { matchesSmartPreset } from "@/lib/smart-collections";

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

export function buildCollectionDetails(
  collections: Collection[],
  games: Game[],
  memberships: CollectionMembership[]
): CollectionDetailPayload[] {
  const gameById = new Map(games.map((game) => [game.id, game]));
  const membershipsByCollection = new Map<string, CollectionMembership[]>();

  for (const membership of memberships) {
    const current = membershipsByCollection.get(membership.collection_id) ?? [];
    current.push(membership);
    membershipsByCollection.set(membership.collection_id, current);
  }

  return collections.map((collection) => {
    if (collection.kind === "smart") {
      const preset = collection.rules?.preset;
      const matchedGames = preset
        ? games.filter((game) => matchesSmartPreset(game, preset))
        : [];

      return {
        collection: { ...collection, game_count: matchedGames.length },
        games: matchedGames.map((game, position) => ({
          collection_id: collection.id,
          game_id: game.id,
          notes: null,
          position,
          created_at: collection.created_at,
          game
        }))
      };
    }

    const collectionMemberships = membershipsByCollection.get(collection.id) ?? [];
    return {
      collection: { ...collection, game_count: collectionMemberships.length },
      games: collectionMemberships.flatMap((membership) => {
        const game = gameById.get(membership.game_id);
        return game ? [{ ...membership, game }] : [];
      })
    };
  });
}

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
      (firstGame?.steam_appid ? steamHeaderImage(firstGame.steam_appid) : firstGame?.header_url) ||
      "/assets/vault/vault-stage-open.png";

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
    const recency = describeRecency({
      lastObservedPlayedAt: game.last_observed_played_at,
      recencySource: game.recency_source,
      recencyEvidenceAt: game.recency_evidence_at
    });
    const sourceTags = steamTagLabels(game.steam_tags);
    const sessionabilityValue = sessionabilityScore([...splitGenres(game.genre), ...sourceTags]);
    const moodScores = deriveMoodScores([
      ...splitGenres(game.genre),
      ...topLevelGenresFor(game.genre, game.title),
      ...sourceTags
    ]);
    return {
      id: game.id,
      title: game.title,
      steamAppId: Number(game.steam_appid || 753640),
      ownership: game.ownership,
      status: game.status === "Sampled" ? "In Progress" : game.status,
      hoursPlayed: Number(game.hours_played || 0),
      completionPercent: gameProgress(game),
      priority: normalisePriority(game.priority),
      genres,
      // Steam's own synopsis, which the catalogue has always had for ~99% of
      // owned games. Notes are the player's private annotation and are kept
      // separate: using them here meant writing one note silently replaced the
      // game's description everywhere it appeared, and the fallback line spent a
      // whole paragraph on the result screen restating the genres shown beside it.
      description:
        game.short_description?.trim() ||
        `${genres.slice(0, 2).join(" / ")} pick from your live VaultShuffle library.`,
      notes: game.notes || "",
      artworkUrl: game.steam_appid
        ? steamCapsuleLargeImage(game.steam_appid)
        : game.capsule_url || "/assets/vault/vault-stage-open.png",
      bannerUrl: game.steam_appid
        ? steamHeaderImage(game.steam_appid)
        : game.header_url || "/assets/vault/vault-stage-open.png",
      // "Not played recently" used to be printed whenever Steam withheld a
      // timestamp, which is most accounts - stating as fact something we had no
      // evidence for. An unknown game now says nothing at all.
      lastPlayedLabel: recency.label ?? (game.last_played_at ? formatDateLabel(game.last_played_at) : ""),
      lastPlayedAt: game.last_played_at,
      recency,
      reviewRequested: Boolean(game.review_requested_at),
      addedLabel: game.date_added ? `Added ${game.date_added}` : "Added recently",
      dateAdded: game.date_added,
      collectionIds: collectionIdsByGameId.get(game.id) ?? [],
      sessionability: sessionabilityValue,
      sessionFit: deriveSessionFits({
        duration: {
          mainStoryMinutes: game.main_story_minutes,
          mainExtrasMinutes: game.main_extras_minutes,
          completionistMinutes: game.completionist_minutes,
          endless: isEndlessGame(game)
        },
        completionPercent: gameProgress(game),
        endless: isEndlessGame(game),
        sessionability: sessionabilityValue
      }),
      priceInitial: game.price_initial ?? null,
      priceFinal: game.price_final ?? null,
      isFree: game.is_free ?? null,
      reviewPositive: game.review_positive ?? null,
      reviewNegative: game.review_negative ?? null,
      reviewTotal: game.review_total ?? null,
      durationStatus: game.duration_status ?? null,
      tagsStatus: game.tags_status ?? null,
      moodTags: moodTagsFromScores(moodScores),
      moodScores,
      completedAt: game.completed_at,
      previousActiveStatus: game.previous_active_status === "In Progress" ? "In Progress" : game.previous_active_status ? "Not Started" : null,
      sleptAt: game.slept_at,
      completionSuggestionDismissedAt: game.completion_suggestion_dismissed_at,
      completionSuggestionDismissedPlaytime: game.completion_suggestion_dismissed_playtime,
      platforms: {
        windows: game.platform_windows !== false,
        mac: Boolean(game.platform_mac),
        linux: Boolean(game.platform_linux)
      },
      deckCompatibility: game.deck_compatibility ?? null,
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

export function mapGuestGames(games: Game[]): DemoGame[] {
  const mapped = mapLiveGames(games, []);
  return mapped.map((game, index) => ({
    ...game,
    status: "Not Started",
    hoursPlayed: 0,
    completionPercent: 0,
    priority: "Medium",
    // Same reasoning as the live path: Steam's synopsis first, the generated
    // line only when the catalogue genuinely has nothing.
    description: games[index]?.short_description?.trim() || `${game.genres.slice(0, 2).join(" / ") || "Steam"} pick from the VaultShuffle guest catalogue.`,
    lastPlayedLabel: "Guest preview",
    recency: UNKNOWN_RECENCY,
    addedLabel: "Popular on Steam",
    collectionIds: []
  }));
}

export function guestPreviewCollection(gameCount: number): DemoCollection[] {
  return [
    {
      id: "all",
      kind: "system",
      name: "Guest Catalogue",
      description: `${gameCount} popular and iconic Steam games available for preview draws.`,
      artworkUrl: "/assets/vault/vault-stage-open.png",
      accent: "Sign in to replace this pool with your own Steam library."
    },
    {
      id: "guest-catalogue-sampler",
      kind: "smart",
      name: "Catalogue Sampler",
      description: "A broad shelf from the guest catalogue, ready even when richer metadata is still loading.",
      artworkUrl: collectionBanner("Guest Catalogue") || "/assets/vault/vault-stage-open.png",
      accent: "A dependable preview shelf built from active catalogue games.",
      smartPreset: "untouched"
    },
    {
      id: "guest-quick-wins",
      kind: "smart",
      name: "Quick Wins",
      description: "Shorter games from the guest catalogue that fit into eight hours or less.",
      artworkUrl: collectionBanner("Quick Wins") || "/assets/vault/vault-stage-open.png",
      accent: "A live preview built from catalogue duration data.",
      smartPreset: "quick-wins"
    },
    {
      id: "guest-long-hauls",
      kind: "smart",
      name: "Long Hauls",
      description: "Bigger commitments with an estimated main path of forty hours or more.",
      artworkUrl: collectionBanner("Long Hauls") || "/assets/vault/vault-stage-open.png",
      accent: "A live preview built from catalogue duration data.",
      smartPreset: "long-haul"
    },
    {
      id: "guest-endless-rotation",
      kind: "smart",
      name: "Endless Rotation",
      description: "Replayable games and ongoing worlds without a conventional finish line.",
      artworkUrl: collectionBanner("Endless Rotation") || "/assets/vault/vault-stage-open.png",
      accent: "A live preview built from catalogue classification data.",
      smartPreset: "endless-rotation"
    }
  ];
}

function normaliseGenres(game: Game) {
  const canonical = splitGenres(game.genre);
  const steamTags = steamTagGenreLabels(game.steam_tags, 8);
  const topLevel = topLevelGenresFor([...canonical, ...steamTags].join(" / "), game.title);
  const tags = [...topLevel, ...canonical, ...steamTags].filter(Boolean);
  return splitGenres(tags.join(" / ")).slice(0, 8);
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
