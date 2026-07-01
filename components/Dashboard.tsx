"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Game, GamePayload, RecommendationPayload, SessionPayload, StatsPayload, SteamSearchResult } from "@/lib/types";
import { steamImageCandidates } from "@/lib/images";
import { DEFAULT_THEME_ID, THEME_OPTIONS, THEME_STORAGE_KEY, isThemeOptionId, type ThemeOptionId } from "@/lib/themes";

const emptyStats: StatsPayload = {
  total: 0,
  completed: 0,
  in_progress: 0,
  wishlist: 0,
  hours: 0,
  avg_rating: 0,
  avg_completion: 0
};

const emptyRecs: RecommendationPayload = { backlog: [], wishlist: [], random: null };
const PREVIEW_STORAGE_KEY = "vaultshuffle.preview.games";
const METADATA_SYNC_BATCH_SIZE = 8;
const METADATA_SYNC_DELAY_MS = 5000;
const METADATA_SYNC_MAX_BATCHES = 32;
const TIME_FILTER_OPTIONS = ["5h", "15h", "30h", "50h", "100h", "300h+"];

const blankGame: GamePayload = {
  title: "",
  genre: "Unknown",
  store: "Steam",
  ownership: "Owned",
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
  const [recs, setRecs] = useState<RecommendationPayload>(emptyRecs);
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addQuery, setAddQuery] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("All");
  const [ownership, setOwnership] = useState("All");
  const [genreFilter, setGenreFilter] = useState("All genres");
  const [playtimeFilter, setPlaytimeFilter] = useState("Any playtime");
  const [hideCompleted, setHideCompleted] = useState(false);
  const [sort, setSort] = useState("hours_desc");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedTheme, setSelectedTheme] = useState<ThemeOptionId>(readSavedTheme);
  const [rowMenuId, setRowMenuId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [shuffleCount, setShuffleCount] = useState<1 | 2 | 3>(3);
  const [shuffleCards, setShuffleCards] = useState<Game[]>([]);
  const [shuffleMessage, setShuffleMessage] = useState("Shuffle the games currently visible in your library.");
  const [shuffleSpinning, setShuffleSpinning] = useState(false);
  const [shuffleAnimationKey, setShuffleAnimationKey] = useState(0);
  const [steamResults, setSteamResults] = useState<SteamSearchResult[]>([]);
  const [steamQuery, setSteamQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [guestPrompt, setGuestPrompt] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesEditing, setNotesEditing] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");
  const steamDialogRef = useRef<HTMLDialogElement>(null);
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
    const timer = window.setTimeout(() => {
      if (steamQuery.trim().length >= 2) void searchSteam(steamQuery);
      else setSteamResults([]);
    }, 360);
    return () => window.clearTimeout(timer);
  }, [steamQuery]);

  useEffect(() => {
    if (!isLoggedIn || !games.some(needsSteamMetadata)) return;
    void syncSteamMetadata(2);
  }, [games.length, isLoggedIn]);

  const genreOptions = useMemo(() => {
    const genres = new Set<string>();
    games.forEach((game) => splitGenres(game.genre).forEach((genre) => genres.add(genre)));
    return Array.from(genres).sort((a, b) => a.localeCompare(b));
  }, [games]);

  const displayStats = useMemo(() => previewStats(games), [games]);

  const filteredGames = useMemo(() => {
    const lowerQuery = query.trim().toLowerCase();
    const statusScore = { "In Progress": 1, "Not Started": 2, Completed: 3 } as Record<string, number>;

    return games
      .filter((game) => {
        const effectiveStatus = displayStatus(game);
        const text = `${game.title} ${game.genre} ${game.store} ${effectiveStatus} ${game.notes} ${game.steam_appid ?? ""}`.toLowerCase();
        return (
          (!lowerQuery || text.includes(lowerQuery)) &&
          (status === "All" || effectiveStatus === status) &&
          (ownership === "All" || game.ownership === ownership) &&
          (genreFilter === "All genres" || splitGenres(game.genre).includes(genreFilter)) &&
          (playtimeFilter === "Any playtime" || timeBucket(game) === playtimeFilter) &&
          (!hideCompleted || !isCompleted(game))
        );
      })
      .sort((a, b) => {
        if (sort === "title_asc") return a.title.localeCompare(b.title);
        if (sort === "title_desc") return b.title.localeCompare(a.title);
        if (sort === "status_asc") return (statusScore[displayStatus(a)] || 9) - (statusScore[displayStatus(b)] || 9);
        if (sort === "status_desc") return (statusScore[displayStatus(b)] || 9) - (statusScore[displayStatus(a)] || 9);
        if (sort === "hours_asc") return Number(a.hours_played || 0) - Number(b.hours_played || 0);
        if (sort === "progress_desc") return gameProgress(b) - gameProgress(a);
        if (sort === "progress_asc") return gameProgress(a) - gameProgress(b);
        if (sort === "rating_desc") return Number(b.rating || 0) - Number(a.rating || 0);
        if (sort === "rating_asc") return Number(a.rating || 0) - Number(b.rating || 0);
        if (sort === "last_played_desc") return dateSortValue(b.last_played_at) - dateSortValue(a.last_played_at);
        if (sort === "last_played_asc") return dateSortValue(a.last_played_at) - dateSortValue(b.last_played_at);
        if (sort === "genre_asc") return primaryGenre(a).localeCompare(primaryGenre(b));
        if (sort === "genre_desc") return primaryGenre(b).localeCompare(primaryGenre(a));
        if (sort === "time_asc") return estimatedGameHours(a) - estimatedGameHours(b);
        if (sort === "time_desc") return estimatedGameHours(b) - estimatedGameHours(a);
        return Number(b.hours_played || 0) - Number(a.hours_played || 0);
      });
  }, [games, genreFilter, hideCompleted, ownership, playtimeFilter, query, sort, status]);

  const selected = games.find((game) => game.id === selectedId) ?? null;
  const visibleShuffleCards = shuffleCards.slice(0, shuffleCount);
  const shuffleEligibleCount = useMemo(() => filteredGames.filter((game) => !isCompleted(game)).length, [filteredGames]);
  const activeRulesLabel = activeFilterLabel(status, ownership, genreFilter, playtimeFilter, hideCompleted);

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
      const previewRecs = previewRecommendations(previewGames);
      setSession(sessionPayload);
      setGames(previewGames);
      setStats(previewStats(previewGames));
      setRecs(previewRecs);
      setShuffleCards(previewRecs.backlog.slice(0, 3));
      setShuffleMessage(previewGames.length ? "Shuffle your temporary preview list, or sign in to import the real thing." : "Add a few Steam games to try the app, or sign in when you want your own library.");
      setSelectedId((current) => current ?? previewGames[0]?.id ?? null);
      setGuestPrompt(!previewGames.length);
      return;
    }
    setGuestPrompt(false);
    const [{ games: nextGames }, nextStats, nextRecs] = await Promise.all([
      api<{ games: Game[] }>("/api/games"),
      api<StatsPayload>("/api/stats"),
      api<RecommendationPayload>("/api/recommendations")
    ]);
    setSession(sessionPayload);
    setGames(nextGames);
    setStats(nextStats);
    setRecs(nextRecs);
    setShuffleCards(nextRecs.backlog.slice(0, 3));
    setSelectedId((current) => current ?? nextGames[0]?.id ?? null);

    if (importAfterLogin && sessionPayload.has_steam_key) {
      try {
        const result = await api<{ imported: number }>("/api/steam/owned-games", { method: "POST", body: "{}" });
        const [{ games: importedGames }, importedStats, importedRecs] = await Promise.all([
          api<{ games: Game[] }>("/api/games"),
          api<StatsPayload>("/api/stats"),
          api<RecommendationPayload>("/api/recommendations")
        ]);
        setGames(importedGames);
        setStats(importedStats);
        setRecs(importedRecs);
        setShuffleCards(importedRecs.backlog.slice(0, 3));
        setSelectedId((current) => current ?? importedGames[0]?.id ?? null);
        setNotice(`Steam library import complete: ${result.imported} games added or updated.`);
        void syncSteamMetadata(METADATA_SYNC_MAX_BATCHES, true);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Steam library import failed.");
      }
    } else if (importAfterLogin) {
      setNotice("Steam sign-in worked. Add STEAM_WEB_API_KEY to Vercel to import your library.");
    }
  }

  async function refreshLibrary(preferredSelectedId?: string | null) {
    const [{ games: nextGames }, nextStats, nextRecs] = await Promise.all([
      api<{ games: Game[] }>("/api/games"),
      api<StatsPayload>("/api/stats"),
      api<RecommendationPayload>("/api/recommendations")
    ]);
    setGames(nextGames);
    setStats(nextStats);
    setRecs(nextRecs);
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
          body: JSON.stringify({ limit: METADATA_SYNC_BATCH_SIZE })
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
    setPlaytimeFilter("Any playtime");
    setHideCompleted(false);
    setFiltersOpen(false);
  }

  function revealLibrary() {
    setQuery("");
    setStatus("All");
    setOwnership("All");
    setGenreFilter("All genres");
    setPlaytimeFilter("Any playtime");
    setHideCompleted(false);
    setFiltersOpen(false);
  }

  function applyStatFilter(action: StatAction) {
    setQuery("");
    setStatus("All");
    setOwnership("All");
    setGenreFilter("All genres");
    setPlaytimeFilter("Any playtime");
    setHideCompleted(false);
    setFiltersOpen(false);
    if (action === "completed") setStatus("Completed");
    if (action === "progress") setStatus("In Progress");
    if (action === "not_started") setStatus("Not Started");
    if (action === "wishlist") setOwnership("Wishlist");
  }

  function toggleSort(descSort: string, ascSort: string) {
    setSort((current) => current === descSort ? ascSort : descSort);
  }

  function openSteamDialog(initialQuery = "") {
    const nextQuery = initialQuery.trim();
    setSteamQuery(nextQuery);
    setSteamResults([]);
    steamDialogRef.current?.showModal();
    if (nextQuery.length >= 2) void searchSteam(nextQuery);
  }

  function submitAddSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    openSteamDialog(addQuery);
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
      steam_appid: result.appid
    };
    if (!isLoggedIn) {
      const game = previewGameFromPayload(payload);
      const nextGames = upsertPreview(games, game);
      revealLibrary();
      applyPreviewGames(nextGames, game.id, "Added to your temporary preview list. Sign in with Steam when you want a saved library.");
      steamDialogRef.current?.close();
      return;
    }
    const { game } = await api<{ game: Game }>("/api/games", { method: "POST", body: JSON.stringify(payload) });
    steamDialogRef.current?.close();
    revealLibrary();
    await refreshLibrary(game.id);
    if (needsSteamMetadata(game)) void syncSteamMetadata(4);
    setAddQuery("");
    setSelectedId(game.id);
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

  async function shuffle() {
    playShuffleAnimation();
    const picks = pickShuffleGames(filteredGames, shuffleCount);
    if (!picks.length) {
      const reason = isLoggedIn
        ? "No unfinished games match the current library view."
        : "Add a demo game first, or sign in with Steam to shuffle your real backlog.";
      setShuffleCards([]);
      setShuffleMessage(reason);
      if (!isLoggedIn) setGuestPrompt(true);
      return;
    }
    setShuffleCards(picks);
    setShuffleMessage(`${picks.length} random ${picks.length === 1 ? "pick" : "picks"} from the games shown below.`);
    setSelectedId(picks[0].id);
  }

  function changeShuffleCount(count: 1 | 2 | 3) {
    setShuffleCount(count);
    if (shuffleCards.length >= count) return;
    const existingIds = new Set(shuffleCards.map((game) => game.id));
    const additions = randomSample(
      filteredGames.filter((game) => !isCompleted(game) && !existingIds.has(game.id)),
      count - shuffleCards.length
    );
    if (additions.length) setShuffleCards([...shuffleCards, ...additions]);
  }

  function playShuffleAnimation() {
    if (shuffleAnimationTimerRef.current) clearTimeout(shuffleAnimationTimerRef.current);
    setShuffleAnimationKey((key) => key + 1);
    setShuffleSpinning(true);
    shuffleAnimationTimerRef.current = setTimeout(() => {
      setShuffleSpinning(false);
      shuffleAnimationTimerRef.current = null;
    }, 850);
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
      setNotice("Add STEAM_WEB_API_KEY to Vercel before importing your owned Steam library.");
      return;
    }
    try {
      const result = await api<{ imported: number }>("/api/steam/owned-games", { method: "POST", body: "{}" });
      await refreshLibrary(selectedId);
      setNotice(`Steam library import complete: ${result.imported} games added or updated.`);
      void syncSteamMetadata(METADATA_SYNC_MAX_BATCHES);
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
    const nextRecs = previewRecommendations(nextGames);
    setGames(nextGames);
    setStats(previewStats(nextGames));
    setRecs(nextRecs);
    setShuffleCards(nextRecs.backlog.slice(0, 3));
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
        <form className="nav-search-group" onSubmit={submitAddSearch}>
          <div className="search-box add-search-box">
            <span>⌕</span>
            <input value={addQuery} onChange={(event) => setAddQuery(event.target.value)} type="search" placeholder="Search Steam to add a game..." />
            <button type="submit">Search</button>
          </div>
        </form>
        <div className="nav-actions">
          <span className="steam-profile">
            {isLoggedIn && session?.avatar_url ? <img src={session.avatar_url} alt="" /> : <span className="steam-avatar-fallback">{isLoggedIn ? "S" : "?"}</span>}
            <span>{isLoggedIn ? session?.display_name || "Steam user" : "Preview mode"}</span>
          </span>
          <button className="ghost" onClick={importSteamLibrary}>
            {isLoggedIn ? "⇩ Refresh Steam Library" : "⇩ Import Steam Library"}
          </button>
          {isLoggedIn ? <button className="ghost subtle" onClick={logout}>Sign out</button> : null}
          <div className="settings-wrap">
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
            <span>Sign in with Steam when you want your own games, playtime, and recommendations to appear.</span>
          </div>
          <a href="/login">Sign in</a>
          <button onClick={() => setGuestPrompt(false)} aria-label="Dismiss guest prompt">×</button>
        </div>
      ) : null}

      <div className="workspace">
        <aside className="library-panel">
          <h2>Library Overview</h2>
          <div className="overview-list">
            {statRows(displayStats).map(({ icon, label, value, action }) => (
              <button
                className={`stat-row ${action ? "" : "is-static"}`}
                disabled={!action}
                key={label}
                onClick={() => action && applyStatFilter(action)}
                type="button"
              >
                <span>{icon}</span>
                <span>{label}</span>
                <strong>{value}</strong>
              </button>
            ))}
          </div>
          <section className="sidebar-shuffle">
            <div>
              <h2>Smart Shuffle</h2>
              <p>Uses the same games and filters as the list beside it.</p>
            </div>
            <p className="shuffle-info"><span aria-hidden="true">i</span>Completed games are skipped automatically.</p>
            <div className="sidebar-shuffle-meta">
              <strong>{shuffleEligibleCount}</strong>
              <span>eligible games</span>
            </div>
            <div className="sidebar-shuffle-count" aria-label="Number of games to shuffle">
              {[1, 2, 3].map((count) => (
                <button
                  className={shuffleCount === count ? "active" : ""}
                  key={count}
                  onClick={() => changeShuffleCount(count as 1 | 2 | 3)}
                  type="button"
                >
                  {count}
                </button>
              ))}
            </div>
            <button className="shuffle-button sidebar-shuffle-button" onClick={shuffle} type="button">
              Shuffle {shuffleCount}
            </button>
          </section>
          <div className="side-summary">
            <h2>Current filter</h2>
            <p>{activeRulesLabel}</p>
          </div>
        </aside>

        <main className="library-main">
          <section className="smart-strip">
            <div className="shuffle-row smart-filter-row">
              <div>
                <h2>◎ Shuffle Deck</h2>
                <p>{shuffleMessage}</p>
              </div>
            </div>
            <div
              className={`shuffle-cards count-${visibleShuffleCards.length || shuffleCount} ${shuffleSpinning ? "is-spinning" : ""}`}
              key={shuffleAnimationKey}
            >
              {shuffleCards.length ? (
                visibleShuffleCards.map((game) => <RecommendationTile game={game} key={game.id} onClick={() => setSelectedId(game.id)} />)
              ) : (
                <div className="rec-tile">
                  <Cover title="No pick" />
                  <div>
                    <span>No pick yet</span>
                    <p>{shuffleMessage}</p>
                  </div>
                </div>
              )}
            </div>
          </section>

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
                    <span>{filterCount(query, status, ownership, genreFilter, playtimeFilter, hideCompleted)}</span>
                  </button>
                  {filtersOpen ? (
                    <div className="filter-popover">
                      <label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option>All</option><option>Completed</option><option>In Progress</option><option>Not Started</option></select></label>
                      <label>Ownership<select value={ownership} onChange={(event) => setOwnership(event.target.value)}><option>All</option><option>Owned</option><option>Wishlist</option><option>Game pass</option></select></label>
                      <label>Genre<select value={genreFilter} onChange={(event) => setGenreFilter(event.target.value)}><option>All genres</option>{genreOptions.map((genre) => <option key={genre}>{genre}</option>)}</select></label>
                      <label>Time<select value={playtimeFilter} onChange={(event) => setPlaytimeFilter(event.target.value)}><option>Any playtime</option>{TIME_FILTER_OPTIONS.map((option) => <option key={option}>{option}</option>)}</select></label>
                      <label className="filter-switch compact"><input checked={hideCompleted} onChange={(event) => setHideCompleted(event.target.checked)} type="checkbox" /><span className="switch-visual" aria-hidden="true" /><span>Hide completed</span></label>
                      <div className="filter-popover-actions">
                        <button onClick={clearFilters} type="button">Clear</button>
                        <button onClick={() => setFiltersOpen(false)} type="button">Done</button>
                      </div>
                    </div>
                  ) : null}
                </div>
                <label>Sort by</label>
                <select value={sort} onChange={(event) => setSort(event.target.value)}>
                  <option value="title_asc">Title (A → Z)</option>
                  <option value="title_desc">Title (Z → A)</option>
                  <option value="hours_desc">Playtime (High to Low)</option>
                  <option value="hours_asc">Playtime (Low to High)</option>
                  <option value="progress_desc">Progress (High to Low)</option>
                  <option value="progress_asc">Progress (Low to High)</option>
                  <option value="status_asc">Status</option>
                  <option value="status_desc">Status (Reverse)</option>
                  <option value="genre_asc">Genre</option>
                  <option value="genre_desc">Genre (Reverse)</option>
                  <option value="time_asc">Time (Short to Long)</option>
                  <option value="time_desc">Time (Long to Short)</option>
                  <option value="rating_desc">Rating (High to Low)</option>
                  <option value="rating_asc">Rating (Low to High)</option>
                  <option value="last_played_desc">Last Played</option>
                  <option value="last_played_asc">Oldest Played</option>
                </select>
                <button className={`view-button ${viewMode === "list" ? "active" : ""}`} onClick={() => setViewMode("list")} type="button" aria-label="List view">☷</button>
                <button className={`view-button ${viewMode === "grid" ? "active" : ""}`} onClick={() => setViewMode("grid")} type="button" aria-label="Cover view">▦</button>
              </div>
            </div>

            <div className={`table-head ${viewMode === "grid" ? "hidden" : ""}`}>
              <button onClick={() => toggleSort("title_asc", "title_desc")} type="button">Game</button>
              <button onClick={() => toggleSort("hours_desc", "hours_asc")} type="button">Playtime</button>
              <button onClick={() => toggleSort("progress_desc", "progress_asc")} type="button">Progress</button>
              <button onClick={() => toggleSort("status_asc", "status_desc")} type="button">Status</button>
              <button onClick={() => toggleSort("genre_asc", "genre_desc")} type="button">Genre</button>
              <button onClick={() => toggleSort("time_asc", "time_desc")} type="button">Time</button>
              <button onClick={() => toggleSort("rating_desc", "rating_asc")} type="button">Rating</button>
              <button onClick={() => toggleSort("last_played_desc", "last_played_asc")} type="button">Last Played</button>
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
                <GuestLibraryState loggedIn={isLoggedIn} onAdd={() => openSteamDialog()} onSignIn={() => (window.location.href = "/login")} />
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

      <SteamDialog
        dialogRef={steamDialogRef}
        query={steamQuery}
        results={steamResults}
        onQuery={setSteamQuery}
        onAdd={addSteamGame}
      />
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

