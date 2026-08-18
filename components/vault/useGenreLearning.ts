"use client";

import { useEffect, useMemo, useState } from "react";
import { observeFeatureFlag } from "@/lib/posthog-client";
import { buildGenrePreferenceIndex, type GenrePreference, type GenrePreferenceIndex } from "@/lib/genre-preferences";

/** PostHog boolean flag. Acts as the kill switch for the whole experiment. */
export const VAULT_GENRE_LEARNING_FLAG = "vault-genre-learning";

export type GenreLearningArm = "test" | "control";

/**
 * Makes the learned recommender measurable.
 *
 * The arm is chosen per draw, not per user. A between-user split needs on the
 * order of a thousand draws an arm to resolve a few points of launch rate, which
 * at this user count would take years; randomising each draw makes every user
 * their own control and removes between-user variance entirely.
 *
 * The flag stays a user-level kill switch so the experiment can be stopped
 * outright, and `enabled` is false whenever flags cannot be resolved — an
 * opted-out visitor is a clean control rather than a broken test.
 */
export function useGenreLearning(preferences: GenrePreference[]) {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => observeFeatureFlag(VAULT_GENRE_LEARNING_FLAG, setEnabled), []);

  const genrePreferences = useMemo<GenrePreferenceIndex | null>(
    () => (preferences.length ? buildGenrePreferenceIndex(preferences) : null),
    [preferences]
  );

  /**
   * Rolled once per draw. Returns "control" when there is nothing learned yet, so
   * the arms differ only where the term could actually change the outcome and the
   * comparison is not diluted by draws that were identical in both.
   */
  function nextArm(): GenreLearningArm {
    if (!enabled || !genrePreferences) return "control";
    return Math.random() < 0.5 ? "test" : "control";
  }

  return { enabled, genrePreferences, nextArm };
}
