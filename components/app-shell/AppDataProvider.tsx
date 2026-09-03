"use client";

import { steamCapabilities, type SteamCapabilities } from "@/lib/steam-capabilities";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { demoGames, type DemoCollection, type DemoGame } from "@/lib/demo-data";
import { buildCollectionDetails, guestPreviewCollection, guestSession, mapGuestGames, mapLiveCollections, mapLiveGames, withFamilyOwnerNames } from "@/lib/app-view-model";
import { FAMILY_SHARING_ENABLED } from "@/lib/family-flag";
import type { FamilyImportCounts } from "@/lib/family-sharing";
import { ANALYTICS_EVENTS, setAnalyticsAudience, trackEvent, trackNavigationEvent } from "@/lib/analytics";
import type { Collection, Game, SessionPayload, SmartCollectionPreset } from "@/lib/types";
import type { CollectionMembership } from "@/lib/collections";
import type { VaultAction, VaultState } from "@/lib/vault-state";
import type { VaultDraw, VaultDrawEventType, VaultDrawInput } from "@/lib/vault-history";
import type { GenrePreference } from "@/lib/genre-preferences";
import type { PlaytimeSummary } from "@/lib/playtime-summary";
import type { PinnedPlaytimeResult } from "@/lib/pinned-playtime";
import { mergePinnedPlaytime } from "@/lib/pinned-playtime-view";
import {
  DEFAULT_GLOBAL_FILTERS,
  isDefaultGlobalFilters,
  matchesGlobalFilters,
  parseGlobalFilters,
  type DeviceMode,
  type GlobalFilters
} from "@/lib/global-filters";
import { CooldownError, SteamLibraryPrivateError } from "@/lib/cooldown";
import { requestJson as api } from "@/lib/api-client";
import { abandonSession, announceSessionProvider, publishSession } from "@/lib/analytics-session";
import { withTransientRetry } from "@/lib/request-failure";
import { diagnosticFailure, diagnosticId } from "@/lib/diagnostics";
import { readStoredCooldown, saveCooldown, storedCooldownError } from "@/lib/cooldown-storage";
import { RECORDED_FINALIST_LIMIT } from "@/lib/vault";
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
  gamePreferences?: Record<string, [number, number, number]>;
  playtime?: PlaytimeSummary;
  data_error?: boolean;
  guest_pool_source?: "live_catalogue" | "fallback";
};

/** Served by /guest-catalogue rather than the bootstrap, so that the CDN can cache it. */
type GuestCataloguePayload = {
  games?: Game[];
  guest_pool_source?: "live_catalogue" | "fallback";
};

/** Re-exported so existing consumers keep importing this from one place. */
export type { DeviceMode } from "@/lib/global-filters";

/**
 * Device mode used to be the only global filter and had a key of its own. The
 * panel now carries four more, so they are stored together - and the old key is
 * read once on load so nobody's Deck or Mac mode is silently forgotten.
 */
const GLOBAL_FILTERS_KEY = "vault-global-filters";
const LEGACY_DEVICE_MODE_KEY = "vault-device-mode";

const emptyVaultState: VaultState = { pinnedIds: [], pins: [], snoozedIds: [], currentPickId: null };
const EMPTY_GENRE_PREFERENCES: GenrePreference[] = [];
const EMPTY_GAME_PREFERENCES: Record<string, [number, number, number]> = {};
const EMPTY_PLAYTIME: PlaytimeSummary = { streakDays: 0, minutesLast7Days: 0, minutesLast30Days: 0, daysTracked: 0, dailyGains: [] };

