"use client";

import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { demoCollections, demoGames, type DemoCollection, type DemoGame } from "@/lib/demo-data";
import { guestSession, mapLiveCollections, mapLiveGames, type CollectionDetailPayload } from "@/lib/app-view-model";
import type { Collection, Game, SessionPayload, SteamSearchResult } from "@/lib/types";
import type { VaultAction, VaultState } from "@/lib/vault-state";

const emptyVaultState: VaultState = { pinnedIds: [], snoozedIds: [], currentPickId: null };

type AppDataContextValue = {
  session: SessionPayload;
  games: DemoGame[];
  collections: DemoCollection[];
  vaultState: VaultState;
  isLive: boolean;
  isLoading: boolean;
  isSyncing: boolean;
  refresh: () => Promise<void>;
  syncSteamLibrary: () => Promise<number>;
  signOut: () => Promise<void>;
  createCollection: (payload: { name: string; description: string }) => Promise<void>;
  updateCollection: (collectionId: string, payload: { name: string; description: string }) => Promise<void>;
  removeCollection: (collectionId: string) => Promise<void>;
  searchSteam: (query: string) => Promise<SteamSearchResult[]>;
  addWishlistGame: (payload: { title: string; genre: string; steamAppId?: string; image?: string }) => Promise<void>;
  updateGame: (gameId: string, patch: { status?: DemoGame["status"]; completionPercent?: number; hoursPlayed?: number; notes?: string; priority?: DemoGame["priority"] }) => Promise<void>;
  setGameCollection: (gameId: string, collectionId: string, assigned: boolean) => Promise<void>;
  removeGame: (gameId: string) => Promise<void>;
  recordVaultAction: (action: VaultAction, gameId: string, context?: Record<string, unknown>) => Promise<void>;
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
  const [isLive, setIsLive] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);

  async function load() {
    setIsLoading(true);
    try {
      const nextSession = await api<SessionPayload>("/api/session");
      setSession(nextSession);

      if (!nextSession.logged_in) {
        setIsLive(false);
        return;
      }

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
      setIsLive(true);
    } catch {
      setSession(guestSession);
      setIsLive(false);
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

  async function signOut() {
    await api("/api/logout", { method: "POST" });
    window.location.assign("/login");
  }

  async function createCollection(payload: { name: string; description: string }) {
    if (isLive) {
      await api("/api/collections", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      await load();
      return;
    }

    const nextCollection: DemoCollection = {
      id: `custom-${payload.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      kind: "custom",
      name: payload.name,
      description: payload.description || "Freshly created and ready for curating.",
      artworkUrl: "/assets/vault/vault-stage-open.png",
      accent: "New collection draft."
    };

    setGuestCollections((current) => [nextCollection, ...current]);
  }

  async function updateCollection(collectionId: string, payload: { name: string; description: string }) {
    if (isLive) {
      await api(`/api/collections/${collectionId}`, { method: "PATCH", body: JSON.stringify(payload) });
      await load();
      return;
    }
    setGuestCollections((current) => current.map((collection) => collection.id === collectionId ? {
      ...collection,
      name: payload.name,
      description: payload.description
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
        salePrice: "TBD",
        collectionIds: [],
        sessionFit: ["evening"],
        moodTags: ["story"]
      },
      ...current
    ]);
  }

  async function updateGame(
    gameId: string,
    patch: { status?: DemoGame["status"]; completionPercent?: number; hoursPlayed?: number; notes?: string; priority?: DemoGame["priority"] }
  ) {
    if (isLive) {
      await api(`/api/games/${gameId}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: patch.status,
          completion_percentage: patch.completionPercent,
          hours_played: patch.hoursPlayed,
          notes: patch.notes,
          priority: patch.priority
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
              completionPercent: patch.completionPercent ?? game.completionPercent,
              hoursPlayed: patch.hoursPlayed ?? game.hoursPlayed,
              priority: patch.priority ?? game.priority,
              notes: patch.notes ?? game.notes,
              description: patch.notes?.trim() ? patch.notes : game.description
            }
          : game
      )
    );
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

    setGuestVaultState((current) => reduceGuestVaultState(current, action, gameId));
  }

  const value = useMemo<AppDataContextValue>(
    () => ({
      session,
      games: isLive ? liveGames : guestGames,
      collections: isLive ? liveCollections : guestCollections,
      vaultState: isLive ? liveVaultState : guestVaultState,
      isLive,
      isLoading,
      isSyncing,
      refresh: load,
      syncSteamLibrary,
      signOut,
      createCollection,
      updateCollection,
      removeCollection,
      searchSteam,
      addWishlistGame,
      updateGame,
      setGameCollection,
      removeGame,
      recordVaultAction
    }),
    [session, isLive, isLoading, isSyncing, liveGames, liveCollections, guestGames, guestCollections, liveVaultState, guestVaultState]
  );

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

function reduceGuestVaultState(state: VaultState, action: VaultAction, gameId: string): VaultState {
  const pinnedIds = new Set(state.pinnedIds);
  const snoozedIds = new Set(state.snoozedIds);
  let currentPickId = state.currentPickId;

  if (action === "drawn") currentPickId = gameId;
  if (action === "pinned") pinnedIds.add(gameId);
  if (action === "unpinned") pinnedIds.delete(gameId);
  if (action === "snoozed") {
    snoozedIds.add(gameId);
    if (currentPickId === gameId) currentPickId = null;
  }
  if (action === "unsnoozed") snoozedIds.delete(gameId);

  return { pinnedIds: [...pinnedIds], snoozedIds: [...snoozedIds], currentPickId };
}

export function useAppData() {
  const context = useContext(AppDataContext);
  if (!context) throw new Error("useAppData must be used within AppDataProvider");
  return context;
}
