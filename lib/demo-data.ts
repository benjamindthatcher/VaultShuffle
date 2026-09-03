import { UNKNOWN_RECENCY, type GameRecency } from "./recency.ts";
import { steamCapsuleLargeImage, steamHeaderImage } from "@/lib/steam-images";
import { collectionBanner } from "@/lib/vaultshuffle-assets";

export type DemoOwnership = "Owned";
export type DemoStatus = "Not Started" | "In Progress" | "Slept" | "Completed";
export type VaultSessionId = "short" | "evening" | "weekend";
export type VaultMoodId = "chill" | "intense" | "brain-off";
export type VaultGoalId = "new" | "finish" | "surprise";

export type DemoCollection = {
  id: string;
  kind: "system" | "smart" | "custom";
  name: string;
  description: string;
  artworkUrl: string;
  accent: string;
  smartPreset?: import("@/lib/types").SmartCollectionPreset;
};

export type DemoGame = {
  id: string;
  title: string;
  steamAppId: number;
  ownership: DemoOwnership;
  status: DemoStatus;
  hoursPlayed: number;
  completionPercent: number;
  priority: "Medium" | "High" | "Must Play";
  genres: string[];
  description: string;
  notes?: string;
  artworkUrl: string;
  bannerUrl: string;
  lastPlayedLabel: string;
  lastPlayedAt?: string | null;
  /**
   * What we actually know about when this was last played. Read this rather than
   * lastPlayedAt, which only ever holds an exact Steam timestamp and is absent
   * for most users. See lib/recency.ts.
   */
  recency: GameRecency;
  /** The player asked for this one back in the Purge queue. */
  reviewRequested?: boolean;
  addedLabel: string;
  dateAdded?: string | null;
  collectionIds: string[];
  sessionFit: VaultSessionId[];
  /**
   * How self-contained a sitting is, -1 to 1. Computed from tags where the tags
   * are, since DemoGame does not carry them. See lib/sessionability.ts.
   */
  sessionability?: number;
  moodTags: VaultMoodId[];
  moodScores?: import("@/lib/vault-matching").VaultMoodScores;
  completedAt?: string | null;
  previousActiveStatus?: "Not Started" | "In Progress" | null;
  sleptAt?: string | null;
  completionSuggestionDismissedAt?: string | null;
  completionSuggestionDismissedPlaytime?: number | null;
  duration?: import("@/lib/types").GameDurationEstimate;
  platforms?: { windows: boolean; mac: boolean; linux: boolean };
  deckCompatibility?: number | null;
  /** Release day, for the release-age global filter. */
  releaseDate?: string | null;
  /** How this one can be played, from Steam's categories. See lib/global-filters.ts. */
  playerModes?: import("@/lib/global-filters").PlayerMode[];
  /** Steam review counts, used for the hype and hidden-gem terms. */
  /** Steam store prices, in cents, at whatever the catalogue last saw. */
  priceInitial?: number | null;
  priceFinal?: number | null;
  isFree?: boolean | null;
  reviewPositive?: number | null;
  reviewNegative?: number | null;
  reviewTotal?: number | null;
  /**
   * Which "never show me this" categories this game falls into, by id from
   * lib/exclusion-categories.ts. Computed on the server so the client never
   * needs the tag map. Absent means not yet computed, which excludes nothing.
   */
  exclusions?: string[];
  /** Where catalogue enrichment has got to, so "still processing" can mean it. */
  durationStatus?: string | null;
  tagsStatus?: string | null;
  /**
   * How this game is playable: owned outright, or reachable through a family
   * member's Steam library. Absent means owned - every game that predates the
   * feature is. Playtime is meaningless on a family row; see
   * lib/family-sharing.ts.
   */
  accessSource?: import("@/lib/family-sharing").AccessSource;
  familyOwnerName?: string | null;
  familyOwnerSteamId?: string | null;
};