type AppDataContextValue = {
  session: SessionPayload;
  games: DemoGame[];
  collections: DemoCollection[];
  vaultState: VaultState;
  genrePreferences: GenrePreference[];
  genrePreferenceGlobals: GenrePreference[];
  /** The population's verdict on specific games, keyed by Steam app id. */
  gamePreferences: Record<string, [number, number, number]>;
  playtime: PlaytimeSummary;
  vaultHistory: VaultDraw[];
  isLive: boolean;
  playHistoryMissing: boolean;
  /** What VaultShuffle can truthfully do for this account. See lib/steam-capabilities.ts. */
  capabilities: SteamCapabilities;
  deviceMode: DeviceMode;
  setDeviceMode: (mode: DeviceMode) => void;
  globalFilters: GlobalFilters;
  setGlobalFilters: (filters: GlobalFilters) => void;
  /**
   * The library before the global filters ran, so the panel can show its effect
   * and a pin can be resolved to a game the filters have ruled out.
   */
  allGames: DemoGame[];
  /** Owned games before the global filters ran, so the panel can show its effect. */
  unfilteredGameCount: number;
  isLoading: boolean;
  isSyncing: boolean;
  steamImport: SteamImportProgress;
  steamImportChecked: boolean;
  steamImportCooldownUntil: number | null;
  steamLibraryPrivate: boolean;
  loadError: string | null;
  refresh: (options?: { quiet?: boolean }) => Promise<boolean>;
  checkSteamImport: () => Promise<SteamImportProgress>;
  syncSteamLibrary: (options?: { restart?: boolean }) => Promise<number>;
  refreshPinnedPlaytime: () => Promise<PinnedPlaytimeResult>;
  isRefreshingPinnedPlaytime: boolean;
  pinnedRefreshAvailableAt: number | null;
  signOut: () => Promise<void>;
  /**
   * Steam Families. Empty and inert unless NEXT_PUBLIC_FAMILY_SHARING is set -
   * see lib/family-flag.ts. The roster is fetched separately from the library
   * rather than added to /api/app-data, because every account would pay for a
   * query that almost none of them need.
   */
  familyEnabled: boolean;
  familyMembers: FamilyMember[];
  familyBusy: boolean;
  addFamilyMember: (profile: string) => Promise<FamilyMemberAddOutcome>;
  removeFamilyMember: (memberId: string) => Promise<FamilyRemovalOutcome>;
  recheckFamilyLibrary: () => Promise<FamilyImportCounts>;
  createCollection: (payload: CollectionInput) => Promise<string>;
  updateCollection: (collectionId: string, payload: CollectionInput) => Promise<void>;
  removeCollection: (collectionId: string) => Promise<void>;
  updateGame: (gameId: string, patch: { status?: DemoGame["status"]; completionPercent?: number; hoursPlayed?: number; notes?: string; priority?: DemoGame["priority"]; completedAt?: string | null; sleptAt?: string | null; completionSuggestionDismissedAt?: string | null; completionSuggestionDismissedPlaytime?: number | null }) => Promise<void>;
  restoreGame: (gameId: string, options?: { silent?: boolean }) => Promise<void>;
  setGameCollection: (gameId: string, collectionId: string, assigned: boolean) => Promise<void>;
  addGamesToCollection: (collectionId: string, gameIds: string[]) => Promise<void>;
  recordVaultAction: (action: VaultAction, gameId: string, context?: Record<string, unknown>) => Promise<void>;
  recordVaultDraw: (gameId: string, input: VaultDrawInput) => Promise<VaultDraw>;
  loadVaultHistory: () => Promise<void>;
  recordDrawEvent: (drawId: string, eventType: VaultDrawEventType, analytics?: Record<string, unknown>) => Promise<void>;
  clearVaultHistory: () => Promise<void>;
};

export type FamilyMember = {
  id: string;
  steamId: string;
  displayName: string;
  avatarUrl: string | null;
  profileUrl: string;
  librarySeen: number;
  gamesImported: number;
  lastSyncedAt: string | null;
  lastError: string | null;
};

export type FamilyRemovalOutcome = {
  removed: number;
  retained: number;
  displayName: string;
};

export type FamilyMemberAddOutcome = {
  member: FamilyMember;
  counts: FamilyImportCounts;
  summary: string;
};

