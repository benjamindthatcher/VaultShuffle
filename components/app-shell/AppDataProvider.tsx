"use client";

import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { demoGames, type DemoCollection, type DemoGame } from "@/lib/demo-data";
import { buildCollectionDetails, guestPreviewCollection, guestSession, mapGuestGames, mapLiveCollections, mapLiveGames } from "@/lib/app-view-model";
import { ANALYTICS_EVENTS, VAULT_ACTION_EVENT_NAMES, VAULT_DRAW_EVENT_NAMES, setAnalyticsAudience, trackEvent, trackNavigationEvent } from "@/lib/analytics";
import type { Collection, Game, SessionPayload, SmartCollectionPreset } from "@/lib/types";
import type { CollectionMembership } from "@/lib/collections";
import type { VaultAction, VaultState } from "@/lib/vault-state";
import type { VaultDraw, VaultDrawEventType, VaultDrawInput } from "@/lib/vault-history";
import type { GenrePreference } from "@/lib/genre-preferences";

type CollectionInput = { name: string; description: string; kind?: "custom" | "smart"; rules?: { preset: SmartCollectionPreset } };

type AppBootstrapPayload = {
  session: SessionPayload;
  games?: Game[];
  collections?: Collection[];
  memberships?: CollectionMembership[];
  vaultState?: VaultState;
  genrePreferences?: GenrePreference[];
  data_error?: boolean;
  guest_pool_source?: "live_catalogue" | "fallback";
};

export type DeviceMode = "all" | "mac" | "deck";
const DEVICE_MODE_KEY = "vault-device-mode";

/**
 * Steam Deck compatibility, as Steam resolves it: 3 verified, 2 playable,
 * 1 unsupported, 0 unknown. Unknown is excluded rather than assumed playable —
 * the point of the mode is confidence that a pick will actually run.
 */
function matchesDeviceMode(game: DemoGame, mode: DeviceMode) {
  if (mode === "all") return true;
  if (mode === "mac") return Boolean(game.platforms?.mac);
  return (game.deckCompatibility ?? 0) >= 2;
}

const emptyVaultState: VaultState = { pinnedIds: [], snoozedIds: [], currentPickId: null };
const EMPTY_GENRE_PREFERENCES: GenrePreference[] = [];

type AppDataContextValue = {
  session: SessionPayload;
  games: DemoGame[];
  collections: DemoCollection[];
  vaultState: VaultState;
  genrePreferences: GenrePreference[];
  vaultHistory: VaultDraw[];
  isLive: boolean;
  playHistoryMissing: boolean;
  deviceMode: DeviceMode;
  setDeviceMode: (mode: DeviceMode) => void;
  isLoading: boolean;
  isSyncing: boolean;
  loadError: string | null;
  refresh: () => Promise<void>;
  syncSteamLibrary: () => Promise<number>;
  signOut: () => Promise<void>;
  createCollection: (payload: CollectionInput) => Promise<string>;
  updateCollection: (collectionId: string, payload: CollectionInput) => Promise<void>;
  removeCollection: (collectionId: string) => Promise<void>;
  updateGame: (gameId: string, patch: { status?: DemoGame["status"]; completionPercent?: number; hoursPlayed?: number; notes?: string; priority?: DemoGame["priority"]; completedAt?: string | null; sleptAt?: string | null; completionSuggestionDismissedAt?: string | null; completionSuggestionDismissedPlaytime?: number | null }) => Promise<void>;
  restoreGame: (gameId: string) => Promise<void>;
  setGameCollection: (gameId: string, collectionId: string, assigned: boolean) => Promise<void>;
  recordVaultAction: (action: VaultAction, gameId: string, context?: Record<string, unknown>) => Promise<void>;
  recordVaultDraw: (gameId: string, input: VaultDrawInput) => Promise<VaultDraw>;
  loadVaultHistory: () => Promise<void>;
  recordDrawEvent: (drawId: string, eventType: VaultDrawEventType) => Promise<void>;
  clearVaultHistory: () => Promise<void>;
};

