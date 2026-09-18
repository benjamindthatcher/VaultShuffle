"use client";

import { useEffect, useMemo, useState } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { useGenreLearning } from "@/components/vault/useGenreLearning";
import type { DemoGame } from "@/lib/demo-data";
import { buildGenreWeightIndex } from "@/lib/genre-preferences";
import { buildPlayNext, type PlayNextLane, type PlayNextPick } from "@/lib/play-next";
import { ANALYTICS_EVENTS, trackEvent, trackNavigationEvent } from "@/lib/analytics";

export type PlayNextSurface = "dashboard" | "page";

/** How long "Not now" hides a game for. Long enough to matter, short enough to come back. */
export const PLAY_NEXT_SNOOZE_DAYS = 14;

const NOTICE_MS = 9_000;

export type PlayNextUndo = {
  gameId: string;
  title: string;
  kind: "snoozed" | "slept";
  previousStatus: "Not Started" | "In Progress";
};

/**
 * The engine, fed from the shared app state, and the handful of things a player
 * can do about what it suggests.
 *
 * Every action is one the rest of the product already understands, so nothing
 * new has to be stored and each one reaches the Vault too: "Not now" is a
 * snooze, "Not for me" is sleeping the game, and a pin is a pin. That is also
 * what makes the shelf respond - each of those changes the state the engine
 * reads, so the card is replaced the moment it is dismissed, and a game set
 * aside becomes evidence against the games like it.
 */
export function usePlayNext(surface: PlayNextSurface, topCount = 4) {
  const {
    games,
    allGames,
    vaultState,
    genrePreferences: learnedPreferences,
    genrePreferenceGlobals: learnedGlobals,
    gamePreferences,
    isLive,
    recordVaultAction,
    updateGame
  } = useAppData();

  // The learned genre term is still an experiment in the Vault, behind its own
  // flag. It only reaches this shelf where that flag is on, so the two cannot
  // disagree about whether it is trusted yet.
  const learning = useGenreLearning(learnedPreferences, learnedGlobals);
  const preferenceContext = useMemo(
    () => learning.enabled && learning.genrePreferences
      ? { index: learning.genrePreferences, globals: learning.genrePreferenceGlobals, genreWeights: buildGenreWeightIndex(allGames) }
      : null,
    [allGames, learning.enabled, learning.genrePreferences, learning.genrePreferenceGlobals]
  );

  // Fixed for the life of the page, so the daily reshuffle cannot happen under
  // somebody's cursor at midnight and every memo below stays put.
  const [now] = useState(() => Date.now());

  const result = useMemo(
    () => buildPlayNext({
      games,
      allGames,
      pinnedIds: vaultState.pinnedIds,
      snoozedIds: vaultState.snoozedIds,
      preferenceContext,
      verdicts: gamePreferences,
      now,
      topCount
    }),
    [allGames, gamePreferences, games, now, preferenceContext, topCount, vaultState.pinnedIds, vaultState.snoozedIds]
  );

  const [undo, setUndo] = useState<PlayNextUndo | null>(null);
  const [pinCandidate, setPinCandidate] = useState<DemoGame | null>(null);
  const [message, setMessage] = useState("");

  // Long enough to read and reach for Undo, short enough that it does not sit
  // over the page describing something from minutes ago.
  useEffect(() => {
    if (!undo && !message) return;
    const timer = window.setTimeout(() => { setUndo(null); setMessage(""); }, NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [undo, message]);

  const pinnedGames = useMemo(
    () => vaultState.pinnedIds
      .map((id) => allGames.find((game) => game.id === id))
      .filter((game): game is DemoGame => Boolean(game)),
    [allGames, vaultState.pinnedIds]
  );

  function track(action: string, pick: PlayNextPick, rank: number) {
    trackEvent(ANALYTICS_EVENTS.playNextAction, {
      action,
      lane: pick.lane,
      rank,
      surface,
      seed_kind: pick.seed?.kind ?? null
    });
  }

  function context(lane: PlayNextLane) {
    return { source: "play_next", lane, surface };
  }

  async function pin(pick: PlayNextPick, rank: number) {
    if (vaultState.pinnedIds.includes(pick.game.id)) return;
    track("pinned", pick, rank);
    if (vaultState.pinnedIds.length >= 3) {
      setPinCandidate(pick.game);
      return;
    }
    setUndo(null);
    setMessage(`${pick.game.title} pinned to Playing next.`);
    await recordVaultAction("pinned", pick.game.id, context(pick.lane));
  }

  async function replacePin(replaceId: string) {
    if (!pinCandidate) return;
    const replaced = pinnedGames.find((game) => game.id === replaceId)?.title ?? "a pinned game";
    await recordVaultAction("pinned", pinCandidate.id, { source: "play_next", surface, replace_game_id: replaceId });
    setMessage(`${pinCandidate.title} replaced ${replaced} in Playing next.`);
  }

  async function notNow(pick: PlayNextPick, rank: number) {
    track("snoozed", pick, rank);
    const until = new Date(Date.now() + PLAY_NEXT_SNOOZE_DAYS * 86_400_000).toISOString();
    setMessage("");
    setUndo({ gameId: pick.game.id, title: pick.game.title, kind: "snoozed", previousStatus: activeStatus(pick.game) });
    await recordVaultAction("snoozed", pick.game.id, { ...context(pick.lane), snoozed_until: until });
  }

  async function notForMe(pick: PlayNextPick, rank: number) {
    track("slept", pick, rank);
    setMessage("");
    setUndo({ gameId: pick.game.id, title: pick.game.title, kind: "slept", previousStatus: activeStatus(pick.game) });
    await updateGame(pick.game.id, { status: "Slept", sleptAt: new Date().toISOString(), completedAt: null });
  }

  async function undoLast() {
    if (!undo) return;
    const last = undo;
    setUndo(null);
    if (last.kind === "snoozed") await recordVaultAction("unsnoozed", last.gameId, { source: "play_next", surface });
    else await updateGame(last.gameId, { status: last.previousStatus, sleptAt: null });
  }

  function opened(pick: PlayNextPick, rank: number) {
    track("opened", pick, rank);
  }

  /** Fired as the link leaves the page, so it has to survive the navigation. */
  function launched(pick: PlayNextPick, rank: number) {
    trackNavigationEvent(ANALYTICS_EVENTS.playNextAction, {
      action: "launched",
      lane: pick.lane,
      rank,
      surface,
      seed_kind: pick.seed?.kind ?? null
    });
  }

  return {
    result,
    isLive,
    pinsFull: vaultState.pinnedIds.length >= 3,
    pinnedGames,
    pinCandidate,
    closePinDialog: () => setPinCandidate(null),
    removePin: async (gameId: string) => { await recordVaultAction("unpinned", gameId); },
    replacePin,
    undo,
    message,
    dismissNotice: () => { setUndo(null); setMessage(""); },
    pin,
    notNow,
    notForMe,
    undoLast,
    opened,
    launched
  };
}

function activeStatus(game: DemoGame): "Not Started" | "In Progress" {
  return game.status === "In Progress" ? "In Progress" : "Not Started";
}