const AppDataContext = createContext<AppDataContextValue | null>(null);

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
  const [liveGamePreferences, setLiveGamePreferences] = useState<Record<string, [number, number, number]>>(EMPTY_GAME_PREFERENCES);
  const [livePlaytime, setLivePlaytime] = useState<PlaytimeSummary>(EMPTY_PLAYTIME);
  const [isLive, setIsLive] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [steamImport, setSteamImport] = useState<SteamImportProgress>(IDLE_STEAM_IMPORT);
  const [steamImportChecked, setSteamImportChecked] = useState(false);
  // When the refresh limit turns a request away, this is the moment it is worth
  // trying again. Held apart from steamImport.status so the card can say "wait"
  // rather than "paused", and so retrying is disabled until it means something.
  const [steamImportCooldownUntil, setSteamImportCooldownUntil] = useState<number | null>(null);
  // Steam will not hand over the library at all until the account makes its game
  // details public. Nothing here can fix that, so the only useful thing the app
  // can do is say so plainly and point at the setting.
  const [steamLibraryPrivate, setSteamLibraryPrivate] = useState(false);
  const [playHistoryMissing, setPlayHistoryMissing] = useState(false);
  const [globalFilters, setGlobalFiltersState] = useState<GlobalFilters>(DEFAULT_GLOBAL_FILTERS);
  const [loadError, setLoadError] = useState<string | null>(null);
  const syncPromiseRef = useRef<Promise<number> | null>(null);
  const pinnedRefreshPromiseRef = useRef<Promise<PinnedPlaytimeResult> | null>(null);
  const [isRefreshingPinnedPlaytime, setIsRefreshingPinnedPlaytime] = useState(false);
  const [familyMembers, setFamilyMembers] = useState<FamilyMember[]>([]);
  const [familyBusy, setFamilyBusy] = useState(false);
  const [pinnedRefreshAvailableAt, setPinnedRefreshAvailableAt] = useState<number | null>(null);

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
      // Hands the session to the analytics identity sync, which would otherwise
      // fetch the identical payload from /api/session a second time.
      publishSession(nextSession);

      if (!nextSession.logged_in) {
        setIsLive(false);
        // Fetched separately from the bootstrap so it can come off the CDN
        // rather than out of a function. Its failure is survivable on its own -
        // the bundled fallback pool is already on screen - so it must not take
        // the rest of the guest boot down with it.
        try {
          const catalogue = await api<GuestCataloguePayload>("/guest-catalogue");
          const mappedGuestGames = mapGuestGames(catalogue.games ?? []);
          if (!mappedGuestGames.length) throw new Error("Guest catalogue was empty.");
          setGuestGames(mappedGuestGames);
          setGuestCollections(guestPreviewCollection(mappedGuestGames.length));
        } catch {
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
      setLiveGamePreferences(bootstrap.gamePreferences ?? EMPTY_GAME_PREFERENCES);
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
      // Releases the analytics identity sync whether or not a session arrived,
      // so a failed bootstrap makes it fall back to its own request now rather
      // than after a timeout. A no-op once publishSession has already run.
      abandonSession();
      if (!quiet) setIsLoading(false);
    }
  }

  // Announced before the session is known, so that SiteFrame can tell one is on
  // its way and wait for it instead of making a second request for it.
  useEffect(() => announceSessionProvider(), []);

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
      const saved = localStorage.getItem(GLOBAL_FILTERS_KEY);
      if (saved) {
        setGlobalFiltersState(parseGlobalFilters(saved));
        return;
      }
      // Nothing stored under the new key, so carry across whatever the old
      // device-only one held rather than resetting someone's Deck mode.
      const legacy = localStorage.getItem(LEGACY_DEVICE_MODE_KEY);
      if (legacy === "mac" || legacy === "deck") {
        setGlobalFiltersState({ ...DEFAULT_GLOBAL_FILTERS, device: legacy });
      }
    } catch {
      // Private browsing can disable storage; the filters just will not persist.
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
    setAnalyticsAudience(session.account_type);
  }, [session.account_type]);

  useEffect(() => {
    if (isLoading || session.account_type !== "manual" || !session.user_id) return;
    const key = `vault-manual-dashboard-seen:${session.user_id}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {
      // Storage being unavailable is not worth failing over.
    }
  }, [isLoading, session.account_type, session.user_id]);

  /**
   * The Steam Families roster.
   *
   * Fetched on its own rather than folded into /api/app-data: almost nobody has
   * a family, and the bootstrap request is on the hot path for everybody. When
   * the flag is off this never runs at all and every family value below stays
   * at its empty default.
   */
  async function loadFamily() {
    if (!FAMILY_SHARING_ENABLED || !isLive) return;
    try {
      const payload = await api<{ members?: FamilyMember[] }>("/api/family");
      setFamilyMembers(payload.members ?? []);
    } catch {
      // The roster is an enhancement on top of a library that already loaded.
      // Failing to read it must not take the dashboard down with it.
    }
  }

  useEffect(() => {
    if (!FAMILY_SHARING_ENABLED || !isLive) return;
    void loadFamily();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive, session.user_id]);

  /**
   * Every family write re-reads the library afterwards.
   *
   * These change which games exist, not just a field on one of them, so the
   * optimistic pattern the rest of this file uses does not apply - there is
   * nothing sensible to draw until the server says what the shelf now holds.
   */
  async function withFamilyWrite<T>(run: () => Promise<T>): Promise<T> {
    setFamilyBusy(true);
    try {
      const result = await run();
      await Promise.all([loadFamily(), load({ quiet: true })]);
      return result;
    } finally {
      setFamilyBusy(false);
    }
  }

  async function addFamilyMember(profile: string) {
    return withFamilyWrite(async () => {
      const payload = await api<FamilyMemberAddOutcome>("/api/family", {
        method: "POST",
        body: JSON.stringify({ profile })
      });
      trackEvent(ANALYTICS_EVENTS.familyMemberAdded, {
        library_seen: payload.counts.seen,
        imported: payload.counts.importable,
        excluded: payload.counts.excluded,
        pending: payload.counts.pending,
        already_owned: payload.counts.alreadyOwned
      });
      return payload;
    });
  }

  async function removeFamilyMember(memberId: string) {
    return withFamilyWrite(async () => {
      const payload = await api<FamilyRemovalOutcome>(`/api/family/${memberId}`, { method: "DELETE" });
      trackEvent(ANALYTICS_EVENTS.familyMemberRemoved, {
        removed: payload.removed,
        retained: payload.retained
      });
      return payload;
    });
  }

  async function recheckFamilyLibrary() {
    return withFamilyWrite(async () => {
      const payload = await api<{ counts: FamilyImportCounts }>("/api/family/sync", { method: "POST" });
      return payload.counts;
    });
  }

  function setGlobalFilters(next: GlobalFilters) {
    setGlobalFiltersState(next);
    try {
      if (isDefaultGlobalFilters(next)) {
        localStorage.removeItem(GLOBAL_FILTERS_KEY);
        localStorage.removeItem(LEGACY_DEVICE_MODE_KEY);
      } else {
        localStorage.setItem(GLOBAL_FILTERS_KEY, JSON.stringify(next));
      }
    } catch {
      // Storage being unavailable must not stop the filters working this session.
    }
  }

  /** Kept so the header's Deck/Mac control can move without changing behaviour. */
  function setDeviceMode(mode: DeviceMode) {
    setGlobalFilters({ ...globalFilters, device: mode });
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

  function refreshPinnedPlaytime() {
    if (pinnedRefreshPromiseRef.current) return pinnedRefreshPromiseRef.current;
    const promise = runPinnedPlaytimeRefresh();
    pinnedRefreshPromiseRef.current = promise;
    void promise.finally(() => {
      if (pinnedRefreshPromiseRef.current === promise) pinnedRefreshPromiseRef.current = null;
    }).catch(() => undefined);
    return promise;
  }

  async function runPinnedPlaytimeRefresh(): Promise<PinnedPlaytimeResult> {
    if (!isLive) throw new Error("Connect a Steam profile to refresh pinned playtime.");
    // The refs change synchronously, unlike the rendered loading flags. That
    // closes the tiny same-tab window where both buttons could be pressed
    // before React painted either disabled state.
    if (syncPromiseRef.current || isSyncing) throw new Error("Your library is already syncing. Please let it finish first.");
    if (pinnedRefreshAvailableAt && pinnedRefreshAvailableAt > Date.now()) {
      throw new CooldownError(
        Math.ceil((pinnedRefreshAvailableAt - Date.now()) / 1000),
        "Pinned playtime was just checked. Please wait a moment before refreshing again."
      );
    }

    setIsRefreshingPinnedPlaytime(true);
    try {
      const result = await api<PinnedPlaytimeResult>("/api/steam/pinned-playtime", {
        method: "POST",
        body: "{}"
      });
      const mapped = mapLiveGames(result.games, []);
      // This is deliberately not a full bootstrap or import. Keep the shelf,
      // pin baselines, collections and any in-flight player edits intact.
      setLiveGames((current) => mergePinnedPlaytime(current, mapped));
      setPinnedRefreshAvailableAt(Date.now() + Math.max(0, result.retryAfterSeconds) * 1000);
      return result;
    } catch (error) {
      if (error instanceof CooldownError) {
        setPinnedRefreshAvailableAt(Date.now() + error.retryAfterSeconds * 1000);
      } else if (!(error instanceof Error && error.message === "unauthorized")) {
        // Do not encourage repeated Steam calls when a failure did not include a
        // Retry-After. The saved values are untouched and a minute is cheap.
        setPinnedRefreshAvailableAt(Date.now() + 60_000);
      }
      throw error;
    } finally {
      setIsRefreshingPinnedPlaytime(false);
    }
  }

  function syncSteamLibrary(options: { restart?: boolean } = {}) {
    if (syncPromiseRef.current) return syncPromiseRef.current;
    const activePinRefresh = pinnedRefreshPromiseRef.current;
    // A full sync requested during the short pin refresh waits for it rather
    // than racing its final UI merge. The database is locked as well, but this
    // keeps the same tab from briefly repainting an older snapshot.
    const promise = activePinRefresh
      ? activePinRefresh.catch(() => undefined).then(() => runSteamLibrarySync(options))
      : runSteamLibrarySync(options);
    syncPromiseRef.current = promise;
    void promise.finally(() => {
      if (syncPromiseRef.current === promise) syncPromiseRef.current = null;
    }).catch(() => undefined);
    return promise;
  }

  async function runSteamLibrarySync({ restart = true }: { restart?: boolean }) {
    if (!isLive) throw new Error("Connect a Steam library before syncing it.");
    const savedCooldown = readStoredCooldown(session.user_id);
    if (savedCooldown) {
      setSteamImportCooldownUntil(savedCooldown.until);
      setSteamImport((current) => ({ ...current, status: "failed", lastError: "Please give Steam a moment before trying again." }));
      throw storedCooldownError(savedCooldown);
    }

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
    setSteamImportCooldownUntil(null);
    setSteamLibraryPrivate(false);
    let steamImportSaved = restart ? false : steamImport.imported > 0;
    let importCompleted = false;
    try {
      let result = await withTransientRetry(() => requestSteamImportBatch(restart));
      setSteamImport(result.progress);
      steamImportSaved = result.progress.imported > 0;

      let unchangedResponses = 0;
      while (result.progress.status === "importing") {
        if (result.retry_after_seconds) {
          const retryAfterMs = result.retry_after_seconds * 1000;
          await new Promise((resolve) => window.setTimeout(resolve, retryAfterMs));
        }
        const previousImported = result.progress.imported;
        result = await withTransientRetry(() => requestSteamImportBatch(false));
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

      // Ask the server what actually happened before calling this a failure.
      // The import runs there, not here, so losing the connection that was
      // watching it does not stop it: people were shown "your import is paused"
      // over the top of an import that went on to finish. Every job in the table
      // had completed; the only thing that had failed was the reporting.
      const actual = await checkSteamImport().catch(() => null);
      if (actual?.status === "complete") {
        setSteamImportCooldownUntil(null);
        await load().catch(() => null);
        trackEvent(ANALYTICS_EVENTS.steamLibrarySynced, {
          imported_count: actual.total,
          play_history_missing: actual.playHistoryMissing,
          // Distinguishes these from clean runs, so the rate of them is visible
          // rather than hiding inside the success count.
          recovered_from: message
        });
        setPlayHistoryMissing(actual.playHistoryMissing);
        return actual.total;
      }

      // Being asked to wait is not a broken import. Marking it failed put a
      // Retry button in front of people that could not work until the window
      // passed, and they pressed it until they left.
      if (error instanceof CooldownError) {
        setSteamImportCooldownUntil(saveCooldown(session.user_id, error));
        setSteamImport((current) => ({ ...(actual ?? current), status: "failed", lastError: error.message }));
        throw error;
      }
      if (error instanceof SteamLibraryPrivateError) setSteamLibraryPrivate(true);
      if (!importCompleted) {
        // Seeded from the server's own count where we have it, so "Resume
        // import" resumes from the right place rather than from whatever this
        // tab last managed to see.
        setSteamImport((current) => ({ ...(actual ?? current), status: "failed", lastError: message }));
      }
      // A failed first import is the highest-intent moment in the funnel failing.
      // Reporting only successes would leave it invisible, which is exactly how
      // the Steam launch event stayed at zero for a month.
      if (!steamImportSaved) {
        trackEvent(ANALYTICS_EVENTS.steamImportFailed, {
          ...diagnosticFailure(error),
          request_id: diagnosticId((error as { requestId?: string })?.requestId),
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
    window.location.assign("/");
  }

  async function createCollection(payload: CollectionInput) {
    if (isLive) {
      // The id comes from the server, so this one round trip is unavoidable -
      // but re-reading the whole library afterwards is not. A collection created
      // here has no games in it yet, so its row can be built from what was just
      // sent and dropped straight into the list.
      const { collection } = await api<{ collection: Collection }>("/api/collections", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      setLiveCollections((current) => [...current, {
        id: collection.id,
        kind: payload.kind || "custom",
        name: payload.name,
        description: payload.description || (payload.kind === "smart"
          ? "Automatically updated from your live VaultShuffle library."
          : "Custom collection from your live VaultShuffle library."),
        artworkUrl: "/assets/vault/vault-stage-open.png",
        accent: "0 games currently assigned.",
        smartPreset: payload.rules?.preset
      }]);
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
      setLiveCollections((current) => current.map((collection) => collection.id === collectionId ? {
        ...collection,
        name: payload.name,
        description: payload.description || collection.description,
        kind: payload.kind ?? collection.kind,
        smartPreset: payload.kind === "custom" ? undefined : payload.rules?.preset ?? collection.smartPreset
      } : collection));
      queueWrite(api(`/api/collections/${collectionId}`, { method: "PATCH", body: JSON.stringify(payload) }));
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
      setLiveCollections((current) => current.filter((collection) => collection.id !== collectionId));
      setLiveGames((current) => current.map((game) => game.collectionIds.includes(collectionId)
        ? { ...game, collectionIds: game.collectionIds.filter((id) => id !== collectionId) }
        : game));
      queueWrite(api(`/api/collections/${collectionId}`, { method: "DELETE" }));
      return;
    }
    setGuestCollections((current) => current.filter((collection) => collection.id !== collectionId));
    setGuestGames((current) => current.map((game) => ({
      ...game,
      collectionIds: game.collectionIds.filter((id) => id !== collectionId)
    })));
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
      if (patch.status) trackEvent(ANALYTICS_EVENTS.gameStatusChanged, { status: patch.status, count: 1 });

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
      trackEvent(ANALYTICS_EVENTS.gameStatusChanged, { status: patch.status, count: 1 });
    }
    if (patch.status === "Completed" || patch.status === "Slept") {
      setGuestVaultState((current) => ({
        ...current,
        pinnedIds: current.pinnedIds.filter((id) => id !== gameId),
        currentPickId: current.currentPickId === gameId ? null : current.currentPickId
      }));
    }
  }

  /**
   * `silent` is for callers restoring a whole selection: waking thirty games is
   * one intent, and reporting it thirty times made per-user event rates
   * meaningless. The bulk caller sends a single event carrying the count.
   */
  async function restoreGame(gameId: string, options?: { silent?: boolean }) {
    if (isLive) {
      await api(`/api/games/${gameId}`, {
        method: "PATCH",
        body: JSON.stringify({ restore_active: true })
      });
      setLiveGames((current) => current.map((game) => game.id === gameId ? restoreActiveGame(game) : game));
      if (!options?.silent) trackEvent(ANALYTICS_EVENTS.gameStatusChanged, { status: "Active", restored: true, count: 1 });
      return;
    }

    setGuestGames((current) => current.map((game) => game.id === gameId ? restoreActiveGame(game) : game));
    if (!options?.silent) {
      trackEvent(ANALYTICS_EVENTS.gameStatusChanged, { status: "Active", restored: true, count: 1 });
    }
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
      setLiveGames((current) => current.map((game) => game.id === gameId ? {
        ...game,
        collectionIds: assigned
          ? Array.from(new Set([...game.collectionIds, collectionId]))
          : game.collectionIds.filter((id) => id !== collectionId)
      } : game));
      trackEvent(ANALYTICS_EVENTS.collectionMembershipChanged, { action: assigned ? "added" : "removed" });
      queueWrite(api(`/api/collections/${collectionId}/games${assigned ? "" : `/${gameId}`}`, {
        method: assigned ? "POST" : "DELETE",
        body: assigned ? JSON.stringify({ game_id: gameId }) : undefined
      }));
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
  }

  async function loadVaultHistory() {
    if (!isLive) return;
    const { draws } = await api<{ draws: VaultDraw[] }>("/api/vault/history");
    setLiveVaultHistory(draws);
  }

  async function recordVaultDraw(gameId: string, input: VaultDrawInput) {
    if (isLive) {
      const { state, draw } = await api<{ state: VaultState; draw: VaultDraw }>("/api/vault/history", { method: "POST", body: JSON.stringify({ game_id: gameId, steam_app_id: input.steamAppId, session: input.session, mood: input.mood, goal: input.goal, collection_id: input.collectionId, selected_genres: input.selectedGenres, eligible_pool_count: input.eligiblePoolCount, reroll_index: input.rerollIndex, finalist_appids: input.finalistAppIds?.slice(0, RECORDED_FINALIST_LIMIT) }) });
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
    // Launching on Steam is the north-star metric, and the only follow-up that
    // still gets its own event: the rest - pinned, snoozed, rerolled, disliked -
    // are all recorded as vault_draw_events rows, which is where the questions
    // about them are actually answered.
    //
    // It fires before the API call, not after it: the link navigates to a
    // steam:// URL, so anything queued behind an await is cancelled with the
    // page and never reaches PostHog. The experiment arm rides along because it
    // is per draw rather than per user, so it cannot be a super-property.
    if (eventType === "opened_on_steam") {
      trackNavigationEvent(ANALYTICS_EVENTS.vaultPickLaunched, {
        draw_id: drawId,
        draw_action: eventType,
        ...analytics,
      });
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

  // The topmost layer. Everything downstream - the Vault's deck, the Library,
  // every count on the page - reads from this, so a global filter genuinely
  // removes a game from consideration rather than hiding it in one view.
  //
  // Signed-in only. The panel is not offered to guests, and the choices outlive
  // a session in localStorage, so filtering the guest catalogue too would let
  // someone sign out and find a preview quietly missing games with no control
  // anywhere to explain it or put them back.
  // A shared game says whose shelf it came from. The roster and the library are
  // two requests and either can land first, so the name is overlaid here rather
  // than baked in at map time. Identity is preserved when nothing changes, so
  // this cannot churn the memos below it.
  const namedLiveGames = useMemo(
    () => withFamilyOwnerNames(liveGames, familyMembers),
    [liveGames, familyMembers]
  );
  const allGames = isLive ? namedLiveGames : guestGames;
  const visibleGames = useMemo(
    () => isLive ? namedLiveGames.filter((game) => matchesGlobalFilters(game, globalFilters)) : guestGames,
    [globalFilters, guestGames, isLive, namedLiveGames]
  );
  const unfilteredGameCount = allGames.length;
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
      deviceMode: globalFilters.device,
      globalFilters,
      setGlobalFilters,
      allGames,
      unfilteredGameCount,
      setDeviceMode,
      games: visibleGames,
      collections: isLive ? liveCollections : guestCollections,
      vaultState: isLive ? liveVaultState : guestVaultState,
      // Guests have no history to learn from, so they always draw unweighted.
      genrePreferences: isLive ? liveGenrePreferences : EMPTY_GENRE_PREFERENCES,
      genrePreferenceGlobals: isLive ? liveGenrePreferenceGlobals : EMPTY_GENRE_PREFERENCES,
      gamePreferences: isLive ? liveGamePreferences : EMPTY_GAME_PREFERENCES,
      playtime: activePlaytime,
      vaultHistory: isLive ? liveVaultHistory : guestVaultHistory,
      isLive,
      isLoading,
      isSyncing,
      steamImport,
      steamImportChecked,
      steamImportCooldownUntil,
      steamLibraryPrivate,
      loadError,
      refresh: load,
      checkSteamImport,
      syncSteamLibrary,
      refreshPinnedPlaytime,
      isRefreshingPinnedPlaytime,
      pinnedRefreshAvailableAt,
      signOut,
      familyEnabled: FAMILY_SHARING_ENABLED,
      familyMembers,
      familyBusy,
      addFamilyMember,
      removeFamilyMember,
      recheckFamilyLibrary,
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
    [capabilities, session, isLive, isLoading, isSyncing, isRefreshingPinnedPlaytime, pinnedRefreshAvailableAt, steamImport, steamImportChecked, steamImportCooldownUntil, steamLibraryPrivate, loadError, playHistoryMissing, globalFilters, liveGames, namedLiveGames, familyMembers, familyBusy, liveCollections, guestGames, guestCollections, liveVaultState, guestVaultState, liveGenrePreferences, liveGenrePreferenceGlobals, livePlaytime, liveVaultHistory, guestVaultHistory]
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