const AppDataContext = createContext<AppDataContextValue | null>(null);

async function api<T>(path: string, options: RequestInit = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });

  if (response.status === 401) {
    throw new Error("unauthorized");
  }

  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed.");
  return payload as T;
}

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionPayload>(guestSession);
  const [guestGames, setGuestGames] = useState<DemoGame[]>(guestFallbackGames);
  const [guestCollections, setGuestCollections] = useState<DemoCollection[]>(() => guestPreviewCollection(guestFallbackGames.length));
  const [liveGames, setLiveGames] = useState<DemoGame[]>([]);
  const [liveCollections, setLiveCollections] = useState<DemoCollection[]>(() => mapLiveCollections([]));
  const [guestVaultState, setGuestVaultState] = useState<VaultState>(emptyVaultState);
  const [liveVaultState, setLiveVaultState] = useState<VaultState>(emptyVaultState);
  const [guestVaultHistory, setGuestVaultHistory] = useState<VaultDraw[]>([]);
  const [liveVaultHistory, setLiveVaultHistory] = useState<VaultDraw[]>([]);
  const [liveGenrePreferences, setLiveGenrePreferences] = useState<GenrePreference[]>(EMPTY_GENRE_PREFERENCES);
  const [isLive, setIsLive] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [playHistoryMissing, setPlayHistoryMissing] = useState(false);
  const [deviceMode, setDeviceModeState] = useState<DeviceMode>("all");
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setLoadError(null);
    try {
      const bootstrap = await api<AppBootstrapPayload>("/api/app-data");
      const nextSession = bootstrap.session;
      setSession(nextSession);

      if (!nextSession.logged_in) {
        setIsLive(false);
        if (bootstrap.games?.length) {
          const mappedGuestGames = mapGuestGames(bootstrap.games);
          setGuestGames(mappedGuestGames);
          setGuestCollections(guestPreviewCollection(mappedGuestGames.length));
        } else if (bootstrap.data_error) {
          setLoadError("The live guest catalogue is temporarily unavailable. A smaller preview is still ready.");
        }
        return;
      }

      setIsLive(true);
      const { games, collections, memberships, vaultState } = bootstrap;
      if (bootstrap.data_error || !games || !collections || !memberships || !vaultState) {
        setLoadError("Your VaultShuffle data could not be loaded. Please retry.");
        return;
      }

      const details = buildCollectionDetails(collections, games, memberships);

      setLiveCollections(mapLiveCollections(details));
      setLiveGames(mapLiveGames(games, details));
      setLiveVaultState(vaultState);
      // Absent for a user the nightly rebuild has not reached yet, which simply
      // means the learned term contributes nothing to their scores.
      setLiveGenrePreferences(bootstrap.genrePreferences ?? EMPTY_GENRE_PREFERENCES);
    } catch (error) {
      setSession(guestSession);
      setIsLive(false);
      if (error instanceof Error && error.message !== "unauthorized") {
        setLoadError("VaultShuffle could not check your session. Guest preview is still available.");
      }
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(DEVICE_MODE_KEY);
      if (saved === "mac" || saved === "deck") setDeviceModeState(saved);
    } catch {
      // Private browsing can disable storage; the mode just will not persist.
    }
  }, []);

  // Registered as a PostHog super property so every event this session sends can be
  // split by guest vs signed-in without each call site passing it.
  useEffect(() => {
    if (isLoading) return;
    setAnalyticsAudience(!isLive);
  }, [isLive, isLoading]);

  function setDeviceMode(mode: DeviceMode) {
    setDeviceModeState(mode);
    try {
      if (mode === "all") localStorage.removeItem(DEVICE_MODE_KEY);
      else localStorage.setItem(DEVICE_MODE_KEY, mode);
    } catch {
      // Storage being unavailable must not stop the filter working this session.
    }
    trackEvent(ANALYTICS_EVENTS.deviceModeChanged, { mode });
  }

  async function syncSteamLibrary() {
    if (!isLive) throw new Error("Sign in with Steam before syncing your library.");

    setIsSyncing(true);
    try {
      const result = await api<{ imported: number; play_history_missing?: boolean }>("/api/steam/owned-games", { method: "POST" });
      await load();
      trackEvent(ANALYTICS_EVENTS.steamLibrarySynced, {
        imported_count: result.imported,
        play_history_missing: Boolean(result.play_history_missing)
      });
      setPlayHistoryMissing(Boolean(result.play_history_missing));
      return result.imported;
    } catch (error) {
      // A failed first import is the highest-intent moment in the funnel failing.
      // Reporting only successes would leave it invisible, which is exactly how
      // the Steam launch event stayed at zero for a month.
      trackEvent(ANALYTICS_EVENTS.steamImportFailed, {
        reason: error instanceof Error ? error.message : "unknown",
        first_import: liveGames.length === 0
      });
      throw error;
    } finally {
      setIsSyncing(false);
    }
  }

  async function signOut() {
    await api("/api/logout", { method: "POST" });
    trackEvent(ANALYTICS_EVENTS.signedOut);
    window.location.assign("/login");
  }

  async function createCollection(payload: CollectionInput) {
    if (isLive) {
      const { collection } = await api<{ collection: Collection }>("/api/collections", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      await load();
      trackEvent(ANALYTICS_EVENTS.collectionCreated, { kind: payload.kind ?? "custom" });
      return collection.id;
    }

    const nextCollection: DemoCollection = {
      id: `custom-${crypto.randomUUID()}`,
      kind: payload.kind || "custom",
      name: payload.name,
      description: payload.description || "Freshly created and ready for curating.",
      artworkUrl: "/assets/vault/vault-stage-open.png",
      accent: payload.kind === "smart" ? "Automatically updated from your library." : "New collection draft.",
      smartPreset: payload.rules?.preset
    };

    setGuestCollections((current) => [nextCollection, ...current]);
    trackEvent(ANALYTICS_EVENTS.collectionCreated, { kind: payload.kind ?? "custom" });
    return nextCollection.id;
  }

  async function updateCollection(collectionId: string, payload: CollectionInput) {
    if (isLive) {
      await api(`/api/collections/${collectionId}`, { method: "PATCH", body: JSON.stringify(payload) });
      await load();
      trackEvent(ANALYTICS_EVENTS.collectionUpdated, { kind: payload.kind ?? "custom" });
      return;
    }
    setGuestCollections((current) => current.map((collection) => collection.id === collectionId ? {
      ...collection,
      name: payload.name,
      description: payload.description,
      kind: payload.kind ?? collection.kind,
      smartPreset: payload.kind === "custom" ? undefined : payload.rules?.preset ?? collection.smartPreset
    } : collection));
    trackEvent(ANALYTICS_EVENTS.collectionUpdated, { kind: payload.kind ?? "custom" });
  }

  async function removeCollection(collectionId: string) {
    if (isLive) {
      await api(`/api/collections/${collectionId}`, { method: "DELETE" });
      await load();
      trackEvent(ANALYTICS_EVENTS.collectionDeleted);
      return;
    }
    setGuestCollections((current) => current.filter((collection) => collection.id !== collectionId));
    setGuestGames((current) => current.map((game) => ({
      ...game,
      collectionIds: game.collectionIds.filter((id) => id !== collectionId)
    })));
    trackEvent(ANALYTICS_EVENTS.collectionDeleted);
  }

  async function updateGame(
    gameId: string,
    patch: { status?: DemoGame["status"]; completionPercent?: number; hoursPlayed?: number; notes?: string; priority?: DemoGame["priority"]; completedAt?: string | null; sleptAt?: string | null; completionSuggestionDismissedAt?: string | null; completionSuggestionDismissedPlaytime?: number | null }
  ) {
    if (isLive) {
      await api(`/api/games/${gameId}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: patch.status,
          completion_percentage: patch.completionPercent,
          hours_played: patch.hoursPlayed,
          notes: patch.notes,
          priority: patch.priority,
          completed_at: patch.completedAt,
          slept_at: patch.sleptAt,
          completion_suggestion_dismissed_at: patch.completionSuggestionDismissedAt,
          completion_suggestion_dismissed_playtime: patch.completionSuggestionDismissedPlaytime
        })
      });
      setLiveGames((current) => current.map((game) => game.id === gameId
        ? applyGamePatch(game, patch, liveGameSummary(game))
        : game));
      if (patch.status === "Completed" || patch.status === "Slept") {
        setLiveVaultState((current) => ({
          ...current,
          pinnedIds: current.pinnedIds.filter((id) => id !== gameId),
          currentPickId: current.currentPickId === gameId ? null : current.currentPickId
        }));
      }
      if (patch.status) trackEvent(ANALYTICS_EVENTS.gameStatusChanged, { status: patch.status });
      return;
    }

    setGuestGames((current) => current.map((game) => game.id === gameId ? applyGamePatch(game, patch) : game));
    if (patch.status === "Completed" || patch.status === "Slept") {
      if (patch.status) trackEvent(ANALYTICS_EVENTS.gameStatusChanged, { status: patch.status });
      setGuestVaultState((current) => ({
        ...current,
        pinnedIds: current.pinnedIds.filter((id) => id !== gameId),
        currentPickId: current.currentPickId === gameId ? null : current.currentPickId
      }));
    }
  }

  async function restoreGame(gameId: string) {
    if (isLive) {
      await api(`/api/games/${gameId}`, {
        method: "PATCH",
        body: JSON.stringify({ restore_active: true })
      });
      setLiveGames((current) => current.map((game) => game.id === gameId ? restoreActiveGame(game) : game));
      trackEvent(ANALYTICS_EVENTS.gameStatusChanged, { status: "Active", restored: true });
      return;
    }

    setGuestGames((current) => current.map((game) => game.id === gameId ? restoreActiveGame(game) : game));
    trackEvent(ANALYTICS_EVENTS.gameStatusChanged, { status: "Active", restored: true });
  }

  async function setGameCollection(gameId: string, collectionId: string, assigned: boolean) {
    if (isLive) {
      await api(`/api/collections/${collectionId}/games${assigned ? "" : `/${gameId}`}`, {
        method: assigned ? "POST" : "DELETE",
        body: assigned ? JSON.stringify({ game_id: gameId }) : undefined
      });
      await load();
      trackEvent(ANALYTICS_EVENTS.collectionMembershipChanged, { action: assigned ? "added" : "removed" });
      return;
    }

    setGuestGames((current) => current.map((game) => game.id === gameId ? {
      ...game,
      collectionIds: assigned
        ? Array.from(new Set([...game.collectionIds, collectionId]))
        : game.collectionIds.filter((id) => id !== collectionId)
    } : game));
    trackEvent(ANALYTICS_EVENTS.collectionMembershipChanged, { action: assigned ? "added" : "removed" });
  }

  async function recordVaultAction(action: VaultAction, gameId: string, context: Record<string, unknown> = {}) {
    if (isLive) {
      const nextState = await api<VaultState>("/api/vault/state", {
        method: "POST",
        body: JSON.stringify({ action, game_id: gameId, context })
      });
      setLiveVaultState(nextState);
      const liveEvent = VAULT_ACTION_EVENT_NAMES[action];
      if (liveEvent) trackEvent(liveEvent, { action });
      return;
    }

    setGuestVaultState((current) => reduceGuestVaultState(current, action, gameId, context));
    const guestEvent = VAULT_ACTION_EVENT_NAMES[action];
    if (guestEvent) trackEvent(guestEvent, { action });
  }

  async function loadVaultHistory() {
    if (!isLive) return;
    const { draws } = await api<{ draws: VaultDraw[] }>("/api/vault/history");
    setLiveVaultHistory(draws);
  }

  async function recordVaultDraw(gameId: string, input: VaultDrawInput) {
    if (isLive) {
      const { state, draw } = await api<{ state: VaultState; draw: VaultDraw }>("/api/vault/history", { method: "POST", body: JSON.stringify({ game_id: gameId, steam_app_id: input.steamAppId, session: input.session, mood: input.mood, goal: input.goal, collection_id: input.collectionId, selected_genres: input.selectedGenres, eligible_pool_count: input.eligiblePoolCount, reroll_index: input.rerollIndex }) });
      setLiveVaultState(state);
      setLiveVaultHistory((current) => [draw, ...current].slice(0, 50));
      return draw;
    }
    const draw: VaultDraw = { ...input, id: crypto.randomUUID(), drawnAt: new Date().toISOString(), events: [] };
    setGuestVaultState((current) => reduceGuestVaultState(current, "drawn", gameId, {}));
    setGuestVaultHistory((current) => [draw, ...current].slice(0, 50));
    return draw;
  }

  async function recordDrawEvent(drawId: string, eventType: VaultDrawEventType) {
    // Analytics fire before the API call, not after it. "opened_on_steam" is
    // triggered by a link that navigates to a steam:// URL, so anything queued
    // behind an await is cancelled with the page and never reaches PostHog.
    const properties: Record<string, unknown> = { draw_id: drawId, draw_action: eventType };
    if (eventType === "snoozed_7_days") properties.snooze_days = 7;
    if (eventType === "snoozed_30_days") properties.snooze_days = 30;

    if (eventType === "opened_on_steam") {
      trackNavigationEvent(VAULT_DRAW_EVENT_NAMES[eventType], properties);
    } else {
      trackEvent(VAULT_DRAW_EVENT_NAMES[eventType], properties);
    }

    if (isLive) {
      const { event } = await api<{ event: VaultDraw["events"][number] }>("/api/vault/history/events", { method: "POST", body: JSON.stringify({ draw_id: drawId, event_type: eventType }) });
      setLiveVaultHistory((current) => current.map((draw) => draw.id === drawId ? { ...draw, events: [event, ...draw.events] } : draw));
      return;
    }
    setGuestVaultHistory((current) => current.map((draw) => draw.id === drawId ? { ...draw, events: [{ id: crypto.randomUUID(), drawId, eventType, createdAt: new Date().toISOString() }, ...draw.events] } : draw));
  }

  async function clearVaultHistory() {
    if (isLive) await api("/api/vault/history", { method: "DELETE" });
    if (isLive) setLiveVaultHistory([]); else setGuestVaultHistory([]);
  }

  const value = useMemo<AppDataContextValue>(
    () => ({
      session,
      playHistoryMissing,
      deviceMode,
      setDeviceMode,
      games: (isLive ? liveGames : guestGames).filter((game) => matchesDeviceMode(game, deviceMode)),
      collections: isLive ? liveCollections : guestCollections,
      vaultState: isLive ? liveVaultState : guestVaultState,
      // Guests have no history to learn from, so they always draw unweighted.
      genrePreferences: isLive ? liveGenrePreferences : EMPTY_GENRE_PREFERENCES,
      vaultHistory: isLive ? liveVaultHistory : guestVaultHistory,
      isLive,
      isLoading,
      isSyncing,
      loadError,
      refresh: load,
      syncSteamLibrary,
      signOut,
      createCollection,
      updateCollection,
      removeCollection,
      updateGame,
      restoreGame,
      setGameCollection,
      recordVaultAction,
      recordVaultDraw,
      loadVaultHistory,
      recordDrawEvent,
      clearVaultHistory
    }),
    [session, isLive, isLoading, isSyncing, loadError, playHistoryMissing, deviceMode, liveGames, liveCollections, guestGames, guestCollections, liveVaultState, guestVaultState, liveGenrePreferences, liveVaultHistory, guestVaultHistory]
  );

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

const guestFallbackGames = demoGames.map((game) => ({
  ...game,
  status: "Not Started" as const,
  hoursPlayed: 0,
  completionPercent: 0,
  priority: "Medium" as const,
  lastPlayedLabel: "Guest preview",
  addedLabel: "Popular on Steam",
  collectionIds: []
}));

function applyGamePatch(
  game: DemoGame,
  patch: { status?: DemoGame["status"]; completionPercent?: number; hoursPlayed?: number; notes?: string; priority?: DemoGame["priority"]; completedAt?: string | null; sleptAt?: string | null; completionSuggestionDismissedAt?: string | null; completionSuggestionDismissedPlaytime?: number | null },
  emptyNotesDescription = game.description
): DemoGame {
  const status = patch.status ?? game.status;
  return {
    ...game,
    status,
    completionPercent: status === "Completed"
      ? Math.min(100, patch.completionPercent ?? game.completionPercent)
      : Math.min(99, patch.completionPercent ?? game.completionPercent),
    hoursPlayed: patch.hoursPlayed ?? game.hoursPlayed,
    priority: patch.priority ?? game.priority,
    notes: patch.notes ?? game.notes,
    description: patch.notes === undefined
      ? game.description
      : patch.notes.trim() || emptyNotesDescription,
    completedAt: patch.completedAt !== undefined
      ? patch.completedAt
      : status === "Completed" ? new Date().toISOString() : patch.status ? null : game.completedAt,
    previousActiveStatus: (status === "Completed" || status === "Slept") && game.status !== "Completed" && game.status !== "Slept"
      ? (game.previousActiveStatus ?? (game.status === "In Progress" ? "In Progress" : "Not Started"))
      : game.previousActiveStatus,
    sleptAt: patch.sleptAt !== undefined
      ? patch.sleptAt
      : status === "Slept" ? new Date().toISOString() : patch.status ? null : game.sleptAt,
    completionSuggestionDismissedAt: patch.completionSuggestionDismissedAt ?? game.completionSuggestionDismissedAt,
    completionSuggestionDismissedPlaytime: patch.completionSuggestionDismissedPlaytime ?? game.completionSuggestionDismissedPlaytime
  };
}

function liveGameSummary(game: DemoGame) {
  const genreLabel = game.genres.slice(0, 2).join(" / ") || "Steam";
  return `${genreLabel} pick from your live VaultShuffle library.`;
}

function restoreActiveGame(game: DemoGame): DemoGame {
  return {
    ...game,
    status: game.previousActiveStatus ?? (game.hoursPlayed > 0 ? "In Progress" : "Not Started"),
    completedAt: null,
    sleptAt: null,
    previousActiveStatus: null
  };
}

function reduceGuestVaultState(state: VaultState, action: VaultAction, gameId: string, context: Record<string, unknown>): VaultState {
  let pinnedIds = [...state.pinnedIds];
  const snoozedIds = new Set(state.snoozedIds);
  let currentPickId = state.currentPickId;

  if (action === "drawn") currentPickId = gameId;
  if (action === "pinned" && !pinnedIds.includes(gameId)) {
    const replaceId = String(context.replace_game_id ?? "");
    if (pinnedIds.length < 3) pinnedIds.push(gameId);
    else if (pinnedIds.includes(replaceId)) pinnedIds[pinnedIds.indexOf(replaceId)] = gameId;
  }
  if (action === "unpinned") pinnedIds = pinnedIds.filter((id) => id !== gameId);
  if (action === "snoozed") {
    snoozedIds.add(gameId);
    if (currentPickId === gameId) currentPickId = null;
  }
  if (action === "unsnoozed") snoozedIds.delete(gameId);

  return { pinnedIds, snoozedIds: [...snoozedIds], currentPickId };
}

export function useAppData() {
  const context = useContext(AppDataContext);
  if (!context) throw new Error("useAppData must be used within AppDataProvider");
  return context;
}
