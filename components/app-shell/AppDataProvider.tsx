"use client";

import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { demoCollections, demoGames, type DemoCollection, type DemoGame } from "@/lib/demo-data";
import { guestSession, mapLiveCollections, mapLiveGames, type CollectionDetailPayload } from "@/lib/app-view-model";
import type { Collection, Game, SessionPayload, SmartCollectionPreset, SteamSearchResult } from "@/lib/types";
import type { VaultAction, VaultState } from "@/lib/vault-state";
import type { VaultDraw, VaultDrawEventType, VaultDrawInput } from "@/lib/vault-history";

type CollectionInput = { name: string; description: string; kind?: "custom" | "smart"; rules?: { preset: SmartCollectionPreset } };

const emptyVaultState: VaultState = { pinnedIds: [], wishlistPinnedIds: [], snoozedIds: [], currentPickId: null };

type AppDataContextValue = {
  session: SessionPayload;
  games: DemoGame[];
  collections: DemoCollection[];
  vaultState: VaultState;
  vaultHistory: VaultDraw[];
  isLive: boolean;
  isLoading: boolean;
  isSyncing: boolean;
  loadError: string | null;
  refresh: () => Promise<void>;
  syncSteamLibrary: () => Promise<number>;
  refreshSteamMetadata: (force?: boolean) => Promise<number>;
  signOut: () => Promise<void>;
  createCollection: (payload: CollectionInput) => Promise<string>;
  updateCollection: (collectionId: string, payload: CollectionInput) => Promise<void>;
  removeCollection: (collectionId: string) => Promise<void>;
  searchSteam: (query: string) => Promise<SteamSearchResult[]>;
  addWishlistGame: (payload: { title: string; genre: string; steamAppId?: string; image?: string }) => Promise<void>;
  updateGame: (gameId: string, patch: { status?: DemoGame["status"]; completionPercent?: number; hoursPlayed?: number; notes?: string; priority?: DemoGame["priority"]; completedAt?: string | null; sleptAt?: string | null; completionSuggestionDismissedAt?: string | null; completionSuggestionDismissedPlaytime?: number | null }) => Promise<void>;
  restoreGame: (gameId: string) => Promise<void>;
  setGameCollection: (gameId: string, collectionId: string, assigned: boolean) => Promise<void>;
  removeGame: (gameId: string) => Promise<void>;
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
  const [guestGames, setGuestGames] = useState<DemoGame[]>(demoGames);
  const [guestCollections, setGuestCollections] = useState<DemoCollection[]>(demoCollections);
  const [liveGames, setLiveGames] = useState<DemoGame[]>([]);
  const [liveCollections, setLiveCollections] = useState<DemoCollection[]>([]);
  const [guestVaultState, setGuestVaultState] = useState<VaultState>(emptyVaultState);
  const [liveVaultState, setLiveVaultState] = useState<VaultState>(emptyVaultState);
  const [guestVaultHistory, setGuestVaultHistory] = useState<VaultDraw[]>([]);
  const [liveVaultHistory, setLiveVaultHistory] = useState<VaultDraw[]>([]);
  const [isLive, setIsLive] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setLoadError(null);
    try {
      const nextSession = await api<SessionPayload>("/api/session");
      setSession(nextSession);

      if (!nextSession.logged_in) {
        setIsLive(false);
        return;
      }

      setIsLive(true);
      try {
        const [{ games }, { collections }, nextVaultState] = await Promise.all([
          api<{ games: Game[] }>("/api/games"),
          api<{ collections: Collection[] }>("/api/collections"),
          api<VaultState>("/api/vault/state")
        ]);

        const details = await Promise.all(
          collections.map((collection) =>
            api<CollectionDetailPayload>(`/api/collections/${collection.id}`).catch(() => ({
              collection,
              games: []
            }))
          )
        );

        setLiveCollections(mapLiveCollections(details));
        setLiveGames(mapLiveGames(games, details));
        setLiveVaultState(nextVaultState);
      } catch (error) {
        setLoadError(error instanceof Error && error.message !== "Request failed."
          ? error.message
          : "Your VaultShuffle data could not be loaded. Please retry.");
      }
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

  async function syncSteamLibrary() {
    if (!isLive) throw new Error("Sign in with Steam before syncing your library.");

    setIsSyncing(true);
    try {
      const result = await api<{ imported: number }>("/api/steam/owned-games", { method: "POST" });
      await load();
      return result.imported;
    } finally {
      setIsSyncing(false);
    }
  }

  async function refreshSteamMetadata(force = false) {
    if (!isLive) return 0;
    let updated = 0;
    let remaining = 0;
    let batch = 0;

    do {
      const result = await api<{ updated: number; remaining: number }>("/api/steam/metadata", {
        method: "POST",
        body: JSON.stringify({ limit: 24, wishlist_only: true, force: force && batch === 0 })
      });
      updated += result.updated;
      remaining = result.remaining;
      batch += 1;
    } while (remaining > 0 && batch < 10);

    if (updated > 0) await load();
    return updated;
  }

  async function signOut() {
    await api("/api/logout", { method: "POST" });
    window.location.assign("/login");
  }

  async function createCollection(payload: CollectionInput) {
    if (isLive) {
      const { collection } = await api<{ collection: Collection }>("/api/collections", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      await load();
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
    return nextCollection.id;
  }

  async function updateCollection(collectionId: string, payload: CollectionInput) {
    if (isLive) {
      await api(`/api/collections/${collectionId}`, { method: "PATCH", body: JSON.stringify(payload) });
      await load();
      return;
    }
    setGuestCollections((current) => current.map((collection) => collection.id === collectionId ? {
      ...collection,
      name: payload.name,
      description: payload.description,
      kind: payload.kind ?? collection.kind,
      smartPreset: payload.kind === "custom" ? undefined : payload.rules?.preset ?? collection.smartPreset
    } : collection));
  }

  async function removeCollection(collectionId: string) {
    if (isLive) {
      await api(`/api/collections/${collectionId}`, { method: "DELETE" });
      await load();
      return;
    }
    setGuestCollections((current) => current.filter((collection) => collection.id !== collectionId));
    setGuestGames((current) => current.map((game) => ({
      ...game,
      collectionIds: game.collectionIds.filter((id) => id !== collectionId)
    })));
  }

  async function searchSteam(query: string) {
    const result = await api<{ results: SteamSearchResult[] }>(`/api/steam/search?q=${encodeURIComponent(query.trim())}`);
    return result.results;
  }

  async function addWishlistGame(payload: { title: string; genre: string; steamAppId?: string; image?: string }) {
    if (isLive) {
      await api("/api/games", {
        method: "POST",
        body: JSON.stringify({
          title: payload.title,
          genre: payload.genre || "Unknown",
          store: "Steam",
          ownership: "Wishlist",
          status: "Not Started",
          rating: 0,
          hours_played: 0,
          completion_percentage: 0,
          priority: "High",
          date_added: new Date().toLocaleDateString("en-GB"),
          last_played_at: null,
          notes: "",
          steam_appid: payload.steamAppId || null
        })
      });
      await load();
      return;
    }

    setGuestGames((current) => [
      {
        id: `wishlist-${payload.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        title: payload.title,
        steamAppId: Number(payload.steamAppId || 753640),
        ownership: "Wishlist",
        status: "Not Started",
        hoursPlayed: 0,
        completionPercent: 0,
        priority: "High",
        genres: [payload.genre || "Adventure"],
        description: "Freshly added to the redesign wishlist flow.",
        artworkUrl: payload.image || "/assets/vault/vault-stage-open.png",
        bannerUrl: payload.image || "/assets/vault/vault-stage-open.png",
        lastPlayedLabel: "Wishlist",
        addedLabel: "Added just now",
        collectionIds: [],
        sessionFit: ["evening"],
        moodTags: []
      },
      ...current
    ]);
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
      await load();
      return;
    }

    setGuestGames((current) =>
      current.map((game) =>
        game.id === gameId
          ? {
              ...game,
              status: patch.status ?? game.status,
              completionPercent: Math.min(99, patch.completionPercent ?? game.completionPercent),
              hoursPlayed: patch.hoursPlayed ?? game.hoursPlayed,
              priority: patch.priority ?? game.priority,
              notes: patch.notes ?? game.notes,
              description: patch.notes?.trim() ? patch.notes : game.description,
              completedAt: patch.completedAt !== undefined ? patch.completedAt : patch.status === "Completed" ? new Date().toISOString() : patch.status ? null : game.completedAt,
              previousActiveStatus: patch.status === "Completed" && game.status !== "Completed"
                ? (game.status === "In Progress" ? "In Progress" : "Not Started")
                : game.previousActiveStatus,
              sleptAt: patch.sleptAt !== undefined ? patch.sleptAt : patch.status === "Slept" ? new Date().toISOString() : patch.status ? null : game.sleptAt,
              completionSuggestionDismissedAt: patch.completionSuggestionDismissedAt ?? game.completionSuggestionDismissedAt,
              completionSuggestionDismissedPlaytime: patch.completionSuggestionDismissedPlaytime ?? game.completionSuggestionDismissedPlaytime
            }
          : game
      )
    );
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
      await load();
      return;
    }

    setGuestGames((current) => current.map((game) => game.id === gameId ? {
      ...game,
      status: game.previousActiveStatus ?? "Not Started",
      completedAt: null,
      sleptAt: null,
      previousActiveStatus: null
    } : game));
  }

  async function setGameCollection(gameId: string, collectionId: string, assigned: boolean) {
    if (isLive) {
      await api(`/api/collections/${collectionId}/games${assigned ? "" : `/${gameId}`}`, {
        method: assigned ? "POST" : "DELETE",
        body: assigned ? JSON.stringify({ game_id: gameId }) : undefined
      });
      await load();
      return;
    }

    setGuestGames((current) => current.map((game) => game.id === gameId ? {
      ...game,
      collectionIds: assigned
        ? Array.from(new Set([...game.collectionIds, collectionId]))
        : game.collectionIds.filter((id) => id !== collectionId)
    } : game));
  }

  async function removeGame(gameId: string) {
    if (isLive) {
      await api(`/api/games/${gameId}`, { method: "DELETE" });
      await load();
      return;
    }
    setGuestGames((current) => current.filter((game) => game.id !== gameId));
  }

  async function recordVaultAction(action: VaultAction, gameId: string, context: Record<string, unknown> = {}) {
    if (isLive) {
      const nextState = await api<VaultState>("/api/vault/state", {
        method: "POST",
        body: JSON.stringify({ action, game_id: gameId, context })
      });
      setLiveVaultState(nextState);
      return;
    }

    setGuestVaultState((current) => reduceGuestVaultState(current, action, gameId, context));
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
      games: isLive ? liveGames : guestGames,
      collections: isLive ? liveCollections : guestCollections,
      vaultState: isLive ? liveVaultState : guestVaultState,
      vaultHistory: isLive ? liveVaultHistory : guestVaultHistory,
      isLive,
      isLoading,
      isSyncing,
      loadError,
      refresh: load,
      syncSteamLibrary,
      refreshSteamMetadata,
      signOut,
      createCollection,
      updateCollection,
      removeCollection,
      searchSteam,
      addWishlistGame,
      updateGame,
      restoreGame,
      setGameCollection,
      removeGame,
      recordVaultAction,
      recordVaultDraw,
      loadVaultHistory,
      recordDrawEvent,
      clearVaultHistory
    }),
    [session, isLive, isLoading, isSyncing, loadError, liveGames, liveCollections, guestGames, guestCollections, liveVaultState, guestVaultState, liveVaultHistory, guestVaultHistory]
  );

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

function reduceGuestVaultState(state: VaultState, action: VaultAction, gameId: string, context: Record<string, unknown>): VaultState {
  let pinnedIds = [...state.pinnedIds];
  let wishlistPinnedIds = [...state.wishlistPinnedIds];
  const snoozedIds = new Set(state.snoozedIds);
  let currentPickId = state.currentPickId;
  const pinScope = context.pin_scope === "wishlist" ? "wishlist" : "library";

  if (action === "drawn") currentPickId = gameId;
  if (action === "pinned" && pinScope === "wishlist" && !wishlistPinnedIds.includes(gameId)) {
    const replaceId = String(context.replace_game_id ?? "");
    if (wishlistPinnedIds.length < 3) wishlistPinnedIds.push(gameId);
    else if (wishlistPinnedIds.includes(replaceId)) wishlistPinnedIds[wishlistPinnedIds.indexOf(replaceId)] = gameId;
  }
  if (action === "unpinned" && pinScope === "wishlist") wishlistPinnedIds = wishlistPinnedIds.filter((id) => id !== gameId);
  if (action === "pinned" && pinScope === "library" && !pinnedIds.includes(gameId)) {
    const replaceId = String(context.replace_game_id ?? "");
    if (pinnedIds.length < 3) pinnedIds.push(gameId);
    else if (pinnedIds.includes(replaceId)) pinnedIds[pinnedIds.indexOf(replaceId)] = gameId;
  }
  if (action === "unpinned" && pinScope === "library") pinnedIds = pinnedIds.filter((id) => id !== gameId);
  if (action === "snoozed") {
    snoozedIds.add(gameId);
    if (currentPickId === gameId) currentPickId = null;
  }
  if (action === "unsnoozed") snoozedIds.delete(gameId);

  return { pinnedIds, wishlistPinnedIds, snoozedIds: [...snoozedIds], currentPickId };
}

export function useAppData() {
  const context = useContext(AppDataContext);
  if (!context) throw new Error("useAppData must be used within AppDataProvider");
  return context;
}
