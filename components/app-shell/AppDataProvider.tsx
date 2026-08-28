"use client";

import { steamCapabilities, type SteamCapabilities } from "@/lib/steam-capabilities";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { demoGames, type DemoCollection, type DemoGame } from "@/lib/demo-data";
import { buildCollectionDetails, guestPreviewCollection, guestSession, mapGuestGames, mapLiveCollections, mapLiveGames } from "@/lib/app-view-model";
import { ANALYTICS_EVENTS, VAULT_ACTION_EVENT_NAMES, VAULT_DRAW_EVENT_NAMES, setAnalyticsAudience, trackEvent, trackNavigationEvent } from "@/lib/analytics";
import type { Collection, Game, SessionPayload, SmartCollectionPreset } from "@/lib/types";
import type { CollectionMembership } from "@/lib/collections";
import type { VaultAction, VaultState } from "@/lib/vault-state";
import type { VaultDraw, VaultDrawEventType, VaultDrawInput } from "@/lib/vault-history";
import type { GenrePreference } from "@/lib/genre-preferences";
import type { PlaytimeSummary } from "@/lib/playtime-summary";
import { announceCooldown } from "@/lib/cooldown";
import {
  IDLE_STEAM_IMPORT,
  type SteamImportProgress
} from "@/lib/steam-import-progress";

type CollectionInput = { name: string; description: string; kind?: "custom" | "smart"; rules?: { preset: SmartCollectionPreset } };