export const demoCollections: DemoCollection[] = [
  {
    id: "all",
    kind: "system",
    name: "Entire Vault",
    description: "All owned games currently eligible for tonight's draw.",
    artworkUrl: "/assets/vault/vault-stage-open.png",
    accent: "Everything in your owned library."
  },
  {
    id: "cosmic-odyssey",
    kind: "custom",
    name: "Cosmic Odyssey",
    description: "Curated adventures across the stars, the void, and the strange unknown.",
    artworkUrl: collectionBanner("Cosmic Odyssey") || steamHeaderImage(753640),
    accent: "Sci-fi worlds and atmosphere-first journeys."
  },
  {
    id: "story-rich",
    kind: "smart",
    name: "Story Rich",
    description: "Unforgettable writing, heavy choices, and worlds worth disappearing into.",
    artworkUrl: collectionBanner("Story Rich") || steamHeaderImage(632470),
    accent: "Narrative-led picks for deeper sessions."
  },
  {
    id: "short-sweet",
    kind: "smart",
    name: "Short & Sweet",
    description: "High-payoff games that fit neatly into busy evenings.",
    artworkUrl: collectionBanner("Short & Sweet") || steamHeaderImage(383870),
    accent: "Faster wins without sacrificing vibe."
  },
  {
    id: "comfort-games",
    kind: "custom",
    name: "Comfort Games",
    description: "Reliable favourites for low-friction nights and soft landings.",
    artworkUrl: collectionBanner("Comfort Games") || steamHeaderImage(413150),
    accent: "Chill energy and familiar joy."
  }
];

