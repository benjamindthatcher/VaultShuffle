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
  addedLabel: string;
  dateAdded?: string | null;
  collectionIds: string[];
  sessionFit: VaultSessionId[];
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
  /** Steam review counts, used for the hype and hidden-gem terms. */
  /** Steam store prices, in cents, at whatever the catalogue last saw. */
  priceInitial?: number | null;
  priceFinal?: number | null;
  isFree?: boolean | null;
  reviewPositive?: number | null;
  reviewNegative?: number | null;
  reviewTotal?: number | null;
  /** Where catalogue enrichment has got to, so "still processing" can mean it. */
  durationStatus?: string | null;
  tagsStatus?: string | null;
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
