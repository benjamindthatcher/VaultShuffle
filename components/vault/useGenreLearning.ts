"use client";

import { useEffect, useMemo, useState } from "react";
import { observeFeatureFlag, registerAnalyticsContext } from "@/lib/posthog-client";
import { buildGenrePreferenceIndex, type GenrePreference, type GenrePreferenceIndex } from "@/lib/genre-preferences";

/** PostHog boolean flag, rolled out to a percentage of identified users. */
export const VAULT_GENRE_LEARNING_FLAG = "vault-genre-learning";

/**
 * Splits users between the learned recommender and the unweighted one.
 *
 * With single-digit user numbers nobody can eyeball whether the learned term
 * helps, so it ships as a measurable experiment rather than a change: the assigned
 * variant is registered as a super-property, which puts it on every later event
 * and makes vault_pick_launched — the north-star metric — breakable down by arm
 * without any bespoke instrumentation.
 *
 * Returns null preferences for the control arm, which is exactly what
 * buildVaultPool treats as "score the old way".
 */
export function useGenreLearning(preferences: GenrePreference[]) {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => observeFeatureFlag(VAULT_GENRE_LEARNING_FLAG, setEnabled), []);

  useEffect(() => {
    registerAnalyticsContext({ vault_genre_learning: enabled ? "test" : "control" });
  }, [enabled]);

  const index = useMemo<GenrePreferenceIndex | null>(
    () => (enabled && preferences.length ? buildGenrePreferenceIndex(preferences) : null),
    [enabled, preferences]
  );

  return { enabled, genrePreferences: index };
}