type AppBootstrapPayload = {
  session: SessionPayload;
  games?: Game[];
  collections?: Collection[];
  memberships?: CollectionMembership[];
  vaultState?: VaultState;
  genrePreferences?: GenrePreference[];
  genrePreferenceGlobals?: GenrePreference[];
  playtime?: PlaytimeSummary;
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

const emptyVaultState: VaultState = { pinnedIds: [], pins: [], snoozedIds: [], currentPickId: null };
const EMPTY_GENRE_PREFERENCES: GenrePreference[] = [];
const EMPTY_PLAYTIME: PlaytimeSummary = { streakDays: 0, minutesLast7Days: 0, minutesLast30Days: 0, daysTracked: 0, dailyGains: [] };

type AppDataContextValue = {
  session: SessionPayload;
  games: DemoGame[];
  collections: DemoCollection[];
  vaultState: VaultState;
  genrePreferences: GenrePreference[];
  genrePreferenceGlobals: GenrePreference[];
  playtime: PlaytimeSummary;
  vaultHistory: VaultDraw[];
  isLive: boolean;
  playHistoryMissing: boolean;
  /** What VaultShuffle can truthfully do for this account. See lib/steam-capabilities.ts. */
  capabilities: SteamCapabilities;
  deviceMode: DeviceMode;
  setDeviceMode: (mode: DeviceMode) => void;
  isLoading: boolean;
  isSyncing: boolean;
  steamImport: SteamImportProgress;
  steamImportChecked: boolean;
  loadError: string | null;
  refresh: (options?: { quiet?: boolean }) => Promise<boolean>;
  checkSteamImport: () => Promise<SteamImportProgress>;
  syncSteamLibrary: (options?: { restart?: boolean }) => Promise<number>;
  signOut: () => Promise<void>;
  createCollection: (payload: CollectionInput) => Promise<string>;
  updateCollection: (collectionId: string, payload: CollectionInput) => Promise<void>;
  removeCollection: (collectionId: string) => Promise<void>;
  updateGame: (gameId: string, patch: { status?: DemoGame["status"]; completionPercent?: number; hoursPlayed?: number; notes?: string; priority?: DemoGame["priority"]; completedAt?: string | null; sleptAt?: string | null; completionSuggestionDismissedAt?: string | null; completionSuggestionDismissedPlaytime?: number | null }) => Promise<void>;
  restoreGame: (gameId: string) => Promise<void>;
  setGameCollection: (gameId: string, collectionId: string, assigned: boolean) => Promise<void>;
  addGamesToCollection: (collectionId: string, gameIds: string[]) => Promise<void>;
  recordVaultAction: (action: VaultAction, gameId: string, context?: Record<string, unknown>) => Promise<void>;
  recordVaultDraw: (gameId: string, input: VaultDrawInput) => Promise<VaultDraw>;
  loadVaultHistory: () => Promise<void>;
  recordDrawEvent: (drawId: string, eventType: VaultDrawEventType, analytics?: Record<string, unknown>) => Promise<void>;
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
  if (!response.ok) {
    announceCooldown(response, payload);
    throw new Error(payload.error || "Request failed.");
  }
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
  const [liveGenrePreferenceGlobals, setLiveGenrePreferenceGlobals] = useState<GenrePreference[]>(EMPTY_GENRE_PREFERENCES);
  const [livePlaytime, setLivePlaytime] = useState<PlaytimeSummary>(EMPTY_PLAYTIME);
  const [isLive, setIsLive] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [steamImport, setSteamImport] = useState<SteamImportProgress>(IDLE_STEAM_IMPORT);
  const [steamImportChecked, setSteamImportChecked] = useState(false);
  const [playHistoryMissing, setPlayHistoryMissing] = useState(false);
  const [deviceMode, setDeviceModeState] = useState<DeviceMode>("all");
  const [loadError, setLoadError] = useState<string | null>(null);
  const syncPromiseRef = useRef<Promise<number> | null>(null);

  /**
   * Send a write that the screen has already acted on.
   *
   * Every one of these is applied locally first, so the caller does not wait and
   * neither does the person who pressed the button. What the caller gives up is
   * being told it worked - so if it did not, the page is put back to whatever
   * the server actually holds rather than left showing a change that never
   * happened.
   */
  function queueWrite(request: Promise<unknown>) {
    void request.catch(() => {
      setLoadError("That change could not be saved. Your library has been put back to what is stored.");
      void load();
    });
  }

  /**
   * Re-read everything.
   *
   * `quiet` re-reads without announcing it. A page that refreshes after an
   * action it has already applied locally has nothing to wait for, and raising
   * isLoading drops it back to its skeletons - so making a Purge decision
   * blanked the whole page for the length of a round trip and then rebuilt it.
   */
  async function load({ quiet = false }: { quiet?: boolean } = {}) {
    if (!quiet) setIsLoading(true);
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
        return false;
      }

      setIsLive(true);
      const { games, collections, memberships, vaultState } = bootstrap;
      if (bootstrap.data_error || !games || !collections || !memberships || !vaultState) {
        setLoadError("Your VaultShuffle data could not be loaded. Please retry.");
        return false;
      }

      const details = buildCollectionDetails(collections, games, memberships);

      setLiveCollections(mapLiveCollections(details));
      setLiveGames(mapLiveGames(games, details));
      setLiveVaultState(vaultState);
      // Absent for a user the nightly rebuild has not reached yet, which simply
      // means the learned term contributes nothing to their scores.
      setLiveGenrePreferences(bootstrap.genrePreferences ?? EMPTY_GENRE_PREFERENCES);
      setLiveGenrePreferenceGlobals(bootstrap.genrePreferenceGlobals ?? EMPTY_GENRE_PREFERENCES);
      setLivePlaytime(bootstrap.playtime ?? EMPTY_PLAYTIME);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === "unauthorized") {
        setSession(guestSession);
        setIsLive(false);
      } else {
        setLoadError(
          isLive
            ? "VaultShuffle could not reload your data. Your existing view is still available."
            : "VaultShuffle could not check your session. Guest preview is still available."
        );
      }
      return false;
    } finally {
      if (!quiet) setIsLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (isLoading) return;
    if (!isLive) {
      setSteamImport(IDLE_STEAM_IMPORT);
      setSteamImportChecked(true);
      return;
    }
    void checkSteamImport().catch((error) => {
      console.error("Could not check Steam import status", error);
      setSteamImport((current) => ({
        ...current,
        status: "failed",
        lastError: "VaultShuffle could not check the saved Steam import. Retry to check again."
      }));
    });
  }, [isLive, isLoading]);

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
  //
  // Registered immediately rather than after the session resolves. Everyone
  // arrives as a guest and is promoted if a session comes back, so waiting only
  // meant the first events of every visit - the ones at the top of the funnel -
  // carried no audience at all and dropped out of any split by it.
  useEffect(() => {
    setAnalyticsAudience(!isLive);
  }, [isLive]);

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

  async function checkSteamImport() {
    try {
      const result = await api<{ progress: SteamImportProgress }>("/api/steam/owned-games");
      setSteamImport(result.progress);
      return result.progress;
    } finally {
      setSteamImportChecked(true);
    }
  }

  function syncSteamLibrary(options: { restart?: boolean } = {}) {
    if (syncPromiseRef.current) return syncPromiseRef.current;
    const promise = runSteamLibrarySync(options);
    syncPromiseRef.current = promise;
    void promise.finally(() => {
      if (syncPromiseRef.current === promise) syncPromiseRef.current = null;
    }).catch(() => undefined);
    return promise;
  }

  async function runSteamLibrarySync({ restart = true }: { restart?: boolean }) {
    if (!isLive) throw new Error("Sign in with Steam before syncing your library.");

    setIsSyncing(true);
    setSteamImport((current) => ({
      ...current,
      status: restart ? "fetching" : current.status,
      imported: restart ? 0 : current.imported,
      total: restart ? 0 : current.total,
      percent: restart ? 0 : current.percent,
      lastError: null,
      completedAt: restart ? null : current.completedAt
    }));
    let steamImportSaved = restart ? false : steamImport.imported > 0;
    let importCompleted = false;
    try {
      let result = await requestSteamImportBatch(restart);
      setSteamImport(result.progress);
      steamImportSaved = result.progress.imported > 0;

      let unchangedResponses = 0;
      while (result.progress.status === "importing") {
        if (result.retry_after_seconds) {
          const retryAfterMs = result.retry_after_seconds * 1000;
          await new Promise((resolve) => window.setTimeout(resolve, retryAfterMs));
        }
        const previousImported = result.progress.imported;
        result = await requestSteamImportBatch(false);
        setSteamImport(result.progress);
        steamImportSaved ||= result.progress.imported > 0;
        unchangedResponses = result.progress.imported === previousImported
          ? unchangedResponses + 1
          : 0;
        if (unchangedResponses >= 3) {
          throw new Error("The Steam import stopped making progress. Its saved batches are safe; retry to resume.");
        }
      }

      if (result.progress.status === "failed") {
        throw new Error(result.progress.lastError || "The Steam import paused before it finished.");
      }
      importCompleted = result.progress.status === "complete";

      const refreshed = await load();
      if (!refreshed) {
        throw new Error(
          "Steam data was saved, but VaultShuffle could not reload it. Your sync is safe; try again in a moment."
        );
      }
      trackEvent(ANALYTICS_EVENTS.steamLibrarySynced, {
        imported_count: result.progress.total,
        play_history_missing: result.progress.playHistoryMissing
      });
      setPlayHistoryMissing(result.progress.playHistoryMissing);
      return result.progress.total;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The Steam import stopped before it finished.";
      if (!importCompleted) {
        setSteamImport((current) => ({ ...current, status: "failed", lastError: message }));
      }
      // A failed first import is the highest-intent moment in the funnel failing.
      // Reporting only successes would leave it invisible, which is exactly how
      // the Steam launch event stayed at zero for a month.
      if (!steamImportSaved) {
        trackEvent(ANALYTICS_EVENTS.steamImportFailed, {
          reason: message,
          first_import: liveGames.length === 0
        });
      }
      throw error;
    } finally {
      setIsSyncing(false);
    }
  }

  function requestSteamImportBatch(restart: boolean) {
    return api<{ progress: SteamImportProgress; retry_after_seconds?: number }>("/api/steam/owned-games", {
      method: "POST",
      body: JSON.stringify({ restart })
    });
  }

  async function signOut() {
    await api("/api/logout", { method: "POST" });
    trackEvent(ANALYTICS_EVENTS.signedOut);
    window.location.assign("/");
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
    trackEvent(ANALYTICS_EVENTS.collectionCreated, {
      kind: payload.kind ?? "custom",
    });
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
    trackEvent(ANALYTICS_EVENTS.collectionUpdated, {
      kind: payload.kind ?? "custom",
    });
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
      // The change lands before the request goes out. Sleeping a game used to
      // wait on a round trip to Supabase, which is a quarter of a second of a
      // menu sitting there doing nothing after you pressed it - and the local
      // transform is the same one that was going to be applied afterwards
      // anyway, so applying it first costs nothing and changes nothing.
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

      queueWrite(api(`/api/games/${gameId}`, {
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
      }));
      return;
    }

    setGuestGames((current) => current.map((game) => game.id === gameId ? applyGamePatch(game, patch) : game));
    if (patch.status) {
      trackEvent(ANALYTICS_EVENTS.gameStatusChanged, {
        status: patch.status,
      });
    }
    if (patch.status === "Completed" || patch.status === "Slept") {
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
    trackEvent(ANALYTICS_EVENTS.gameStatusChanged, {
      status: "Active",
      restored: true,
    });
  }

  /**
   * Adding several games at once.
   *
   * setGameCollection reloads the whole app after every call, which is right for
   * one tick in a drawer and completely wrong for forty from a picker: it would
   * reload forty times. This writes them all, then reloads once.
   */
  async function addGamesToCollection(collectionId: string, gameIds: string[]) {
    if (!gameIds.length) return;

    if (isLive) {
      // Serial rather than parallel: the writes take a per-user advisory lock, so
      // firing forty at once queues them on the database instead of the client.
      for (const gameId of gameIds) {
        await api(`/api/collections/${collectionId}/games`, {
          method: "POST",
          body: JSON.stringify({ game_id: gameId })
        });
      }
      await load();
      trackEvent(ANALYTICS_EVENTS.collectionMembershipChanged, { action: "added", count: gameIds.length });
      return;
    }

    const adding = new Set(gameIds);
    setGuestGames((current) => current.map((game) => adding.has(game.id) && !game.collectionIds.includes(collectionId)
      ? { ...game, collectionIds: [...game.collectionIds, collectionId] }
      : game));
    trackEvent(ANALYTICS_EVENTS.collectionMembershipChanged, { action: "added", count: gameIds.length });
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
    trackEvent(ANALYTICS_EVENTS.collectionMembershipChanged, {
      action: assigned ? "added" : "removed",
    });
  }

  async function recordVaultAction(action: VaultAction, gameId: string, context: Record<string, unknown> = {}) {
    if (isLive) {
      // Predicted locally so the pin appears under the cursor, then replaced by
      // the server's own answer when it arrives. The two agree in every ordinary
      // case; where they do not, the server wins.
      const pinnedGame = liveGames.find((game) => game.id === gameId);
      setLiveVaultState((current) => predictVaultState(current, action, gameId, context, pinnedGame?.hoursPlayed ?? null));
      const liveEvent = VAULT_ACTION_EVENT_NAMES[action];
      if (liveEvent) trackEvent(liveEvent, { action });

      queueWrite(
        api<VaultState>("/api/vault/state", {
          method: "POST",
          body: JSON.stringify({ action, game_id: gameId, context })
        }).then(setLiveVaultState)
      );
      return;
    }

    // Through the same predictor as a live pin. The bare reducer rebuilt every
    // pin from the id list, which stamped null over the playtime the older pins
    // were made at - so a guest's second pin erased the first one's progress,
    // and no guest pin ever had a figure to measure "since you pinned it" from.
    const guestGame = guestGames.find((game) => game.id === gameId);
    setGuestVaultState((current) => predictVaultState(current, action, gameId, context, guestGame?.hoursPlayed ?? 0));
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
      const { state, draw } = await api<{ state: VaultState; draw: VaultDraw }>("/api/vault/history", { method: "POST", body: JSON.stringify({ game_id: gameId, steam_app_id: input.steamAppId, session: input.session, mood: input.mood, goal: input.goal, collection_id: input.collectionId, selected_genres: input.selectedGenres, eligible_pool_count: input.eligiblePoolCount, reroll_index: input.rerollIndex, finalist_appids: input.finalistAppIds }) });
      setLiveVaultState(state);
      setLiveVaultHistory((current) => [draw, ...current].slice(0, 50));
      return draw;
    }
    const draw: VaultDraw = { ...input, id: crypto.randomUUID(), drawnAt: new Date().toISOString(), events: [] };
    setGuestVaultState((current) => reduceGuestVaultState(current, "drawn", gameId, {}));
    setGuestVaultHistory((current) => [draw, ...current].slice(0, 50));
    return draw;
  }

  async function recordDrawEvent(drawId: string, eventType: VaultDrawEventType, analytics: Record<string, unknown> = {}) {
    // Analytics fire before the API call, not after it. "opened_on_steam" is
    // triggered by a link that navigates to a steam:// URL, so anything queued
    // behind an await is cancelled with the page and never reaches PostHog.
    // The experiment arm and reroll depth ride along on every follow-up event:
    // the arm is per draw, so it cannot be a super-property, and the outcome
    // metric is measured on this event rather than on the draw that preceded it.
    const properties: Record<string, unknown> = {
      draw_id: drawId,
      draw_action: eventType,
      ...analytics,
    };
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
    trackEvent(ANALYTICS_EVENTS.vaultHistoryCleared);
  }

  const visibleGames = useMemo(
    () => (isLive ? liveGames : guestGames).filter((game) => matchesDeviceMode(game, deviceMode)),
    [deviceMode, guestGames, isLive, liveGames]
  );
  const activePlaytime = isLive ? livePlaytime : EMPTY_PLAYTIME;
  const capabilities = useMemo(() => steamCapabilities({
    isLive,
    games: visibleGames,
    playtimeVisible: session.steam_playtime_visible !== false,
    daysTracked: activePlaytime.daysTracked
  }), [activePlaytime.daysTracked, isLive, session.steam_playtime_visible, visibleGames]);

  const value = useMemo<AppDataContextValue>(
    () => ({
      session,
      playHistoryMissing,
      capabilities,
      deviceMode,
      setDeviceMode,
      games: visibleGames,
      collections: isLive ? liveCollections : guestCollections,
      vaultState: isLive ? liveVaultState : guestVaultState,
      // Guests have no history to learn from, so they always draw unweighted.
      genrePreferences: isLive ? liveGenrePreferences : EMPTY_GENRE_PREFERENCES,
      genrePreferenceGlobals: isLive ? liveGenrePreferenceGlobals : EMPTY_GENRE_PREFERENCES,
      playtime: activePlaytime,
      vaultHistory: isLive ? liveVaultHistory : guestVaultHistory,
      isLive,
      isLoading,
      isSyncing,
      steamImport,
      steamImportChecked,
      loadError,
      refresh: load,
      checkSteamImport,
      syncSteamLibrary,
      signOut,
      createCollection,
      updateCollection,
      removeCollection,
      updateGame,
      restoreGame,
      setGameCollection,
      addGamesToCollection,
      recordVaultAction,
      recordVaultDraw,
      loadVaultHistory,
      recordDrawEvent,
      clearVaultHistory
    }),
    [capabilities, session, isLive, isLoading, isSyncing, steamImport, steamImportChecked, loadError, playHistoryMissing, deviceMode, liveGames, liveCollections, guestGames, guestCollections, liveVaultState, guestVaultState, liveGenrePreferences, liveGenrePreferenceGlobals, livePlaytime, liveVaultHistory, guestVaultHistory]
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

/**
 * What the vault state will be once the server agrees, applied before asking it.
 *
 * Pins that already existed keep their pinnedAt and hoursAtPin: those are what
 * "3.2h played since you pinned it" is measured from, and rebuilding them from
 * the id list alone would blank that line for the length of the round trip. A
 * new pin is stamped with the playtime it has now, which is what the server
 * records too, so the label reads "Not started yet" from the first frame.
 */
function predictVaultState(
  state: VaultState,
  action: VaultAction,
  gameId: string,
  context: Record<string, unknown>,
  hoursNow: number | null
): VaultState {
  const next = reduceGuestVaultState(state, action, gameId, context);
  const existing = new Map((state.pins ?? []).map((pin) => [pin.gameId, pin]));
  return {
    ...next,
    pins: next.pinnedIds.map((id) => existing.get(id) ?? {
      gameId: id,
      pinnedAt: new Date().toISOString(),
      hoursAtPin: id === gameId ? hoursNow : null
    })
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

  // Guests keep the shape but not the history: their pins live only for the session.
  return {
    pinnedIds,
    pins: pinnedIds.map((id) => ({ gameId: id, pinnedAt: null, hoursAtPin: null })),
    snoozedIds: [...snoozedIds],
    currentPickId
  };
}

export function useAppData() {
  const context = useContext(AppDataContext);
  if (!context) throw new Error("useAppData must be used within AppDataProvider");
  return context;
}