const demoGameFixtures: Array<Omit<DemoGame, "recency">> = [
  {
    id: "cyberpunk-2077",
    duration: { mainStoryMinutes: 1500, mainExtrasMinutes: 3660 },
    title: "Cyberpunk 2077",
    steamAppId: 1091500,
    ownership: "Owned",
    status: "In Progress",
    hoursPlayed: 47,
    completionPercent: 58,
    priority: "High",
    genres: ["Action", "RPG", "Sci-Fi", "Open World"],
    description: "A neon-soaked open world with story threads worth settling into properly.",
    artworkUrl: steamCapsuleLargeImage(1091500),
    bannerUrl: steamHeaderImage(1091500),
    lastPlayedLabel: "2h ago",
    addedLabel: "Added 9 Jan, 2025",
    collectionIds: ["cosmic-odyssey", "story-rich"],
    sessionFit: ["evening", "weekend"],
    moodTags: ["intense"]
  },
  {
    id: "disco-elysium",
    duration: { mainStoryMinutes: 1260, mainExtrasMinutes: 1740 },
    title: "Disco Elysium",
    steamAppId: 632470,
    ownership: "Owned",
    status: "In Progress",
    hoursPlayed: 23,
    completionPercent: 34,
    priority: "Must Play",
    genres: ["RPG", "Narrative", "Adventure"],
    description: "Dense conversation, worldbuilding, and brilliant writing for story-led sessions.",
    artworkUrl: steamCapsuleLargeImage(632470),
    bannerUrl: steamHeaderImage(632470),
    lastPlayedLabel: "3d ago",
    addedLabel: "Added 18 Feb, 2025",
    collectionIds: ["story-rich"],
    sessionFit: ["evening", "weekend"],
    moodTags: ["chill"]
  },
  {
    id: "hades",
    duration: { mainStoryMinutes: 1260, mainExtrasMinutes: 2700 },
    title: "Hades",
    steamAppId: 1145360,
    ownership: "Owned",
    status: "Not Started",
    hoursPlayed: 0,
    completionPercent: 0,
    priority: "High",
    genres: ["Action", "Roguelike", "Fantasy"],
    description: "Fast, slick runs with a perfect one-more-go rhythm.",
    artworkUrl: steamCapsuleLargeImage(1145360),
    bannerUrl: steamHeaderImage(1145360),
    lastPlayedLabel: "New",
    addedLabel: "Added 3 Mar, 2025",
    collectionIds: ["short-sweet", "comfort-games"],
    sessionFit: ["short", "evening"],
    moodTags: ["intense", "brain-off"]
  },
  {
    id: "stardew-valley",
    duration: { endless: true },
    title: "Stardew Valley",
    steamAppId: 413150,
    ownership: "Owned",
    status: "Not Started",
    hoursPlayed: 0,
    completionPercent: 0,
    priority: "Medium",
    genres: ["Simulation", "Cozy", "RPG"],
    description: "A gentle comfort pick when you want momentum without pressure.",
    artworkUrl: steamCapsuleLargeImage(413150),
    bannerUrl: steamHeaderImage(413150),
    lastPlayedLabel: "New",
    addedLabel: "Added 27 Apr, 2025",
    collectionIds: ["comfort-games"],
    sessionFit: ["short", "evening", "weekend"],
    moodTags: ["chill", "brain-off"]
  },
  {
    id: "outer-wilds",
    duration: { mainStoryMinutes: 900, mainExtrasMinutes: 1320 },
    title: "Outer Wilds",
    steamAppId: 753640,
    ownership: "Owned",
    status: "Not Started",
    hoursPlayed: 0,
    completionPercent: 0,
    priority: "Must Play",
    genres: ["Adventure", "Narrative", "Sci-Fi"],
    description: "Curiosity-driven exploration with a huge payoff if you give it room.",
    artworkUrl: steamCapsuleLargeImage(753640),
    bannerUrl: steamHeaderImage(753640),
    lastPlayedLabel: "New",
    addedLabel: "Added 12 May, 2025",
    collectionIds: ["cosmic-odyssey", "story-rich"],
    sessionFit: ["evening", "weekend"],
    moodTags: ["chill"]
  },
  {
    id: "control",
    duration: { mainStoryMinutes: 690, mainExtrasMinutes: 1170 },
    title: "Control Ultimate Edition",
    steamAppId: 870780,
    ownership: "Owned",
    status: "Not Started",
    hoursPlayed: 0,
    completionPercent: 0,
    priority: "High",
    genres: ["Action", "Sci-Fi", "Adventure"],
    description: "A sleek supernatural shooter for nights when you want style and momentum.",
    artworkUrl: steamCapsuleLargeImage(870780),
    bannerUrl: steamHeaderImage(870780),
    lastPlayedLabel: "New",
    addedLabel: "Added 30 May, 2025",
    collectionIds: ["cosmic-odyssey"],
    sessionFit: ["evening", "weekend"],
    moodTags: ["intense"]
  },
  {
    id: "firewatch",
    duration: { mainStoryMinutes: 240, mainExtrasMinutes: 300 },
    title: "Firewatch",
    steamAppId: 383870,
    ownership: "Owned",
    status: "Not Started",
    hoursPlayed: 0,
    completionPercent: 0,
    priority: "Medium",
    genres: ["Adventure", "Narrative"],
    description: "A compact story-led evening pick with strong atmosphere and a clean finish line.",
    artworkUrl: steamCapsuleLargeImage(383870),
    bannerUrl: steamHeaderImage(383870),
    lastPlayedLabel: "New",
    addedLabel: "Added 4 Jun, 2025",
    collectionIds: ["story-rich", "short-sweet"],
    sessionFit: ["short", "evening"],
    moodTags: ["chill"]
  },
  {
    id: "ori-will-of-the-wisps",
    duration: { mainStoryMinutes: 690, mainExtrasMinutes: 900 },
    title: "Ori and the Will of the Wisps",
    steamAppId: 1057090,
    ownership: "Owned",
    status: "In Progress",
    hoursPlayed: 11,
    completionPercent: 46,
    priority: "High",
    genres: ["Platformer", "Adventure", "Fantasy"],
    description: "Fluid traversal and emotional momentum when you want something focused but beautiful.",
    artworkUrl: steamCapsuleLargeImage(1057090),
    bannerUrl: steamHeaderImage(1057090),
    lastPlayedLabel: "1w ago",
    addedLabel: "Added 17 Jun, 2025",
    collectionIds: ["short-sweet", "comfort-games"],
    sessionFit: ["short", "evening"],
    moodTags: ["chill"]
  },
  {
    id: "hollow-knight",
    duration: { mainStoryMinutes: 1500, mainExtrasMinutes: 2400 },
    title: "Hollow Knight",
    steamAppId: 367520,
    ownership: "Owned",
    status: "In Progress",
    hoursPlayed: 18,
    completionPercent: 41,
    priority: "High",
    genres: ["Action", "Platformer", "Adventure"],
    description: "A demanding but rewarding pick when you want to push through and make progress.",
    artworkUrl: steamCapsuleLargeImage(367520),
    bannerUrl: steamHeaderImage(367520),
    lastPlayedLabel: "1d ago",
    addedLabel: "Added 28 Jun, 2025",
    collectionIds: ["short-sweet"],
    sessionFit: ["evening", "weekend"],
    moodTags: ["intense"]
  },
  {
    id: "baldurs-gate-3",
    duration: { mainStoryMinutes: 4200, mainExtrasMinutes: 5700 },
    title: "Baldur's Gate 3",
    steamAppId: 1086940,
    ownership: "Owned",
    status: "Not Started",
    hoursPlayed: 0,
    completionPercent: 0,
    priority: "Must Play",
    genres: ["RPG", "Fantasy", "Narrative"],
    description: "The big story commitment for long-form nights when you want to disappear into a world.",
    artworkUrl: steamCapsuleLargeImage(1086940),
    bannerUrl: steamHeaderImage(1086940),
    lastPlayedLabel: "New",
    addedLabel: "Added 1 Jul, 2025",
    collectionIds: ["story-rich"],
    sessionFit: ["weekend"],
    moodTags: []
  },
  {
    id: "dead-cells",
    duration: { endless: true },
    title: "Dead Cells",
    steamAppId: 588650,
    ownership: "Owned",
    status: "Not Started",
    hoursPlayed: 0,
    completionPercent: 0,
    priority: "Medium",
    genres: ["Action", "Roguelike", "Platformer"],
    description: "An easy drop-in for when you want kinetic play without too much setup.",
    artworkUrl: steamCapsuleLargeImage(588650),
    bannerUrl: steamHeaderImage(588650),
    lastPlayedLabel: "New",
    addedLabel: "Added 4 Jul, 2025",
    collectionIds: ["short-sweet"],
    sessionFit: ["short", "evening"],
    moodTags: ["intense", "brain-off"]
  },
  {
    id: "dave-the-diver",
    duration: { mainStoryMinutes: 1380, mainExtrasMinutes: 1980 },
    title: "Dave the Diver",
    steamAppId: 1868140,
    ownership: "Owned",
    status: "Not Started",
    hoursPlayed: 0,
    completionPercent: 0,
    priority: "Medium",
    genres: ["Adventure", "Simulation", "Cozy"],
    description: "A breezy, low-pressure choice with plenty of charm and bite-sized progress.",
    artworkUrl: steamCapsuleLargeImage(1868140),
    bannerUrl: steamHeaderImage(1868140),
    lastPlayedLabel: "New",
    addedLabel: "Added 6 Jul, 2025",
    collectionIds: ["short-sweet", "comfort-games"],
    sessionFit: ["short", "evening"],
    moodTags: ["chill", "brain-off"]
  },
  {
    id: "mass-effect-legendary",
    duration: { mainStoryMinutes: 4200, mainExtrasMinutes: 6600 },
    title: "Mass Effect Legendary Edition",
    steamAppId: 1328670,
    ownership: "Owned",
    status: "Not Started",
    hoursPlayed: 0,
    completionPercent: 0,
    priority: "High",
    genres: ["RPG", "Sci-Fi", "Narrative"],
    description: "A heavyweight sci-fi comfort pick when you want a bigger arc to commit to.",
    artworkUrl: steamCapsuleLargeImage(1328670),
    bannerUrl: steamHeaderImage(1328670),
    lastPlayedLabel: "New",
    addedLabel: "Added 8 Jul, 2025",
    collectionIds: ["cosmic-odyssey", "story-rich"],
    sessionFit: ["weekend"],
    moodTags: []
  },
  {
    id: "returnal",
    duration: { mainStoryMinutes: 1560, mainExtrasMinutes: 2100 },
    title: "Returnal",
    steamAppId: 1649240,
    ownership: "Owned",
    status: "Not Started",
    hoursPlayed: 0,
    completionPercent: 0,
    priority: "High",
    genres: ["Action", "Sci-Fi", "Roguelike"],
    description: "Relentless action and a strong sci-fi tone for high-focus evenings.",
    artworkUrl: steamCapsuleLargeImage(1649240),
    bannerUrl: steamHeaderImage(1649240),
    lastPlayedLabel: "New",
    addedLabel: "Added 8 Jul, 2025",
    collectionIds: ["cosmic-odyssey"],
    sessionFit: ["evening", "weekend"],
    moodTags: ["intense"]
  }
];

/**
 * Demo games are a fixture set with no Steam behind them, so they carry no
 * recency evidence. Sample data must not look better-informed than a real
 * account: unknown here means the same unknown it means everywhere else.
 */
export const demoGames: DemoGame[] = demoGameFixtures.map((game) => ({ ...game, recency: UNKNOWN_RECENCY }));
