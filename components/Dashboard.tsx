"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Game, GamePayload, SessionPayload, StatsPayload, SteamSearchResult } from "@/lib/types";
import {
  LENGTH_HELP_TEXT,
  LENGTH_LABELS,
  displayStatus,
  gameProgress,
  inferredProgressFromHours,
  isCompletedGame as isCompleted,
  lengthBucket,
  statusFromCompletion
} from "@/lib/game-classification";
import { GameDetails } from "@/components/dashboard/GameDetails";
import { GameCard, GameRow, GuestLibraryState } from "@/components/dashboard/GameListItems";
import { LibrarySidebar, type StatAction } from "@/components/dashboard/LibrarySidebar";
import { VaultShuffleModal } from "@/components/dashboard/VaultShuffleModal";
import { DEFAULT_THEME_ID, THEME_OPTIONS, THEME_STORAGE_KEY, isThemeOptionId, type ThemeOptionId } from "@/lib/themes";
import {
  TOP_LEVEL_GENRES,
  matchesTopLevelGenre,
  topLevelGenresFor
} from "@/lib/genres";

const emptyStats: StatsPayload = {
  total: 0,
  completed: 0,
  in_progress: 0,
  wishlist: 0,
  hours: 0,
  avg_rating: 0,
  avg_completion: 0
};

const PREVIEW_STORAGE_KEY = "vaultshuffle.preview.games";
const METADATA_SYNC_BATCH_SIZE = 50;
const METADATA_SYNC_DELAY_MS = 5000;
const METADATA_SYNC_MAX_BATCHES = 32;
const SHUFFLE_ANIMATION_MS = 1450;
const FILTER_SEPARATOR = "||";
const ANY_LENGTH_LABEL = "Any";
const LENGTH_FILTER_OPTIONS = [...LENGTH_LABELS];
const STATUS_FILTER_OPTIONS = ["Completed", "In Progress", "Sampled", "Not Started"];
const OWNERSHIP_FILTER_OPTIONS = ["Owned", "Wishlist"];
const SORT_OPTIONS = [
  { value: "hours_desc", label: "Playtime: high to low" },
  { value: "hours_asc", label: "Playtime: low to high" },
  { value: "title_asc", label: "Title: A to Z" },
  { value: "title_desc", label: "Title: Z to A" },
  { value: "progress_desc", label: "Progress: high to low" },
  { value: "progress_asc", label: "Progress: low to high" },
  { value: "rating_desc", label: "Rating: high to low" },
  { value: "rating_asc", label: "Rating: low to high" }
];

const blankGame: GamePayload = {
  title: "",
  genre: "Unknown",
  store: "Steam",
  ownership: "Wishlist",
  status: "Not Started",
  rating: 0,
  hours_played: 0,
  completion_percentage: 0,
  priority: "Medium",
  date_added: new Date().toLocaleDateString("en-GB"),
  last_played_at: null,
  notes: "",
  steam_appid: null
};

async function api<T>(path: string, options: RequestInit = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  if (response.status === 401) {
    throw new Error("Steam sign-in is required.");
  }
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed.");
  return payload as T;
}

