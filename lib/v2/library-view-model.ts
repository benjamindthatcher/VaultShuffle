import type { DemoGame } from "../demo-data.ts";
import type { LibraryCard } from "./repositories/library-core.ts";
import { describeRecency } from "../recency.ts";
import { splitGenres, steamTagGenreLabels, steamTagLabels, topLevelGenresFor } from "../genres.ts";
import { completionFromDuration } from "../game-duration.ts";
import { sessionabilityScore } from "../sessionability.ts";
import { deriveMoodScores, deriveSessionFits, moodTagsFromScores } from "../vault-matching.ts";
import { playNextTagProfile } from "../play-next.ts";
import { exclusionCategoriesFor } from "../exclusion-categories.ts";
import { decodeHtmlEntities } from "../html-entities.ts";
import { steamCapsuleLargeImage, steamHeaderImage } from "../steam-images.ts";

/** Reuse the current card model without asserting absent provider facts. */
export function libraryGame(card: LibraryCard): DemoGame {
  const p = card.product;
  if (!p) throw Error("The Library response is incomplete.");
  const canonical = splitGenres(p.canonicalGenres.join(" / "));
  const genreTags = steamTagGenreLabels(p.tags, 8);
  const genres = splitGenres([...topLevelGenresFor([...canonical, ...genreTags].join(" / "), card.title), ...canonical, ...genreTags].join(" / ")).slice(0, 8);
  const tags = steamTagLabels(p.tags);
  const sessionability = sessionabilityScore([...canonical, ...tags]);
  const moodScores = deriveMoodScores([...canonical, ...topLevelGenresFor(canonical.join(" / "), card.title), ...tags]);
  const duration = p.duration;
  const hours = card.playtimeMinutes === null ? 0 : card.playtimeMinutes / 60;
  const completionPercent = card.completed ? 100 : duration.endless ? 99
    : p.manualProgress ?? completionFromDuration(hours, duration);
  const recency = describeRecency({lastObservedPlayedAt: card.lastPlayedAt, recencySource: p.recencySource, recencyEvidenceAt: p.recencyEvidenceAt});
  return {
    id: String(card.gameId), title: card.title, steamAppId: card.appId === null ? 0 : Number(card.appId), ownership: "Owned",
    status: card.completed ? "Completed" : card.blacklisted ? "Blacklisted" : hours > 0 ? "In Progress" : "Not Started",
    hoursPlayed: hours, playtimeKnown: card.playtimeMinutes !== null && card.access === "owned",
    completionPercent, progressKnown: card.completed || p.manualProgress !== null || (card.playtimeMinutes !== null && card.access === "owned"),
    priority: "Medium", genres, description: decodeHtmlEntities(card.description ?? ""), notes: card.notes ?? "",
    artworkUrl: p.imageUrl || p.headerUrl || (card.appId ? steamCapsuleLargeImage(card.appId) : "/assets/vault/vault-stage-open.png"),
    bannerUrl: p.headerUrl || p.imageUrl || (card.appId ? steamHeaderImage(card.appId) : "/assets/vault/vault-stage-open.png"),
    lastPlayedLabel: recency.label ?? "", lastPlayedAt: card.lastPlayedAt, recency,
    reviewRequested: Boolean(p.reviewRequestedAt), dateAdded: p.dateAdded,
    addedLabel: p.dateAdded ? `Added ${p.dateAdded}` : "", collectionIds: [...(p.collectionIds ?? [])], sessionability,
    sessionFit: deriveSessionFits({duration, completionPercent, endless: Boolean(duration.endless), sessionability}),
    moodTags: moodTagsFromScores(moodScores), moodScores, tagProfile: playNextTagProfile(p.tags),
    completedAt: p.completedAt,
    previousActiveStatus: p.previousActiveStatus === "Sampled" ? "In Progress" : p.previousActiveStatus,
    completionSuggestionDismissedAt: p.completionDismissedAt, completionSuggestionDismissedPlaytime: p.completionDismissedMinutes === null ? null : p.completionDismissedMinutes / 60,
    duration, platforms: { windows: p.platforms.windows === true, mac: p.platforms.mac === true, linux: p.platforms.linux === true },
    deckCompatibility: p.deckCompatibility, releaseDate: p.releaseDate, playerMode: p.playerMode,
    priceInitial: p.price.initial, priceFinal: p.price.final, isFree: p.price.isFree,
    reviewPositive: p.reviews.positive, reviewNegative: p.reviews.negative, reviewTotal: p.reviews.total,
    exclusions: exclusionCategoriesFor({tags: p.tags, genres: canonical, categories: [...p.categories]}),
    durationStatus: p.durationStatus, tagsStatus: p.tagsStatus, accessSource: card.access,
    familyOwnerSteamId: p.familyOwnerSteamId, familyOwnerName: p.familyOwnerName,
  };
}