function GameRow({
  game,
  selected,
  menuOpen,
  onSelect,
  onToggleMenu,
  onCompleted,
  onDelete
}: {
  game: Game;
  selected: boolean;
  menuOpen: boolean;
  onSelect: () => void;
  onToggleMenu: () => void;
  onCompleted: () => void;
  onDelete: () => void;
}) {
  const progress = gameProgress(game);
  const status = displayStatus(game);
  return (
    <div
      className={`game-row ${selected ? "selected" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.currentTarget !== event.target) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <span className="game-cell">
        <Cover game={game} />
        <span className="game-title">
          <strong>{game.title}</strong>
          <small>{game.genre || "Unknown"}</small>
        </span>
      </span>
      <span>{Number(game.hours_played).toLocaleString()}h</span>
      <span className="progress-cell">
        <span className="progress-track">
          <span className="progress-fill" style={{ width: `${progress}%` }} />
        </span>
      </span>
      <span className={`chip ${statusClass(game)}`}>{statusIcon(game)} {status}</span>
      <span className="pill genre-pill">{primaryGenre(game)}</span>
      <span className="pill">{timeBucket(game)}</span>
      <span>{Number(game.rating) > 0 ? `${game.rating}/10` : "—"}</span>
      <span>{formatLastPlayed(game.last_played_at)}</span>
      <span className="row-menu-cell">
        <button
          aria-label={`Actions for ${game.title}`}
          className="row-menu-button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleMenu();
          }}
          type="button"
        >
          ⋮
        </button>
        {menuOpen ? (
          <span className="row-menu" onClick={(event) => event.stopPropagation()}>
            <button
              onClick={(event) => {
                event.stopPropagation();
                onCompleted();
              }}
              type="button"
            >
              Completed
            </button>
            <button
              onClick={(event) => {
                event.stopPropagation();
                onDelete();
              }}
              type="button"
            >
              Delete
            </button>
          </span>
        ) : null}
      </span>
    </div>
  );
}

function GuestLibraryState({ loggedIn, onAdd, onSignIn }: { loggedIn: boolean; onAdd: () => void; onSignIn: () => void }) {
  return (
    <div className="guest-empty">
      <div className="guest-empty-art">
        <span />
        <span />
        <span />
      </div>
      <p className="detail-kicker">{loggedIn ? "Nothing matches those filters" : "Preview mode"}</p>
      <h3>{loggedIn ? "No games found." : "Your library will appear here."}</h3>
      <p>
        {loggedIn
          ? "Try clearing a filter or importing your Steam library again."
          : "You can explore the app layout for now. Sign in with Steam when you want Vault Shuffle to import games, playtime, and recommendations."}
      </p>
      {!loggedIn ? (
        <div className="guest-empty-actions">
          <button className="shuffle-button" onClick={onAdd}>Add a demo game</button>
          <button className="ghost" onClick={onSignIn}>Sign in with Steam</button>
        </div>
      ) : null}
    </div>
  );
}

function GameCard({ game, selected, onSelect }: { game: Game; selected: boolean; onSelect: () => void }) {
  const progress = gameProgress(game);
  const status = displayStatus(game);
  return (
    <button className={`game-card ${selected ? "selected" : ""}`} onClick={onSelect} type="button">
      <span className="game-card-art"><Cover game={game} /></span>
      <span className="game-card-body">
        <strong>{game.title}</strong>
        <small>{game.genre || "Unknown"} · {Number(game.hours_played || 0).toLocaleString()}h</small>
        <span className="game-card-meta">
          <span className="progress-track">
            <span className="progress-fill" style={{ width: `${progress}%` }} />
          </span>
          <span className={`chip ${statusClass(game)}`}>{status}</span>
        </span>
      </span>
    </button>
  );
}

function GameDetails({
  game,
  onOpenNotes,
  onPlay,
  onUpdate
}: {
  game: Game | null;
  onOpenNotes: () => void;
  onPlay: () => void;
  onUpdate: (payload: Partial<GamePayload>) => Promise<void>;
}) {
  if (!game) {
    return <div className="detail-content empty">Select a game from the library.</div>;
  }
  const progress = gameProgress(game);
  const status = displayStatus(game);
  const note = String(game.notes || "").trim();
  const ratingText = Number(game.rating) > 0 ? `${game.rating}/10` : "Sync pending";
  return (
    <div className="detail-content">
      <div className="hero-cover"><HeroArtwork game={game} /></div>
      <p className="detail-kicker">Now selected</p>
      <div className="detail-title">{game.title}</div>
      <div className="detail-subtitle">{game.genre || "Unknown"} · {game.store || "Steam"}</div>
      <div className="detail-pills">
        <span className="detail-pill"><i>{statusIcon(game)}</i>{status}</span>
        <span className="detail-pill"><i>◴</i>{timeBucket(game)}</span>
        <span className="detail-pill"><i>★</i>{Number(game.rating) > 0 ? ratingText : "No rating"}</span>
      </div>
      <div className="detail-progress">
        <div>
          <span>Progress</span>
          <strong>{progress}%</strong>
        </div>
        <span className="progress-track">
          <span className="progress-fill" style={{ width: `${progress}%` }} />
        </span>
      </div>
      <div className="detail-list">
        <DetailLine label="Playtime" value={`${Number(game.hours_played).toLocaleString()}h`} />
        <DetailLine label="Last Played" value={formatLastPlayed(game.last_played_at)} />
        <DetailLine label="Steam rating" value={ratingText} />
        <DetailLine
          label="Store"
          value={game.steam_appid ? <a href={`https://store.steampowered.com/app/${game.steam_appid}/`} target="_blank" rel="noreferrer">Open on Steam</a> : game.store}
        />
      </div>
      <InlineGameSettings game={game} onUpdate={onUpdate} />
      <section className={`notes-preview ${note ? "" : "is-empty"}`}>
        <div>
          <strong>Notes</strong>
          <p>{note || "No notes yet. Add why it is next, stuck, or worth saving for later."}</p>
        </div>
        <button onClick={onOpenNotes} type="button">View</button>
      </section>
      <button className="play-now-button" disabled={!game.steam_appid} onClick={onPlay} type="button">Play Now</button>
    </div>
  );
}

function InlineGameSettings({ game, onUpdate }: { game: Game; onUpdate: (payload: Partial<GamePayload>) => Promise<void> }) {
  const displayedProgress = gameProgress(game);
  const [hoursDraft, setHoursDraft] = useState(numberField(game.hours_played));
  const [completionDraft, setCompletionDraft] = useState(numberField(game.completion_percentage || displayedProgress));

  useEffect(() => {
    setHoursDraft(numberField(game.hours_played));
    setCompletionDraft(numberField(game.completion_percentage || displayedProgress));
  }, [game.id, game.hours_played, game.completion_percentage, displayedProgress]);

  function commitHours() {
    const hours = parseNumberInput(hoursDraft);
    const currentStoredCompletion = Number(game.completion_percentage || 0);
    const currentInferredCompletion = inferredProgressFromHours(game, Number(game.hours_played || 0));
    const hasManualCompletion = currentStoredCompletion > 0 && currentStoredCompletion !== currentInferredCompletion;
    const next: Partial<GamePayload> = { hours_played: hours };
    if (!hasManualCompletion) {
      const completion = inferredProgressFromHours(game, hours);
      next.completion_percentage = completion;
      next.status = statusFromCompletion(completion);
    }
    void onUpdate(next);
  }

  function commitCompletion() {
    const completion = parseNumberInput(completionDraft, 100);
    void onUpdate({
      completion_percentage: completion,
      status: statusFromCompletion(completion)
    });
  }

  return (
    <section className="inline-settings" aria-label="Your game settings">
      <h3>Your settings</h3>
      <div className="inline-settings-grid">
        <label>
          Hours
          <input
            inputMode="decimal"
            onBlur={commitHours}
            onChange={(event) => setHoursDraft(event.target.value)}
            placeholder="0"
            value={hoursDraft}
          />
        </label>
        <label>
          Completion
          <input
            inputMode="decimal"
            onBlur={commitCompletion}
            onChange={(event) => setCompletionDraft(event.target.value)}
            placeholder="0-100"
            value={completionDraft}
          />
        </label>
        <label>
          Ownership
          <select value={game.ownership} onChange={(event) => void onUpdate({ ownership: event.target.value as GamePayload["ownership"] })}>
            <option>Owned</option>
            <option>Wishlist</option>
            <option>Game pass</option>
          </select>
        </label>
      </div>
    </section>
  );
}

function DetailLine({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="detail-line">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function filterCount(query: string, status: string, ownership: string, genre: string, playtime: string, hideCompleted: boolean) {
  return [query.trim(), status !== "All", ownership !== "All", genre !== "All genres", playtime !== "Any playtime", hideCompleted].filter(Boolean).length;
}

function activeFilterLabel(status: string, ownership: string, genre: string, playtime: string, hideCompleted: boolean) {
  const active = [
    status !== "All" ? status : "",
    ownership !== "All" ? ownership : "",
    genre !== "All genres" ? genre : "",
    playtime !== "Any playtime" ? playtime : "",
    hideCompleted ? "Completed hidden" : ""
  ].filter(Boolean);
  return active.length ? active.join(" · ") : "All games are visible. Use Filter above the list to narrow things down.";
}

function numberField(value: number | null | undefined) {
  const numeric = Number(value || 0);
  return numeric === 0 ? "" : String(numeric);
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

function parseNumberInput(value: string, max?: number) {
  const cleaned = value.replace(/[^\d.]/g, "");
  if (!cleaned) return 0;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return 0;
  return typeof max === "number" ? Math.min(parsed, max) : parsed;
}

async function steamAppDetails(appid: string) {
  try {
    const payload = await api<{ details: Partial<GamePayload> | null }>(`/api/steam/apps/${encodeURIComponent(appid)}`);
    return payload.details;
  } catch {
    return null;
  }
}

function SteamDialog({
  dialogRef,
  query,
  results,
  onQuery,
  onAdd
}: {
  dialogRef: React.RefObject<HTMLDialogElement | null>;
  query: string;
  results: SteamSearchResult[];
  onQuery: (value: string) => void;
  onAdd: (result: SteamSearchResult) => void;
}) {
  return (
    <dialog ref={dialogRef} className="steam-dialog">
      <form method="dialog">
        <header>
          <div>
            <h2>Add from Steam</h2>
            <p>Search the Steam store and add a game with artwork ready to go.</p>
          </div>
          <button type="button" className="nav-icon" onClick={() => dialogRef.current?.close()}>×</button>
        </header>
        <div className="steam-search-panel">
          <label className="steam-search-box">
            <span>⌕</span>
            <input value={query} onChange={(event) => onQuery(event.target.value)} type="search" placeholder="Search Steam games..." />
          </label>
          <div className="steam-results">
            {query.trim().length < 2 ? <p className="steam-hint">Type a game name to search Steam.</p> : null}
            {query.trim().length >= 2 && !results.length ? <p className="steam-hint">No Steam games found yet.</p> : null}
            {results.map((result) => (
              <button className="steam-result" key={result.appid} type="button" onClick={() => onAdd(result)}>
                <span className="steam-result-art">{result.image ? <img src={result.image} alt="" /> : null}</span>
                <span>
                  <strong>{result.name}</strong>
                  <small>{result.genre ? `${result.genre} · ` : ""}Steam</small>
                </span>
                <b>Add</b>
              </button>
            ))}
          </div>
        </div>
        <footer>
          <button type="button" onClick={() => dialogRef.current?.close()}>Cancel</button>
        </footer>
      </form>
    </dialog>
  );
}

function RecommendationTile({ game, onClick }: { game: Game; onClick: () => void }) {
  const note = String(game.notes || "").trim();
  return (
    <button className="rec-tile" onClick={onClick} type="button">
      <Cover game={game} />
      <div>
        <span>{game.title}</span>
        <p>{primaryGenre(game)} · {timeBucket(game)}</p>
        {note ? <small>{note}</small> : null}
      </div>
    </button>
  );
}

function HeroArtwork({ game }: { game: Game }) {
  const candidates = useMemo(() => {
    return [...steamImageCandidates(game, "header"), ...steamImageCandidates(game, "capsule")];
  }, [game.capsule_url, game.header_url, game.id, game.steam_appid]);
  const [imageIndex, setImageIndex] = useState(0);

  useEffect(() => {
    setImageIndex(0);
  }, [game.capsule_url, game.header_url, game.id, game.steam_appid]);

  const src = candidates[imageIndex];
  if (!src) return <Cover game={game} />;
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      onError={() => setImageIndex((current) => current + 1)}
    />
  );
}

function Cover({ game, title }: { game?: Game; title?: string }) {
  const displayTitle = title || game?.title || "Game";
  const candidates = useMemo(() => steamImageCandidates(game, "capsule"), [game?.capsule_url, game?.id, game?.steam_appid]);
  const [imageIndex, setImageIndex] = useState(0);

  useEffect(() => {
    setImageIndex(0);
  }, [game?.capsule_url, game?.id, game?.steam_appid, displayTitle]);

  const src = candidates[imageIndex];

  return (
    <span className="cover">
      {src ? (
        <img src={src} alt="" loading="lazy" onError={() => setImageIndex((current) => current + 1)} />
      ) : (
        <span className="fallback-initials">{initials(displayTitle)}</span>
      )}
    </span>
  );
}

type StatAction = "all" | "completed" | "progress" | "not_started" | "wishlist";

function statRows(stats: StatsPayload): Array<{ icon: string; label: string; value: string | number; action: StatAction | null }> {
  const total = stats.total || 1;
  const notStarted = Math.max(0, stats.total - stats.completed - stats.in_progress);
  return [
    { icon: "▦", label: "Total Games", value: stats.total, action: "all" },
    { icon: "✓", label: "Completed", value: `${stats.completed} (${Math.round((stats.completed / total) * 100)}%)`, action: "completed" },
    { icon: "▣", label: "In Progress", value: `${stats.in_progress} (${Math.round((stats.in_progress / total) * 100)}%)`, action: "progress" },
    {
      icon: "□",
      label: "Not Started",
      value: `${notStarted} (${Math.round((notStarted / total) * 100)}%)`,
      action: "not_started"
    },
    { icon: "♡", label: "Wishlist", value: stats.wishlist, action: "wishlist" },
    { icon: "◴", label: "Hours Played (All)", value: Number(stats.hours).toLocaleString(), action: null },
    { icon: "◎", label: "Completion Rate", value: `${stats.avg_completion}%`, action: null }
  ];
}

function isCompleted(game: Game) {
  return game.status === "Completed" || gameProgress(game) >= 100;
}

function needsSteamMetadata(game: Game) {
  return Boolean(game.steam_appid && (!splitGenres(game.genre).length || !game.capsule_url || !game.header_url || Number(game.rating || 0) <= 0));
}

function statusClass(game: Game) {
  if (game.ownership === "Wishlist") return "wishlist";
  if (isCompleted(game)) return "completed";
  if (displayStatus(game) === "In Progress") return "progress";
  return "";
}

function statusIcon(game: Game) {
  if (isCompleted(game)) return "✓";
  if (displayStatus(game) === "In Progress") return "▶";
  return "↬";
}

function displayStatus(game: Game) {
  if (isCompleted(game)) return "Completed";
  if (gameProgress(game) > 0) return "In Progress";
  return "Not Started";
}

function timeBucket(game: Game) {
  const estimate = estimatedGameHours(game);
  if (estimate <= 5) return "5h";
  if (estimate <= 15) return "15h";
  if (estimate <= 30) return "30h";
  if (estimate <= 50) return "50h";
  if (estimate <= 100) return "100h";
  return "300h+";
}

function gameProgress(game: Game) {
  if (game.status === "Completed") return 100;
  const inferred = inferredProgressFromHours(game, Number(game.hours_played || 0));
  const stored = Number(game.completion_percentage || 0);
  if (stored > 0) {
    const roundedStored = clamp(Math.round(stored), 0, 100);
    return inferred >= 100 && roundedStored >= 99 ? 100 : roundedStored;
  }
  return inferred;
}

function inferredProgressFromHours(game: Game, hours: number) {
  const estimate = estimatedGameHours(game);
  const played = Number(hours || 0);
  if (!played || !estimate) return 0;
  if (played >= estimate) return 100;
  return clamp(Math.round((played / estimate) * 100), 0, 99);
}

function estimatedGameHours(game: Game) {
  const text = `${game.title} ${game.genre}`.toLowerCase();
  if (Number(game.hours_played || 0) >= 300) return 300;
  if (/(counter-?strike|destiny|apex legends|rust|palworld|new world|for honor|warframe|dota|team fortress|pubg|rainbow six|rocket league|dead by daylight|elder scrolls online|final fantasy xiv|path of exile|lost ark)/.test(text)) return 300;
  if (/(mmo|massively multiplayer|multiplayer|battle royale|moba|live service|survival|sandbox|free to play|pvp|pve|online)/.test(text)) return 300;
  if (/(rpg|role-playing|strategy|simulation|management|grand strategy|4x|open world)/.test(text)) return 100;
  if (/(adventure|action-adventure|souls|metroidvania|horror)/.test(text)) return 50;
  if (/(action|shooter|fps|third-person|racing|sports|fighting)/.test(text)) return 30;
  if (/(puzzle|casual|arcade|platformer|indie|hidden object|visual novel)/.test(text)) return 15;
  return 30;
}

function splitGenres(value?: string | null) {
  const genres = String(value || "")
    .split(/[\/,;|]+/g)
    .map((genre) => genre.trim())
    .filter((genre) => genre && genre.toLowerCase() !== "unknown");
  return Array.from(new Set(genres));
}

function primaryGenre(game: Game) {
  return splitGenres(game.genre)[0] || "Unknown";
}

function dateSortValue(value?: string | null) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatLastPlayed(value?: string | null) {
  if (!value) return "Never";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function initials(title: string) {
  return (
    title
      .replace(/[^a-zA-Z0-9 ]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0])
      .join("")
      .toUpperCase() || "VS"
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

function statusFromCompletion(completion: number): GamePayload["status"] {
  if (completion >= 100) return "Completed";
  if (completion > 0) return "In Progress";
  return "Not Started";
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
  const completion = payload.status === "Completed" ? 100 : clamp(Math.round(Number(payload.completion_percentage || 0)), 0, 100);
  return {
    id: id ?? (globalThis.crypto?.randomUUID?.() || `preview-${Date.now()}`),
    user_id: "preview",
    title: payload.title.trim() || "Untitled game",
    genre: payload.genre?.trim() || "Unknown",
    store: payload.store?.trim() || "Steam",
    ownership: payload.ownership,
    status: statusFromCompletion(completion),
    rating: Number(payload.rating || 0),
    hours_played: Number(payload.hours_played || 0),
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
  const inProgress = games.filter((game) => !isCompleted(game) && (game.status === "In Progress" || gameProgress(game) > 0)).length;
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

function previewRecommendations(games: Game[]): RecommendationPayload {
  const backlog = [...games]
    .filter((game) => game.ownership === "Owned" && !isCompleted(game))
    .sort((a, b) => previewScore(b) - previewScore(a))
    .slice(0, 3);
  const wishlist = [...games]
    .filter((game) => game.ownership === "Wishlist")
    .sort((a, b) => previewScore(b) - previewScore(a))
    .slice(0, 3);
  const unfinished = games.filter((game) => game.ownership === "Owned" && !isCompleted(game));
  return { backlog, wishlist, random: unfinished.length ? unfinished[Math.floor(Math.random() * unfinished.length)] : null };
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

function previewScore(game: Game) {
  return Number(game.rating || 0) * 2 + gameProgress(game) / 10 + Number(game.hours_played || 0) / 30;
}

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

function cleanPreviewNotes(game: Game) {
  const notes = String(game.notes || "").trim();
  return /^(Imported from Steam account|Added from Steam search)\. AppID: \d+$/i.test(notes) ? { ...game, notes: "" } : game;
}
