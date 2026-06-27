"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Game, GamePayload, RecommendationPayload, SessionPayload, StatsPayload, SteamSearchResult } from "@/lib/types";
import { steamImageUrl } from "@/lib/images";

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
  const [priorityFilter, setPriorityFilter] = useState("All priorities");
  const [playtimeFilter, setPlaytimeFilter] = useState("Any playtime");
  const [hideCompleted, setHideCompleted] = useState(false);
  const [sort, setSort] = useState("hours_desc");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rowMenuId, setRowMenuId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [mood, setMood] = useState("Any vibe");
  const [time, setTime] = useState("Any time");
  const [shuffleCount, setShuffleCount] = useState<1 | 2 | 3>(3);
  const [shuffleCards, setShuffleCards] = useState<Game[]>([]);
  const [shuffleMessage, setShuffleMessage] = useState("Choose a vibe and roll an unfinished owned game.");
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

  const filteredGames = useMemo(() => {
    const lowerQuery = query.trim().toLowerCase();
    const priorityScore = { High: 3, Medium: 2, Low: 1 } as Record<string, number>;
    const statusScore = { "In Progress": 1, "Not Started": 2, Completed: 3 } as Record<string, number>;

    return games
      .filter((game) => {
        const text = `${game.title} ${game.genre} ${game.store} ${game.status} ${game.priority} ${game.notes} ${game.steam_appid ?? ""}`.toLowerCase();
        return (
          (!lowerQuery || text.includes(lowerQuery)) &&
          (status === "All" || game.status === status) &&
          (ownership === "All" || game.ownership === ownership) &&
          (priorityFilter === "All priorities" || game.priority === priorityFilter) &&
          (playtimeFilter === "Any playtime" || timeBucket(game) === playtimeFilter) &&
          (!hideCompleted || !isCompleted(game))
        );
      })
      .sort((a, b) => {
        if (sort === "title_asc") return a.title.localeCompare(b.title);
        if (sort === "title_desc") return b.title.localeCompare(a.title);
        if (sort === "status_asc") return (statusScore[a.status] || 9) - (statusScore[b.status] || 9);
        if (sort === "hours_asc") return Number(a.hours_played || 0) - Number(b.hours_played || 0);
        if (sort === "last_played_desc") return dateSortValue(b.last_played_at) - dateSortValue(a.last_played_at);
        if (sort === "priority_desc") return (priorityScore[b.priority] || 0) - (priorityScore[a.priority] || 0);
        return Number(b.hours_played || 0) - Number(a.hours_played || 0);
      });
  }, [games, hideCompleted, ownership, playtimeFilter, priorityFilter, query, sort, status]);

  const selected = games.find((game) => game.id === selectedId) ?? null;
  const visibleShuffleCards = shuffleCards.slice(0, shuffleCount);

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
    setPriorityFilter("All priorities");
    setPlaytimeFilter("Any playtime");
    setHideCompleted(false);
    setFiltersOpen(false);
  }

  function revealLibrary() {
    setQuery("");
    setStatus("All");
    setOwnership("All");
    setPriorityFilter("All priorities");
    setPlaytimeFilter("Any playtime");
    setHideCompleted(false);
    setFiltersOpen(false);
  }

  function applyStatFilter(action: StatAction) {
    setQuery("");
    setStatus("All");
    setOwnership("All");
    setPriorityFilter("All priorities");
    setPlaytimeFilter("Any playtime");
    setHideCompleted(false);
    setFiltersOpen(false);
    if (action === "completed") setStatus("Completed");
    if (action === "progress") setStatus("In Progress");
    if (action === "not_started") setStatus("Not Started");
    if (action === "wishlist") setOwnership("Wishlist");
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

  async function patchSelected(payload: Partial<GamePayload>) {
    if (!selected) return;
    if (!isLoggedIn) {
      const nextGames = games.map((game) =>
        game.id === selected.id ? { ...game, ...payload, updated_at: new Date().toISOString() } : game
      );
      applyPreviewGames(nextGames, selected.id, "Updated your temporary preview game.");
      return;
    }
    await api(`/api/games/${selected.id}`, { method: "PATCH", body: JSON.stringify(payload) });
    await refreshLibrary(selected.id);
  }

  async function markSelectedCompleted() {
    await patchSelected({ status: "Completed", completion_percentage: 100 });
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
    const picks = pickShuffleGames(filteredGames, mood, time, shuffleCount);
    if (!picks.length) {
      const reason = isLoggedIn
        ? "No games match the current filters and shuffle settings."
        : "Add a demo game first, or sign in with Steam to shuffle your real backlog.";
      setShuffleCards([]);
      setShuffleMessage(reason);
      if (!isLoggedIn) setGuestPrompt(true);
      return;
    }
    setShuffleCards(picks);
    setShuffleMessage(`${picks.length} random ${picks.length === 1 ? "pick" : "picks"} from your current filters.`);
    setSelectedId(picks[0].id);
  }

  function changeShuffleCount(count: 1 | 2 | 3) {
    setShuffleCount(count);
    playShuffleAnimation();
    const picks = pickShuffleGames(filteredGames, mood, time, count);
    if (!picks.length) {
      setShuffleCards([]);
      setShuffleMessage("No games match the current filters and shuffle settings.");
      return;
    }
    setShuffleCards(picks);
    setShuffleMessage(`${picks.length} random ${picks.length === 1 ? "pick" : "picks"} from your current filters.`);
    setSelectedId(picks[0].id);
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

  function syncMetadataManually() {
    if (!isLoggedIn) {
      window.location.href = "/login";
      return;
    }
    setNotice("Checking Steam metadata in the background...");
    void syncSteamMetadata(METADATA_SYNC_MAX_BATCHES, true);
    setSettingsOpen(false);
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
    <div className="app-shell">
      <header className="top-nav">
        <div className="nav-brand">
          <span className="brand-lockup" aria-label="Vault Shuffle">
            <img src="/assets/vault-shuffle-icon.png" alt="" />
            <strong>Vault Shuffle</strong>
          </span>
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
            {isLoggedIn ? "⇩ Import Steam Library" : "Sign in with Steam"}
          </button>
          {isLoggedIn ? <button className="ghost subtle" onClick={logout}>Sign out</button> : null}
          <div className="settings-wrap">
            <button className={`nav-icon settings-button ${settingsOpen ? "active" : ""}`} onClick={() => setSettingsOpen((open) => !open)} type="button" aria-label="Settings">
              ⚙
            </button>
            {settingsOpen ? (
              <div className="settings-menu">
                <strong>Settings</strong>
                <button className={viewMode === "list" ? "active" : ""} onClick={() => setViewMode("list")} type="button">List view</button>
                <button className={viewMode === "grid" ? "active" : ""} onClick={() => setViewMode("grid")} type="button">Cover view</button>
                <label className="filter-switch compact">
                  <input checked={hideCompleted} onChange={(event) => setHideCompleted(event.target.checked)} type="checkbox" />
                  <span className="switch-visual" aria-hidden="true" />
                  <span>Hide completed</span>
                </label>
                <button onClick={syncMetadataManually} type="button">Sync Steam metadata</button>
                <button onClick={clearFilters} type="button">Clear filters</button>
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
            {statRows(stats).map(({ icon, label, value, action }) => (
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
          <div className="side-actions">
            <h2>Selected actions</h2>
            <p>{selected ? selected.title : "Pick a game first"}</p>
            <div className="quick-actions">
              <button disabled={!selected} onClick={startSelectedPlaying}>Start playing</button>
              <button disabled={!selected} onClick={markSelectedCompleted}>Mark complete</button>
            </div>
          </div>
          <div className="side-summary">
            <h2>Smart rules</h2>
            <p>{activeFilterLabel(status, ownership, priorityFilter, playtimeFilter, hideCompleted)}</p>
          </div>
        </aside>

        <main className="library-main">
          <section className="smart-strip">
            <div className="shuffle-row">
              <div>
                <h2>◎ Smart Shuffle</h2>
                <p>Get a recommendation based on your filters and preferences</p>
              </div>
              <select value={mood} onChange={(event) => setMood(event.target.value)}>
                <option>Any vibe</option>
                <option>Relaxed</option>
                <option>Action</option>
                <option>Story</option>
                <option>Competitive</option>
              </select>
              <select value={time} onChange={(event) => setTime(event.target.value)}>
                <option>Any time</option>
                <option>1-5h</option>
                <option>6-15h</option>
                <option>16-30h</option>
                <option>31-50h</option>
                <option>51+h</option>
              </select>
              <button className="shuffle-button" onClick={shuffle}>
                Shuffle
              </button>
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
            <div className="shuffle-count-row" aria-label="Number of games to shuffle">
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
          </section>

          <section className={`library-table ${viewMode === "grid" ? "grid-mode" : ""}`}>
            <div className="table-toolbar">
              <strong>{filteredGames.length} {filteredGames.length === 1 ? "game" : "games"}</strong>
              <div className="toolbar-controls">
                <div className="filter-popover-wrap">
                  <button className={`filter-button ${filtersOpen ? "active" : ""}`} onClick={() => setFiltersOpen((open) => !open)} type="button">
                    Filter
                    <span>{filterCount(query, status, ownership, priorityFilter, playtimeFilter, hideCompleted)}</span>
                  </button>
                  {filtersOpen ? (
                    <div className="filter-popover">
                      <label>Search<input value={query} onChange={(event) => setQuery(event.target.value)} type="search" placeholder="Filter library..." /></label>
                      <label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option>All</option><option>Completed</option><option>In Progress</option><option>Not Started</option></select></label>
                      <label>Ownership<select value={ownership} onChange={(event) => setOwnership(event.target.value)}><option>All</option><option>Owned</option><option>Wishlist</option><option>Game pass</option></select></label>
                      <label>Priority<select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)}><option>All priorities</option><option>High</option><option>Medium</option><option>Low</option></select></label>
                      <label>Playtime<select value={playtimeFilter} onChange={(event) => setPlaytimeFilter(event.target.value)}><option>Any playtime</option><option>1-5h</option><option>6-15h</option><option>16-30h</option><option>31-50h</option><option>51+h</option></select></label>
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
                  <option value="hours_desc">Playtime (High to Low)</option>
                  <option value="hours_asc">Playtime (Low to High)</option>
                  <option value="title_asc">Title (A → Z)</option>
                  <option value="title_desc">Title (Z → A)</option>
                  <option value="status_asc">Status</option>
                  <option value="last_played_desc">Last Played</option>
                  <option value="priority_desc">Priority</option>
                </select>
                <button className={`view-button ${viewMode === "list" ? "active" : ""}`} onClick={() => setViewMode("list")} type="button" aria-label="List view">☷</button>
                <button className={`view-button ${viewMode === "grid" ? "active" : ""}`} onClick={() => setViewMode("grid")} type="button" aria-label="Cover view">▦</button>
              </div>
            </div>

            <div className={`table-head ${viewMode === "grid" ? "hidden" : ""}`}>
              <span>Game</span>
              <span>Playtime</span>
              <span>Progress / Status</span>
              <span>Priority</span>
              <span>Time</span>
              <span>Last Played</span>
              <span>⚙</span>
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
            <button className="nav-icon">×</button>
          </div>
          <GameDetails game={selected} onOpenNotes={() => setNotesOpen(true)} onUpdate={patchSelected} />
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
  onDelete
}: {
  game: Game;
  selected: boolean;
  menuOpen: boolean;
  onSelect: () => void;
  onToggleMenu: () => void;
  onDelete: () => void;
}) {
  const progress = clamp(Number(game.completion_percentage || 0), 0, 100);
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
      <span className="progress-status-cell">
        <span className="progress-track">
          <span className="progress-fill" style={{ width: `${progress}%` }} />
        </span>
        <span className={`chip ${statusClass(game)}`}>{statusIcon(game)} {game.status}</span>
      </span>
      <span className="pill">
        <i className={`dot ${priorityClass(game.priority)}`} />
        {game.priority}
      </span>
      <span className="pill">{timeBucket(game)}</span>
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
  const progress = clamp(Number(game.completion_percentage || 0), 0, 100);
  return (
    <button className={`game-card ${selected ? "selected" : ""}`} onClick={onSelect} type="button">
      <span className="game-card-art">{game.steam_appid ? <SteamImage appId={game.steam_appid} type="header" /> : <Cover game={game} />}</span>
      <span className="game-card-body">
        <strong>{game.title}</strong>
        <small>{game.genre || "Unknown"} · {Number(game.hours_played || 0).toLocaleString()}h</small>
        <span className="game-card-meta">
          <span className="progress-track">
            <span className="progress-fill" style={{ width: `${progress}%` }} />
          </span>
          <span className={`chip ${statusClass(game)}`}>{game.status}</span>
        </span>
      </span>
    </button>
  );
}

function GameDetails({
  game,
  onOpenNotes,
  onUpdate
}: {
  game: Game | null;
  onOpenNotes: () => void;
  onUpdate: (payload: Partial<GamePayload>) => Promise<void>;
}) {
  if (!game) {
    return <div className="detail-content empty">Select a game from the library.</div>;
  }
  const progress = clamp(Number(game.completion_percentage || 0), 0, 100);
  return (
    <div className="detail-content">
      <div className="hero-cover">{game.steam_appid ? <SteamImage appId={game.steam_appid} type="header" /> : null}</div>
      <p className="detail-kicker">Now selected</p>
      <div className="detail-title">{game.title}</div>
      <div className="detail-subtitle">{game.genre || "Unknown"} · {game.store || "Steam"}</div>
      <div className="detail-pills">
        <span className="detail-pill"><i>{statusIcon(game)}</i>{game.status}</span>
        <span className="detail-pill"><i>◴</i>{timeBucket(game)}</span>
        <span className="detail-pill"><i>◎</i>{game.priority}</span>
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
        <DetailLine label="External rating" value={Number(game.rating) > 0 ? `${game.rating}/10` : "Not linked yet"} />
        <DetailLine
          label="Store"
          value={game.steam_appid ? <a href={`https://store.steampowered.com/app/${game.steam_appid}/`} target="_blank" rel="noreferrer">Open on Steam</a> : game.store}
        />
        {game.steam_appid ? <DetailLine label="Steam AppID" value={game.steam_appid} /> : null}
      </div>
      <InlineGameSettings game={game} onUpdate={onUpdate} />
      <section className="notes-preview">
        <strong>Notes</strong>
        <button onClick={onOpenNotes} type="button">View</button>
      </section>
    </div>
  );
}

function InlineGameSettings({ game, onUpdate }: { game: Game; onUpdate: (payload: Partial<GamePayload>) => Promise<void> }) {
  const [hoursDraft, setHoursDraft] = useState(numberField(game.hours_played));
  const [completionDraft, setCompletionDraft] = useState(numberField(game.completion_percentage));

  useEffect(() => {
    setHoursDraft(numberField(game.hours_played));
    setCompletionDraft(numberField(game.completion_percentage));
  }, [game.id, game.hours_played, game.completion_percentage]);

  function commitHours() {
    void onUpdate({ hours_played: parseNumberInput(hoursDraft) });
  }

  function commitCompletion() {
    const completion = parseNumberInput(completionDraft, 100);
    void onUpdate({
      completion_percentage: completion,
      status: completion >= 100 ? "Completed" : completion > 0 ? "In Progress" : game.status === "Completed" ? "Not Started" : game.status
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
        <label>
          Priority
          <select value={game.priority} onChange={(event) => void onUpdate({ priority: event.target.value as GamePayload["priority"] })}>
            <option>Low</option>
            <option>Medium</option>
            <option>High</option>
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

function filterCount(query: string, status: string, ownership: string, priority: string, playtime: string, hideCompleted: boolean) {
  return [query.trim(), status !== "All", ownership !== "All", priority !== "All priorities", playtime !== "Any playtime", hideCompleted].filter(Boolean).length;
}

function activeFilterLabel(status: string, ownership: string, priority: string, playtime: string, hideCompleted: boolean) {
  const active = [
    status !== "All" ? status : "",
    ownership !== "All" ? ownership : "",
    priority !== "All priorities" ? `Priority ${priority}` : "",
    playtime !== "Any playtime" ? playtime : "",
    hideCompleted ? "Completed hidden" : ""
  ].filter(Boolean);
  return active.length ? active.join(" · ") : "All games are visible. Use Filter above the list to narrow things down.";
}

function numberField(value: number | null | undefined) {
  const numeric = Number(value || 0);
  return numeric === 0 ? "" : String(numeric);
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
                  <small>{result.genre ? `${result.genre} · ` : ""}Steam AppID {result.appid}</small>
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
  return (
    <button className="rec-tile" onClick={onClick} type="button">
      <Cover game={game} />
      <div>
        <span>{game.title}</span>
        <p>~{Number(game.hours_played).toLocaleString()}h · {game.priority}</p>
      </div>
    </button>
  );
}

function Cover({ game, title }: { game?: Game; title?: string }) {
  return (
    <span className="cover">
      {game?.steam_appid ? <SteamImage appId={game.steam_appid} type="capsule" /> : null}
      {!game?.steam_appid ? <span className="fallback-initials">{initials(title || game?.title || "Game")}</span> : null}
    </span>
  );
}

function SteamImage({ appId, type }: { appId: string; type: "capsule" | "header" }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return <img src={steamImageUrl(appId, type)} alt="" loading="lazy" onError={() => setFailed(true)} />;
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
  return game.status === "Completed" || Number(game.completion_percentage || 0) >= 100;
}

function needsSteamMetadata(game: Game) {
  return Boolean(game.steam_appid && (!game.genre || game.genre === "Unknown"));
}

function statusClass(game: Game) {
  if (game.ownership === "Wishlist") return "wishlist";
  if (game.status === "Completed") return "completed";
  if (game.status === "In Progress") return "progress";
  return "";
}

function statusIcon(game: Game) {
  if (game.status === "In Progress") return "▶";
  if (game.status === "Completed") return "✓";
  return "↬";
}

function priorityClass(priority: string) {
  if (priority === "High") return "high";
  if (priority === "Low") return "low";
  return "";
}

function timeBucket(game: Game) {
  const hours = Number(game.hours_played || 0);
  if (hours > 50) return "51+h";
  if (hours > 30) return "31-50h";
  if (hours > 15) return "16-30h";
  if (hours > 5) return "6-15h";
  return "1-5h";
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

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function loadPreviewGames() {
  try {
    const raw = window.localStorage.getItem(PREVIEW_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isPreviewGame).slice(0, 24) : [];
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
  return {
    id: id ?? (globalThis.crypto?.randomUUID?.() || `preview-${Date.now()}`),
    user_id: "preview",
    title: payload.title.trim() || "Untitled game",
    genre: payload.genre?.trim() || "Unknown",
    store: payload.store?.trim() || "Steam",
    ownership: payload.ownership,
    status: payload.status,
    rating: Number(payload.rating || 0),
    hours_played: Number(payload.hours_played || 0),
    completion_percentage: payload.status === "Completed" ? 100 : Number(payload.completion_percentage || 0),
    priority: payload.priority,
    date_added: payload.date_added || new Date().toLocaleDateString("en-GB"),
    last_played_at: payload.last_played_at || null,
    notes: payload.notes?.trim() || "",
    steam_appid: payload.steam_appid ? String(payload.steam_appid) : null,
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
  const completionTotal = games.reduce((total, game) => total + Number(game.completion_percentage || 0), 0);
  return {
    total: games.length,
    completed: games.filter((game) => game.status === "Completed").length,
    in_progress: games.filter((game) => game.status === "In Progress").length,
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

function pickShuffleGames(games: Game[], mood: string, time: string, count: number) {
  const candidates = games.filter((game) => !isCompleted(game) && matchesMood(game, mood) && matchesTime(game, time));
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

function matchesMood(game: Game, mood: string) {
  if (mood === "Any vibe") return true;
  const text = `${game.title} ${game.genre} ${game.notes}`.toLowerCase();
  if (mood === "Relaxed") return /(casual|cozy|cosy|puzzle|simulation|sim|sandbox|farming|relax|family)/.test(text);
  if (mood === "Action") return /(action|shooter|fps|combat|hack|arcade|fighter)/.test(text);
  if (mood === "Story") return /(story|adventure|rpg|role-playing|narrative|visual novel)/.test(text);
  if (mood === "Competitive") return /(competitive|multiplayer|moba|sports|racing|strategy|battle royale|pvp)/.test(text);
  return true;
}

function matchesTime(game: Game, time: string) {
  if (time === "Any time") return true;
  return timeBucket(game) === time;
}

function previewScore(game: Game) {
  const priorityScore = game.priority === "High" ? 10 : game.priority === "Medium" ? 5 : 0;
  return Number(game.rating || 0) * 2 + priorityScore + Number(game.hours_played || 0) / 20;
}

function round1(value: number) {
  return Math.round(value * 10) / 10;
}
