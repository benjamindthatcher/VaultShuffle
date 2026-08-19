"use client";

import { ANALYTICS_EVENTS, trackEvent } from "@/lib/analytics";
import type { DemoGame } from "@/lib/demo-data";
import { estimatedTimeToBeatMinutes } from "@/lib/game-duration";

export type CompletionSource = "sweep" | "sweep_bulk" | "library" | "vault" | "purge" | "details";

function priceCents(game: DemoGame) {
  if (game.isFree) return 0;
  return Math.round(Number(game.priceInitial ?? 0)) || 0;
}

/**
 * Records a completion in both places, because neither answers the question
 * alone: PostHog gives the funnel and the retention curve, the ledger gives rows
 * that can be joined to the library to ask what was actually finished and what
 * it was worth.
 *
 * The ledger write is fire-and-forget. The game is already marked complete by
 * the time this runs, so a failed analytics call must never surface as an error.
 */
export function trackCompletionClaim(game: DemoGame, source: CompletionSource, isLive: boolean) {
  const estimateMinutes = estimatedTimeToBeatMinutes(game.duration) ?? null;
  const hoursPlayed = Number(game.hoursPlayed ?? 0);
  const cents = priceCents(game);

  trackEvent(ANALYTICS_EVENTS.completionClaimed, {
    source,
    price_cents: cents,
    hours_played: Math.round(hoursPlayed),
    estimate_hours: estimateMinutes ? Math.round(estimateMinutes / 60) : null,
    // Above 1 means they played past the estimate, which is what the sweep spots.
    played_vs_estimate: estimateMinutes ? Number((hoursPlayed / (estimateMinutes / 60)).toFixed(2)) : null,
    had_estimate: Boolean(estimateMinutes)
  });

  if (!isLive) return;
  void fetch("/api/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      game_id: game.id,
      action: "claimed",
      source,
      hours_played: hoursPlayed,
      estimate_minutes: estimateMinutes,
      price_cents: cents
    })
  }).catch(() => undefined);
}

export function trackCompletionUndone(game: DemoGame, source: CompletionSource, isLive: boolean) {
  trackEvent(ANALYTICS_EVENTS.completionUndone, { source, price_cents: priceCents(game) });
  if (!isLive) return;
  void fetch("/api/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ game_id: game.id, action: "undone" })
  }).catch(() => undefined);
}

export function trackCompletionDismissed(game: DemoGame, bulk: boolean) {
  trackEvent(ANALYTICS_EVENTS.completionDismissed, {
    bulk,
    hours_played: Math.round(Number(game.hoursPlayed ?? 0))
  });
}