export function Dashboard() {
  const [games, setGames] = useState<Game[]>([]);
  const [stats, setStats] = useState<StatsPayload>(emptyStats);
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addQuery, setAddQuery] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("All");
  const [ownership, setOwnership] = useState("All");
  const [genreFilter, setGenreFilter] = useState("All genres");
  const [lengthFilter, setLengthFilter] = useState(ANY_LENGTH_LABEL);
  const [sort, setSort] = useState("hours_desc");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedTheme, setSelectedTheme] = useState<ThemeOptionId>(readSavedTheme);
  const [rowMenuId, setRowMenuId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [shuffleCount, setShuffleCount] = useState<1 | 2 | 3>(3);
  const [shuffleCards, setShuffleCards] = useState<Game[]>([]);
  const [shuffleMessage, setShuffleMessage] = useState("Shuffle the games currently visible in your library.");
  const [shuffleVaultOpen, setShuffleVaultOpen] = useState(false);
  const [shuffleSpinning, setShuffleSpinning] = useState(false);
  const [shuffleAnimationKey, setShuffleAnimationKey] = useState(0);
  const [steamResults, setSteamResults] = useState<SteamSearchResult[]>([]);
  const [addSearchOpen, setAddSearchOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [guestPrompt, setGuestPrompt] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesEditing, setNotesEditing] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");
  const addSearchInputRef = useRef<HTMLInputElement>(null);
  const addSearchRef = useRef<HTMLFormElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const metadataSyncingRef = useRef(false);
  const shuffleAnimationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isLoggedIn = Boolean(session?.logged_in);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const importError = params.get("import_error");
    const shouldImport = params.get("steam_connected") === "1";
    if (importError) {
      setNotice(`Steam sign-in worked, but library import needs attention: ${importError}`);
      window.history.replaceState(null, "", window.location.pathname);
    } else if (shouldImport) {
      setNotice("Steam sign-in worked. Importing your Steam library...");
      window.history.replaceState(null, "", window.location.pathname);
    }
    void load(shouldImport);
  }, []);

  useEffect(() => {
    return () => {
      if (shuffleAnimationTimerRef.current) clearTimeout(shuffleAnimationTimerRef.current);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.vaultTheme = selectedTheme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, selectedTheme);
    } catch {
      // Theme persistence is a preference; losing it should not block the app.
    }
  }, [selectedTheme]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!guestPrompt || isLoggedIn) return;
    const timer = window.setTimeout(() => setGuestPrompt(false), 5000);
    return () => window.clearTimeout(timer);
  }, [guestPrompt, isLoggedIn]);

  useEffect(() => {
    if (!shuffleVaultOpen) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setShuffleVaultOpen(false);
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [shuffleVaultOpen]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (addQuery.trim().length >= 2) void searchSteam(addQuery);
      else setSteamResults([]);
    }, 360);
    return () => window.clearTimeout(timer);
  }, [addQuery]);

  useEffect(() => {
    if (!isLoggedIn || !games.some(needsSteamMetadata)) return;
    void syncSteamMetadata(2);
  }, [games.length, isLoggedIn]);

  useEffect(() => {
    function closeLooseMenus(event: PointerEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (settingsOpen && settingsRef.current && !settingsRef.current.contains(target)) setSettingsOpen(false);
      if (addSearchOpen && addSearchRef.current && !addSearchRef.current.contains(target)) setAddSearchOpen(false);
      if (rowMenuId && !(target instanceof Element && target.closest(".row-menu-cell"))) setRowMenuId(null);
    }

    document.addEventListener("pointerdown", closeLooseMenus);
    return () => document.removeEventListener("pointerdown", closeLooseMenus);
  }, [addSearchOpen, rowMenuId, settingsOpen]);

  const genreOptions = useMemo(() => [...TOP_LEVEL_GENRES], []);

  const displayStats = useMemo(() => previewStats(games), [games]);
  const activeFilterCount = useMemo(
    () => filterCount(query, status, ownership, genreFilter, lengthFilter),
    [genreFilter, lengthFilter, ownership, query, status]
  );

  const filteredGames = useMemo(() => {
    const lowerQuery = query.trim().toLowerCase();
    const selectedStatuses = selectedOptions(status, "All");
    const selectedOwnerships = selectedOptions(ownership, "All");
    const selectedGenres = selectedOptions(genreFilter, "All genres");
    const selectedLengths = selectedOptions(lengthFilter, ANY_LENGTH_LABEL);

    return games
      .filter((game) => {
        const effectiveStatus = displayStatus(game);
        const text = `${game.title} ${game.genre} ${game.store} ${effectiveStatus} ${game.notes} ${game.steam_appid ?? ""}`.toLowerCase();
        return (
          (!lowerQuery || text.includes(lowerQuery)) &&
          (!selectedStatuses.length || selectedStatuses.includes(effectiveStatus)) &&
          (!selectedOwnerships.length || selectedOwnerships.includes(game.ownership)) &&
          (!selectedGenres.length || selectedGenres.some((genre) => matchesTopLevelGenre(game.genre, genre, game.title))) &&
          (!selectedLengths.length || selectedLengths.includes(lengthBucket(game)))
        );
      })
      .sort((a, b) => {
        if (sort === "title_asc") return a.title.localeCompare(b.title);
        if (sort === "title_desc") return b.title.localeCompare(a.title);
        if (sort === "hours_asc") return Number(a.hours_played || 0) - Number(b.hours_played || 0);
        if (sort === "progress_desc") return gameProgress(b) - gameProgress(a);
        if (sort === "progress_asc") return gameProgress(a) - gameProgress(b);
        if (sort === "rating_desc") return Number(b.rating || 0) - Number(a.rating || 0);
        if (sort === "rating_asc") return Number(a.rating || 0) - Number(b.rating || 0);
        return Number(b.hours_played || 0) - Number(a.hours_played || 0);
      });
  }, [games, genreFilter, lengthFilter, ownership, query, sort, status]);

  const selected = games.find((game) => game.id === selectedId) ?? null;
  const shuffleEligibleCount = useMemo(() => filteredGames.filter((game) => !isCompleted(game)).length, [filteredGames]);
  const activeRulesLabel = activeFilterLabel(status, ownership, genreFilter, lengthFilter);

  useEffect(() => {
    if (!selected) {
      setNotesOpen(false);
      setNotesEditing(false);
      setNotesDraft("");
      return;
    }
    setNotesDraft(selected.notes || "");
    setNotesEditing(false);
  }, [selected?.id, selected?.notes]);

  async function load(importAfterLogin = false) {
    const sessionPayload = await api<SessionPayload>("/api/session");
    if (!sessionPayload.logged_in) {
      const previewGames = loadPreviewGames();
      setSession(sessionPayload);
      setGames(previewGames);
      setStats(previewStats(previewGames));
      setShuffleCards(pickShuffleGames(previewGames, shuffleCount));
      setShuffleMessage(previewGames.length ? "Shuffle your temporary preview list, or sign in to import the real thing." : "Add a few Steam games to try the app, or sign in when you want your own library.");
      setSelectedId((current) => current ?? previewGames[0]?.id ?? null);
      setGuestPrompt(!previewGames.length);
      return;
    }
    setGuestPrompt(false);
    const [{ games: nextGames }, nextStats] = await Promise.all([
      api<{ games: Game[] }>("/api/games"),
      api<StatsPayload>("/api/stats")
    ]);
    setSession(sessionPayload);
    setGames(nextGames);
    setStats(nextStats);
    setShuffleCards(pickShuffleGames(nextGames, shuffleCount));
    setSelectedId((current) => current ?? nextGames[0]?.id ?? null);

    if (importAfterLogin && sessionPayload.has_steam_key) {
      try {
        const result = await api<{ imported: number; games?: Game[] }>("/api/steam/owned-games", { method: "POST", body: "{}" });
        const [freshGames, importedStats] = await Promise.all([
          result.games ? Promise.resolve({ games: result.games }) : api<{ games: Game[] }>("/api/games"),
          api<StatsPayload>("/api/stats")
        ]);
        const importedGames = freshGames.games;
        setGames(importedGames);
        setStats(importedStats);
        setShuffleCards(pickShuffleGames(importedGames, shuffleCount));
        setSelectedId((current) => current ?? importedGames[0]?.id ?? null);
        setNotice(`Steam library import complete: ${result.imported} games added or updated.`);
        void syncSteamMetadata(METADATA_SYNC_MAX_BATCHES, true);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Steam library import failed.");
      }
    } else if (importAfterLogin) {
      setNotice("Steam sign-in worked. Steam library sync is temporarily unavailable, but you can still add games from search.");
    }
  }

  async function refreshLibrary(preferredSelectedId?: string | null) {
    const [{ games: nextGames }, nextStats] = await Promise.all([
      api<{ games: Game[] }>("/api/games"),
      api<StatsPayload>("/api/stats")
    ]);
    setGames(nextGames);
    setStats(nextStats);
    setShuffleCards((current) => current.filter((card) => nextGames.some((game) => game.id === card.id)).slice(0, shuffleCount));
    setSelectedId((current) => {
      const preferred = preferredSelectedId ?? current;
      if (preferred && nextGames.some((game) => game.id === preferred)) return preferred;
      return nextGames[0]?.id ?? null;
    });
  }

  async function syncSteamMetadata(passes = METADATA_SYNC_MAX_BATCHES, force = false) {
    if ((!force && !isLoggedIn) || metadataSyncingRef.current) return;
    metadataSyncingRef.current = true;
    try {
      let totalUpdated = 0;
      for (let pass = 0; pass < passes; pass += 1) {
        const result = await api<{ processed: number; updated: number; remaining: number }>("/api/steam/metadata", {
          method: "POST",
          body: JSON.stringify({ force: force && pass === 0, limit: METADATA_SYNC_BATCH_SIZE })
        });
        totalUpdated += result.updated;
        if (result.updated) await refreshLibrary(selectedId);
        if (!result.remaining || !result.processed) break;
        await delay(METADATA_SYNC_DELAY_MS);
      }
      if (totalUpdated) setNotice(`Steam metadata updated for ${totalUpdated} ${totalUpdated === 1 ? "game" : "games"}.`);
    } catch {
      // Metadata enrichment is best-effort. The library itself should stay usable.
    } finally {
      metadataSyncingRef.current = false;
    }
  }

  function clearFilters() {
    setQuery("");
    setStatus("All");
    setOwnership("All");
    setGenreFilter("All genres");
    setLengthFilter(ANY_LENGTH_LABEL);
    setFiltersOpen(false);
  }

  function revealLibrary() {
    setQuery("");
    setStatus("All");
    setOwnership("All");
    setGenreFilter("All genres");
    setLengthFilter(ANY_LENGTH_LABEL);
    setFiltersOpen(false);
  }

  function applyStatFilter(action: StatAction) {
    setQuery("");
    setStatus("All");
    setOwnership("All");
    setGenreFilter("All genres");
    setLengthFilter(ANY_LENGTH_LABEL);
    setFiltersOpen(false);
    if (action === "completed") setStatus("Completed");
    if (action === "progress") setStatus("In Progress");
    if (action === "sampled") setStatus("Sampled");
    if (action === "not_started") setStatus("Not Started");
    if (action === "owned") setOwnership("Owned");
    if (action === "wishlist") setOwnership("Wishlist");
  }

  function toggleSort(descSort: string, ascSort: string) {
    setSort((current) => current === descSort ? ascSort : descSort);
  }

  function submitAddSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAddSearchOpen(true);
    if (addQuery.trim().length >= 2) void searchSteam(addQuery);
  }

  async function searchSteam(term: string) {
    try {
      const payload = await api<{ results: SteamSearchResult[] }>(`/api/steam/search?q=${encodeURIComponent(term)}`);
      setSteamResults(payload.results);
    } catch (error) {
      setSteamResults([]);
      setNotice(error instanceof Error ? error.message : "Steam search is taking a moment.");
    }
  }

  async function addSteamGame(result: SteamSearchResult) {
    const details = await steamAppDetails(result.appid);
    const payload: GamePayload = {
      ...blankGame,
      ...(details || {}),
      title: details?.title || result.name,
      genre: details?.genre || result.genre || blankGame.genre,
      capsule_url: details?.capsule_url || result.image || null,
      header_url: details?.header_url || null,
      notes: "",
      ownership: "Wishlist",
      steam_appid: result.appid
    };
    if (!isLoggedIn) {
      const game = previewGameFromPayload(payload);
      const nextGames = upsertPreview(games, game);
      revealLibrary();
      applyPreviewGames(nextGames, game.id, "Added to your temporary preview list. Sign in with Steam when you want a saved library.");
      setAddSearchOpen(false);
      setAddQuery("");
      return;
    }
    const { game } = await api<{ game: Game }>("/api/games", { method: "POST", body: JSON.stringify(payload) });
    setAddSearchOpen(false);
    revealLibrary();
    await refreshLibrary(game.id);
    if (needsSteamMetadata(game)) void syncSteamMetadata(4);
    setAddQuery("");
    setSelectedId(game.id);
  }

  function focusAddSearch() {
    addSearchInputRef.current?.focus();
    setAddSearchOpen(true);
  }

  async function patchGame(gameToPatch: Game, payload: Partial<GamePayload>) {
    if (!isLoggedIn) {
      const nextGames = games.map((game) =>
        game.id === gameToPatch.id ? { ...game, ...payload, updated_at: new Date().toISOString() } : game
      );
      applyPreviewGames(nextGames, gameToPatch.id, "Updated your temporary preview game.");
      return;
    }
    await api(`/api/games/${gameToPatch.id}`, { method: "PATCH", body: JSON.stringify(payload) });
    await refreshLibrary(gameToPatch.id);
  }

  async function patchSelected(payload: Partial<GamePayload>) {
    if (!selected) return;
    await patchGame(selected, payload);
  }

  async function markGameCompleted(gameToComplete: Game) {
    setRowMenuId(null);
    await patchGame(gameToComplete, { status: "Completed", completion_percentage: 100 });
  }

  function startSelectedPlaying() {
    if (!selected) return;
    if (!selected.steam_appid) {
      setNotice("This game does not have a Steam AppID to launch from yet.");
      return;
    }
    window.location.href = `steam://rungameid/${selected.steam_appid}`;
    setNotice(`Opening ${selected.title} in Steam...`);
  }

  async function deleteGame(gameToDelete: Game) {
    setRowMenuId(null);
    if (!isLoggedIn) {
      const nextGames = games.filter((game) => game.id !== gameToDelete.id);
      const nextSelectedId = selectedId === gameToDelete.id ? nextGames[0]?.id ?? null : selectedId;
      applyPreviewGames(nextGames, nextSelectedId, "Removed from your temporary preview list.");
      return;
    }
    await api(`/api/games/${gameToDelete.id}`, { method: "DELETE" });
    if (selectedId === gameToDelete.id) setSelectedId(null);
    await load();
  }

  function openVault() {
    setShuffleVaultOpen(true);
    if (!shuffleCards.length) {
      setShuffleMessage("Pick a draw size, then open the vault to pull from the games shown in your library.");
    }
  }

  async function shuffle() {
    playShuffleAnimation();
    const picks = pickShuffleGames(filteredGames, shuffleCount);
    if (!picks.length) {
      const reason = isLoggedIn
        ? "No unfinished games match the current library view."
        : "Add a demo game first, or sign in with Steam to shuffle your real backlog.";
      setShuffleCards([]);
      setShuffleMessage(reason);
      return;
    }
    setShuffleCards(picks);
    setShuffleMessage(`${picks.length} random ${picks.length === 1 ? "pick" : "picks"} from the games shown below.`);
    setSelectedId(picks[0].id);
  }

  function changeShuffleCount(count: 1 | 2 | 3) {
    setShuffleCount(count);
  }

  function playShuffleAnimation() {
    if (shuffleAnimationTimerRef.current) clearTimeout(shuffleAnimationTimerRef.current);
    setShuffleAnimationKey((key) => key + 1);
    setShuffleSpinning(true);
    shuffleAnimationTimerRef.current = setTimeout(() => {
      setShuffleSpinning(false);
      shuffleAnimationTimerRef.current = null;
    }, SHUFFLE_ANIMATION_MS);
  }

  async function saveNotes() {
    if (!selected) return;
    await patchSelected({ notes: notesDraft });
    setNotesEditing(false);
  }

  async function importSteamLibrary() {
    if (!isLoggedIn) {
      window.location.href = "/login";
      return;
    }
    if (!session?.has_steam_key) {
      setNotice("Steam library sync is temporarily unavailable. Please try again later.");
      return;
    }
    try {
      const result = await api<{ imported: number; games?: Game[] }>("/api/steam/owned-games", { method: "POST", body: "{}" });
      if (result.games) {
        setGames(result.games);
        setSelectedId((current) => current && result.games?.some((game) => game.id === current) ? current : result.games?.[0]?.id ?? null);
      } else {
        await refreshLibrary(selectedId);
      }
      setNotice(`Steam library import complete: ${result.imported} games added or updated.`);
      void syncSteamMetadata(METADATA_SYNC_MAX_BATCHES, true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Steam library import failed.");
    }
  }

  async function logout() {
    if (!isLoggedIn) {
      window.location.href = "/login";
      return;
    }
    await api("/api/logout", { method: "POST", body: "{}" });
    window.location.href = "/login";
  }

  function applyPreviewGames(nextGames: Game[], nextSelectedId: string | null, message?: string) {
    savePreviewGames(nextGames);
    setGames(nextGames);
    setStats(previewStats(nextGames));
    setShuffleCards(pickShuffleGames(nextGames, shuffleCount));
    setSelectedId(nextSelectedId);
    setGuestPrompt(!nextGames.length);
    if (message) setNotice(message);
  }

  return (
    <div className={`app-shell app-theme-${selectedTheme}`}>
      <header className="top-nav">
        <div className="nav-brand">
          <a className="brand-lockup" href="/" aria-label="Vault Shuffle home">
            <img src="/assets/vault-shuffle-icon.png" alt="" />
            <strong>Vault Shuffle</strong>
          </a>
        </div>
        <form className="nav-search-group" onSubmit={submitAddSearch} ref={addSearchRef}>
          <div className="search-box add-search-box">
            <span>⌕</span>
            <input
              ref={addSearchInputRef}
              value={addQuery}
              onFocus={() => setAddSearchOpen(true)}
              onChange={(event) => {
                setAddQuery(event.target.value);
                setAddSearchOpen(true);
              }}
              type="search"
              placeholder="Add a Steam game..."
            />
            <button type="submit">Search</button>
          </div>
          {addSearchOpen && addQuery.trim().length >= 2 ? (
            <div className="add-search-results">
              {steamResults.length ? (
                steamResults.map((result) => (
                  <button className="add-search-result" key={result.appid} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => void addSteamGame(result)}>
                    <span className="steam-result-art">{result.image ? <img src={result.image} alt="" /> : null}</span>
                    <span>
                      <strong>{result.name}</strong>
                      <small>{result.genre ? `${result.genre} · ` : ""}Steam</small>
                    </span>
                    <b>Add</b>
                  </button>
                ))
              ) : (
                <p className="add-search-empty">No Steam games found yet.</p>
              )}
            </div>
          ) : null}
        </form>
        <div className="nav-actions">
          <span className="steam-profile">
            {isLoggedIn && session?.avatar_url ? <img src={session.avatar_url} alt="" /> : <span className="steam-avatar-fallback">{isLoggedIn ? "S" : "?"}</span>}
            <span>{isLoggedIn ? session?.display_name || "Steam user" : "Preview mode"}</span>
          </span>
          <button className="ghost sync-button" onClick={importSteamLibrary}>
            {isLoggedIn ? "↻ Sync Steam" : "⇩ Import Steam"}
          </button>
          {isLoggedIn ? <button className="ghost subtle" onClick={logout}>Sign out</button> : null}
          <div className="settings-wrap" ref={settingsRef}>
            <button className={`nav-icon settings-button ${settingsOpen ? "active" : ""}`} onClick={() => setSettingsOpen((open) => !open)} type="button" aria-label="Settings">
              ⚙
            </button>
            {settingsOpen ? (
              <div className="settings-menu">
                <strong>Theme</strong>
                <div className="settings-theme-grid" role="list" aria-label="Theme options">
                  {THEME_OPTIONS.map((theme) => (
                    <button
                      key={theme.id}
                      className={`settings-theme-tile theme-${theme.id} ${selectedTheme === theme.id ? "active" : ""}`}
                      onClick={() => setSelectedTheme(theme.id)}
                      type="button"
                      aria-pressed={selectedTheme === theme.id}
                    >
                      <span aria-hidden="true" />
                      <b>{theme.name}</b>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {notice ? (
        <div className="app-notice" role="status">
          <span>{notice}</span>
          <button onClick={() => setNotice("")} aria-label="Dismiss notice">
            ×
          </button>
        </div>
      ) : null}

      {guestPrompt && !isLoggedIn ? (
        <div className="guest-toast" role="status">
          <div>
            <strong>Look around first.</strong>
            <span>Sign in with Steam when you want your own games and playtime to appear.</span>
          </div>
          <a href="/login">Sign in</a>
          <button onClick={() => setGuestPrompt(false)} aria-label="Dismiss guest prompt">×</button>
        </div>
      ) : null}

      {shuffleVaultOpen ? (
        <VaultShuffleModal
          animationKey={shuffleAnimationKey}
          cards={shuffleCards}
          count={shuffleCount}
          eligibleCount={shuffleEligibleCount}
          message={shuffleMessage}
          onClose={() => setShuffleVaultOpen(false)}
          onCountChange={changeShuffleCount}
          onSelect={(game) => {
            setSelectedId(game.id);
            setShuffleVaultOpen(false);
          }}
          onShuffle={() => void shuffle()}
          spinning={shuffleSpinning}
        />
      ) : null}

      <div className="workspace">
        <LibrarySidebar
          activeRulesLabel={activeRulesLabel}
          games={games}
          onOpenVault={openVault}
          onShuffleCountChange={changeShuffleCount}
          onStatFilter={applyStatFilter}
          shuffleCount={shuffleCount}
          shuffleEligibleCount={shuffleEligibleCount}
          stats={displayStats}
        />

        <main className="library-main">
          <section className={`library-table ${viewMode === "grid" ? "grid-mode" : ""}`}>
            <div className="table-toolbar">
              <strong>{filteredGames.length} {filteredGames.length === 1 ? "game" : "games"}</strong>
              <div className="toolbar-controls">
                <label className="table-filter-search">
                  <span>⌕</span>
                  <input value={query} onChange={(event) => setQuery(event.target.value)} type="search" placeholder="Filter library..." />
                </label>
                <div className="filter-popover-wrap">
                  <button className={`filter-button ${filtersOpen ? "active" : ""}`} onClick={() => setFiltersOpen((open) => !open)} type="button">
                    Filter
                    {activeFilterCount ? <span>{activeFilterCount}</span> : null}
                  </button>
                  {filtersOpen ? (
                    <div className="filter-popover">
                      <MultiFilterGroup allLabel="All" label="Status" onChange={setStatus} options={STATUS_FILTER_OPTIONS} value={status} />
                      <MultiFilterGroup allLabel="All" label="Library" onChange={setOwnership} options={OWNERSHIP_FILTER_OPTIONS} value={ownership} />
                      <MultiFilterGroup allLabel="All genres" label="Genre" onChange={setGenreFilter} options={genreOptions} value={genreFilter} />
                      <MultiFilterGroup allLabel={ANY_LENGTH_LABEL} label="Length" onChange={setLengthFilter} options={LENGTH_FILTER_OPTIONS} value={lengthFilter} />
                      <div className="filter-popover-actions">
                        <button onClick={clearFilters} type="button">Clear</button>
                        <button onClick={() => setFiltersOpen(false)} type="button">Done</button>
                      </div>
                    </div>
                  ) : null}
                </div>
                <label>Sort by</label>
                <select value={sort} onChange={(event) => setSort(event.target.value)}>
                  {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <button className={`view-button ${viewMode === "list" ? "active" : ""}`} onClick={() => setViewMode("list")} type="button" aria-label="List view">☷</button>
                <button className={`view-button ${viewMode === "grid" ? "active" : ""}`} onClick={() => setViewMode("grid")} type="button" aria-label="Cover view">▦</button>
              </div>
            </div>

            <div className={`table-head ${viewMode === "grid" ? "hidden" : ""}`}>
              <button onClick={() => toggleSort("title_asc", "title_desc")} type="button">Game</button>
              <button onClick={() => toggleSort("hours_desc", "hours_asc")} type="button">Playtime</button>
              <button onClick={() => toggleSort("progress_desc", "progress_asc")} type="button">Progress</button>
              <span className="table-label">Status</span>
              <span className="table-label">Genre</span>
              <span className="table-label label-with-help">
                Length
                <button className="length-help" type="button" aria-label={LENGTH_HELP_TEXT} aria-describedby="length-tooltip">
                  i
                  <span className="length-tooltip" id="length-tooltip" role="tooltip">
                    <strong>Length guide</strong>
                    <span>Bitesize: under 5h</span>
                    <span>Short: 5-10h</span>
                    <span>Weekend: 10-20h</span>
                    <span>Campaign: 20-40h</span>
                    <span>Meaty: 40-80h</span>
                    <span>Marathon: 80-120h</span>
                    <span>Odyssey: 120h+</span>
                    <span>Endless: replayable/live-service/sandbox</span>
                  </span>
                </button>
              </span>
              <button onClick={() => toggleSort("rating_desc", "rating_asc")} type="button">Rating</button>
              <span className="actions-head">⋮</span>
            </div>
            <div className={`table-body ${viewMode === "grid" ? "grid-view" : ""}`}>
              {filteredGames.length ? (
                filteredGames.map((game) =>
                  viewMode === "grid" ? (
                    <GameCard game={game} key={game.id} selected={game.id === selectedId} onSelect={() => {
                      setSelectedId(game.id);
                      setRowMenuId(null);
                    }} />
                  ) : (
                    <GameRow
                      game={game}
                      key={game.id}
                      menuOpen={rowMenuId === game.id}
                      selected={game.id === selectedId}
                      onCompleted={() => void markGameCompleted(game)}
                      onDelete={() => void deleteGame(game)}
                      onSelect={() => {
                        setSelectedId(game.id);
                        setRowMenuId(null);
                      }}
                      onToggleMenu={() => setRowMenuId((current) => current === game.id ? null : game.id)}
                    />
                  )
                )
              ) : (
                <GuestLibraryState loggedIn={isLoggedIn} onAdd={focusAddSearch} onSignIn={() => (window.location.href = "/login")} />
              )}
            </div>
          </section>
        </main>

        <aside className="details-panel">
          <div className="details-header">
            <h2>Game Details</h2>
          </div>
          <GameDetails game={selected} onOpenNotes={() => setNotesOpen(true)} onPlay={startSelectedPlaying} onUpdate={patchSelected} />
        </aside>
      </div>

      {notesOpen && selected ? (
        <div className="notes-overlay" role="dialog" aria-modal="true" aria-label={`${selected.title} notes`}>
          <section className="notes-modal">
            <header>
              <div>
                <p className="detail-kicker">Notes</p>
                <h2>{selected.title}</h2>
              </div>
              <div className="notes-modal-actions">
                {notesEditing ? (
                  <button className="soft-action" onClick={saveNotes} type="button">Save</button>
                ) : (
                  <button className="soft-action" onClick={() => setNotesEditing(true)} type="button">Edit</button>
                )}
                <button
                  className="nav-icon"
                  onClick={() => {
                    setNotesOpen(false);
                    setNotesEditing(false);
                    setNotesDraft(selected.notes || "");
                  }}
                  type="button"
                  aria-label="Close notes"
                >
                  ×
                </button>
              </div>
            </header>
            <textarea
              readOnly={!notesEditing}
              value={notesDraft}
              onChange={(event) => setNotesDraft(event.target.value)}
              placeholder="Add thoughts, saves, next steps, DLC notes, or why this belongs in the backlog."
            />
          </section>
        </div>
      ) : null}
    </div>
  );
}

function filterCount(query: string, status: string, ownership: string, genre: string, length: string) {
  return [
    query.trim() ? 1 : 0,
    selectedOptions(status, "All").length,
    selectedOptions(ownership, "All").length,
    selectedOptions(genre, "All genres").length,
    selectedOptions(length, ANY_LENGTH_LABEL).length
  ].reduce((total, count) => total + count, 0);
}

function activeFilterLabel(status: string, ownership: string, genre: string, length: string) {
  const active = [
    ...selectedOptions(status, "All"),
    ...selectedOptions(ownership, "All"),
    ...selectedOptions(genre, "All genres"),
    ...selectedOptions(length, ANY_LENGTH_LABEL)
  ].filter(Boolean);
  return active.length ? active.join(" · ") : "All games are visible. Use Filter above the list to narrow things down.";
}

function selectedOptions(value: string, allLabel: string) {
  if (!value || value === allLabel) return [];
  return value
    .split(FILTER_SEPARATOR)
    .map((option) => option.trim())
    .filter(Boolean);
}

function encodedOptions(values: string[], allLabel: string) {
  return values.length ? values.join(FILTER_SEPARATOR) : allLabel;
}

function toggleFilterOption(value: string, option: string, allLabel: string) {
  const selected = selectedOptions(value, allLabel);
  const next = selected.includes(option)
    ? selected.filter((item) => item !== option)
    : [...selected, option];
  return encodedOptions(next, allLabel);
}

function MultiFilterGroup({
  allLabel,
  label,
  onChange,
  options,
  value
}: {
  allLabel: string;
  label: string;
  onChange: (value: string) => void;
  options: string[];
  value: string;
}) {
  const selected = selectedOptions(value, allLabel);
  return (
    <fieldset className="filter-group">
      <legend>{label}</legend>
      <div className="filter-chip-group">
        <button className={!selected.length ? "active" : ""} onClick={() => onChange(allLabel)} type="button">
          {allLabel}
        </button>
        {options.map((option) => (
          <button
            aria-pressed={selected.includes(option)}
            className={selected.includes(option) ? "active" : ""}
            key={option}
            onClick={() => onChange(toggleFilterOption(value, option, allLabel))}
            type="button"
          >
            {option}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function readSavedTheme(): ThemeOptionId {
  if (typeof window === "undefined") return DEFAULT_THEME_ID;
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeOptionId(saved) ? saved : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

async function steamAppDetails(appid: string) {
  try {
    const payload = await api<{ details: Partial<GamePayload> | null }>(`/api/steam/apps/${encodeURIComponent(appid)}`);
    return payload.details;
  } catch {
    return null;
  }
}

function needsSteamMetadata(game: Game) {
  return Boolean(game.steam_appid && (!topLevelGenresFor(game.genre, game.title).length || !game.capsule_url || !game.header_url || Number(game.rating || 0) <= 0));
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function loadPreviewGames() {
  try {
    const raw = window.localStorage.getItem(PREVIEW_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isPreviewGame).map(cleanPreviewNotes).slice(0, 24) : [];
  } catch {
    return [];
  }
}

function savePreviewGames(games: Game[]) {
  try {
    window.localStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(games.slice(0, 24)));
  } catch {
    // Preview mode is best-effort; the real app path uses Supabase after sign-in.
  }
}

function isPreviewGame(value: unknown): value is Game {
  const game = value as Game;
  return Boolean(game && typeof game.id === "string" && typeof game.title === "string");
}

function previewGameFromPayload(payload: GamePayload, id?: string): Game {
  const now = new Date().toISOString();
  const title = payload.title.trim() || "Untitled game";
  const genre = payload.genre?.trim() || "Unknown";
  const hours = Number(payload.hours_played || 0);
  const storedCompletion = clamp(Math.round(Number(payload.completion_percentage || 0)), 0, 100);
  const completion = payload.status === "Completed" ? 100 : storedCompletion || inferredProgressFromHours({ title, genre, hours_played: hours }, hours);
  return {
    id: id ?? (globalThis.crypto?.randomUUID?.() || `preview-${Date.now()}`),
    user_id: "preview",
    title,
    genre,
    store: payload.store?.trim() || "Steam",
    ownership: payload.ownership,
    status: statusFromCompletion(completion),
    rating: Number(payload.rating || 0),
    hours_played: hours,
    completion_percentage: completion,
    priority: payload.priority,
    date_added: payload.date_added || new Date().toLocaleDateString("en-GB"),
    last_played_at: payload.last_played_at || null,
    notes: payload.notes?.trim() || "",
    steam_appid: payload.steam_appid ? String(payload.steam_appid) : null,
    capsule_url: payload.capsule_url || null,
    header_url: payload.header_url || null,
    created_at: now,
    updated_at: now
  };
}

function upsertPreview(games: Game[], game: Game) {
  const existing = games.findIndex((item) => item.id === game.id || (game.steam_appid && item.steam_appid === game.steam_appid));
  if (existing === -1) return [game, ...games].slice(0, 24);
  return games.map((item, index) => (index === existing ? { ...item, ...game, id: item.id, created_at: item.created_at } : item));
}

function previewStats(games: Game[]): StatsPayload {
  const ratings = games.map((game) => Number(game.rating || 0)).filter((rating) => rating > 0);
  const completionTotal = games.reduce((total, game) => total + gameProgress(game), 0);
  const completed = games.filter(isCompleted).length;
  const inProgress = games.filter((game) => displayStatus(game) === "In Progress").length;
  return {
    total: games.length,
    completed,
    in_progress: inProgress,
    wishlist: games.filter((game) => game.ownership === "Wishlist").length,
    hours: round1(games.reduce((total, game) => total + Number(game.hours_played || 0), 0)),
    avg_rating: ratings.length ? round1(ratings.reduce((total, rating) => total + rating, 0) / ratings.length) : 0,
    avg_completion: games.length ? round1(completionTotal / games.length) : 0
  };
}

function pickShuffleGames(games: Game[], count: number) {
  const candidates = games.filter((game) => !isCompleted(game));
  return randomSample(candidates, count);
}

function randomSample<T>(items: T[], count: number) {
  const pool = [...items];
  const picks: T[] = [];
  while (pool.length && picks.length < count) {
    const index = Math.floor(Math.random() * pool.length);
    const [item] = pool.splice(index, 1);
    picks.push(item);
  }
  return picks;
}

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

function cleanPreviewNotes(game: Game) {
  const notes = String(game.notes || "").trim();
  return /^(Imported from Steam account|Added from Steam search)\. AppID: \d+$/i.test(notes) ? { ...game, notes: "" } : game;
}
