"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
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
    window.location.href = "/login";
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
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("All");
  const [ownership, setOwnership] = useState("All");
  const [priorityFilter, setPriorityFilter] = useState("All vibes");
  const [playtimeFilter, setPlaytimeFilter] = useState("Any playtime");
  const [hideCompleted, setHideCompleted] = useState(false);
  const [sort, setSort] = useState("hours_desc");
  const [mood, setMood] = useState("Any vibe");
  const [time, setTime] = useState("Any time");
  const [shuffleCards, setShuffleCards] = useState<Game[]>([]);
  const [shuffleMessage, setShuffleMessage] = useState("Choose a vibe and roll an unfinished owned game.");
  const [steamResults, setSteamResults] = useState<SteamSearchResult[]>([]);
  const [steamQuery, setSteamQuery] = useState("");
  const [formGame, setFormGame] = useState<GamePayload>(blankGame);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const steamDialogRef = useRef<HTMLDialogElement>(null);
  const gameDialogRef = useRef<HTMLDialogElement>(null);

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
    const timer = window.setTimeout(() => {
      if (steamQuery.trim().length >= 2) void searchSteam(steamQuery);
      else setSteamResults([]);
    }, 260);
    return () => window.clearTimeout(timer);
  }, [steamQuery]);

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
          (priorityFilter === "All vibes" || game.priority === priorityFilter) &&
          (playtimeFilter === "Any playtime" || timeBucket(game) === playtimeFilter) &&
          (!hideCompleted || game.status !== "Completed")
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

  async function load(importAfterLogin = false) {
    const sessionPayload = await api<SessionPayload>("/api/session");
    if (!sessionPayload.logged_in) {
      window.location.href = "/login";
      return;
    }
    const [{ games: nextGames }, nextStats, nextRecs] = await Promise.all([
      api<{ games: Game[] }>("/api/games"),
      api<StatsPayload>("/api/stats"),
      api<RecommendationPayload>("/api/recommendations")
    ]);
    setSession(sessionPayload);
    setGames(nextGames);
    setStats(nextStats);
    setRecs(nextRecs);
    setShuffleCards(nextRecs.backlog.slice(0, 5));
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
        setShuffleCards(importedRecs.backlog.slice(0, 5));
        setSelectedId((current) => current ?? importedGames[0]?.id ?? null);
        setNotice(`Steam library import complete: ${result.imported} games added or updated.`);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Steam library import failed.");
      }
    } else if (importAfterLogin) {
      setNotice("Steam sign-in worked. Add STEAM_WEB_API_KEY to Vercel to import your library.");
    }
  }

  function clearFilters() {
    setQuery("");
    setStatus("All");
    setOwnership("All");
    setPriorityFilter("All vibes");
    setPlaytimeFilter("Any playtime");
    setHideCompleted(false);
  }

  function openSteamDialog() {
    setSteamQuery("");
    setSteamResults([]);
    steamDialogRef.current?.showModal();
  }

  function openGameDialog(game?: Game) {
    setEditingId(game?.id ?? null);
    setFormGame(game ? toPayload(game) : { ...blankGame, date_added: new Date().toLocaleDateString("en-GB") });
    gameDialogRef.current?.showModal();
  }

  async function searchSteam(term: string) {
    const payload = await api<{ results: SteamSearchResult[] }>(`/api/steam/search?q=${encodeURIComponent(term)}`);
    setSteamResults(payload.results);
  }

  async function addSteamGame(result: SteamSearchResult) {
    const payload: GamePayload = {
      ...blankGame,
      title: result.name,
      notes: `Added from Steam search. AppID: ${result.appid}`,
      steam_appid: result.appid
    };
    const { game } = await api<{ game: Game }>("/api/games", { method: "POST", body: JSON.stringify(payload) });
    steamDialogRef.current?.close();
    await load();
    setSelectedId(game.id);
  }

  async function saveGame(event: FormEvent) {
    event.preventDefault();
    const path = editingId ? `/api/games/${editingId}` : "/api/games";
    const method = editingId ? "PUT" : "POST";
    const { game } = await api<{ game: Game }>(path, { method, body: JSON.stringify(formGame) });
    gameDialogRef.current?.close();
    await load();
    setSelectedId(game.id);
  }

  async function patchSelected(payload: Partial<GamePayload>) {
    if (!selected) return;
    await api(`/api/games/${selected.id}`, { method: "PATCH", body: JSON.stringify(payload) });
    await load();
    setSelectedId(selected.id);
  }

  async function deleteSelected() {
    if (!selected || !window.confirm(`Delete "${selected.title}"?`)) return;
    await api(`/api/games/${selected.id}`, { method: "DELETE" });
    setSelectedId(null);
    await load();
  }

  async function shuffle() {
    const payload = await api<{ game: Game | null; reason: string }>(
      `/api/shuffle?mood=${encodeURIComponent(mood)}&time=${encodeURIComponent(time)}`
    );
    if (!payload.game) {
      setShuffleCards([]);
      setShuffleMessage(payload.reason);
      return;
    }
    setShuffleCards([payload.game]);
    setShuffleMessage(payload.reason);
    setSelectedId(payload.game.id);
  }

  async function importSteamLibrary() {
    if (!session?.has_steam_key) {
      setNotice("Add STEAM_WEB_API_KEY to Vercel before importing your owned Steam library.");
      return;
    }
    try {
      const result = await api<{ imported: number }>("/api/steam/owned-games", { method: "POST", body: "{}" });
      await load();
      setNotice(`Steam library import complete: ${result.imported} games added or updated.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Steam library import failed.");
    }
  }

  async function logout() {
    await api("/api/logout", { method: "POST", body: "{}" });
    window.location.href = "/login";
  }

  return (
    <div className="app-shell">
      <header className="top-nav">
        <div className="nav-brand">
          <a className="brand-lockup" href="/" aria-label="Vault Shuffle home">
            <img src="/assets/vault-shuffle-icon.png" alt="" />
            <strong>Vault Shuffle</strong>
          </a>
        </div>
        <label className="search-box">
          <span>⌕</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} type="search" placeholder="Search games..." />
        </label>
        <div className="nav-actions">
          <span className="steam-profile">
            {session?.avatar_url ? <img src={session.avatar_url} alt="" /> : <span className="steam-avatar-fallback">S</span>}
            <span>{session?.display_name || "Steam user"}</span>
          </span>
          <button className="ghost" onClick={importSteamLibrary}>
            ⇩ Import Steam Library
          </button>
          <span className="divider" />
          <button className="ghost" onClick={logout}>
            Sign out
          </button>
          <button className="nav-icon" aria-label="Settings">
            ⚙
          </button>
          <button className="nav-icon" aria-label="Theme">
            ☾
          </button>
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

      <div className="workspace">
        <aside className="library-panel">
          <h2>Library Overview</h2>
          <div className="overview-list">
            {statRows(stats).map(([icon, label, value]) => (
              <div className="stat-row" key={label}>
                <span>{icon}</span>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>

          <div className="filter-heading">
            <h2>Filters</h2>
            <button onClick={clearFilters}>Clear all ›</button>
          </div>

          <label className="side-search">
            <span>⌕</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} type="search" placeholder="Filter games..." />
          </label>

          <label>
            Status
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option>All</option>
              <option>Completed</option>
              <option>In Progress</option>
              <option>Not Started</option>
            </select>
          </label>

          <label>
            Ownership
            <select value={ownership} onChange={(event) => setOwnership(event.target.value)}>
              <option>All</option>
              <option>Owned</option>
              <option>Wishlist</option>
              <option>Game pass</option>
            </select>
          </label>

          <label>
            Vibe
            <select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)}>
              <option>All vibes</option>
              <option>High</option>
              <option>Medium</option>
              <option>Low</option>
            </select>
          </label>

          <label>
            Time Commitment
            <select value={playtimeFilter} onChange={(event) => setPlaytimeFilter(event.target.value)}>
              <option>Any playtime</option>
              <option>Short</option>
              <option>Medium</option>
              <option>Long</option>
            </select>
          </label>

          <label className="filter-switch">
            <input checked={hideCompleted} onChange={(event) => setHideCompleted(event.target.checked)} type="checkbox" />
            <span className="switch-visual" aria-hidden="true" />
            <span>Hide completed</span>
          </label>
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
                <option>Quick 30-60m</option>
                <option>Evening 1-3h</option>
                <option>Weekend project</option>
              </select>
              <button className="shuffle-button" onClick={shuffle}>
                Shuffle
              </button>
            </div>
            <div className="shuffle-cards">
              {shuffleCards.length ? (
                shuffleCards.map((game) => <RecommendationTile game={game} key={game.id} onClick={() => setSelectedId(game.id)} />)
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

          <section className="library-table">
            <div className="table-toolbar">
              <strong>{filteredGames.length} {filteredGames.length === 1 ? "game" : "games"}</strong>
              <div className="toolbar-controls">
                <select aria-label="Filter by status" value={status} onChange={(event) => setStatus(event.target.value)}>
                  <option value="All">All statuses</option>
                  <option value="Completed">Completed</option>
                  <option value="In Progress">In Progress</option>
                  <option value="Not Started">Not Started</option>
                </select>
                <select aria-label="Filter by ownership" value={ownership} onChange={(event) => setOwnership(event.target.value)}>
                  <option value="All">All ownership</option>
                  <option value="Owned">Owned</option>
                  <option value="Wishlist">Wishlist</option>
                  <option value="Game pass">Game pass</option>
                </select>
                <select aria-label="Filter by playtime" value={playtimeFilter} onChange={(event) => setPlaytimeFilter(event.target.value)}>
                  <option>Any playtime</option>
                  <option>Short</option>
                  <option>Medium</option>
                  <option>Long</option>
                </select>
                <select aria-label="Filter by vibe" value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)}>
                  <option>All vibes</option>
                  <option>High</option>
                  <option>Medium</option>
                  <option>Low</option>
                </select>
                <label className="toolbar-switch">
                  <input checked={hideCompleted} onChange={(event) => setHideCompleted(event.target.checked)} type="checkbox" />
                  <span className="switch-visual" aria-hidden="true" />
                  <span>Hide completed</span>
                </label>
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
                <button className="clear-chip" onClick={clearFilters} type="button">Clear</button>
                <button className="view-button active">☷</button>
                <button className="view-button">▦</button>
              </div>
            </div>

            <div className="table-head">
              <span>□</span>
              <span>Game</span>
              <span>Status</span>
              <span>Playtime</span>
              <span>Progress</span>
              <span>Vibe</span>
              <span>Time</span>
              <span>Last Played</span>
              <span>⚙</span>
            </div>
            <div className="table-body">
              {filteredGames.map((game) => (
                <GameRow game={game} key={game.id} selected={game.id === selectedId} onSelect={() => setSelectedId(game.id)} />
              ))}
            </div>
          </section>
        </main>

        <aside className="details-panel">
          <div className="details-header">
            <h2>Game Details</h2>
            <button className="nav-icon">×</button>
          </div>
          <GameDetails game={selected} />
          <div className="quick-actions">
            <button disabled={!selected} onClick={() => selected && openGameDialog(selected)}>
              Edit
            </button>
            <button disabled={!selected} onClick={() => patchSelected({ status: "In Progress" })}>
              Start Playing
            </button>
            <button disabled={!selected} onClick={() => patchSelected({ status: "Completed" })}>
              Mark Completed
            </button>
            <button disabled={!selected} className="remove" onClick={deleteSelected}>
              Remove from Backlog
            </button>
          </div>
          <section className="recommendation-card">
            <h2>Recommendations</h2>
            <div id="recommendations">
              {[
                ["Top Backlog", recs.backlog],
                ["Top Wishlist", recs.wishlist],
                ["Random Pick", recs.random ? [recs.random] : []]
              ].map(([title, items]) => (
                <div className="rec" key={String(title)}>
                  <strong>{String(title)}</strong>
                  {(items as Game[]).length ? (
                    (items as Game[]).slice(0, 2).map((game) => (
                      <button className="rec-row" key={game.id} onClick={() => setSelectedId(game.id)} type="button">
                        <Cover game={game} />
                        <span>{game.title}</span>
                      </button>
                    ))
                  ) : (
                    <span>No games found.</span>
                  )}
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>

      <button className="floating-add" onClick={openSteamDialog} aria-label="Search Steam for a game">
        ＋
      </button>

      <SteamDialog
        dialogRef={steamDialogRef}
        query={steamQuery}
        results={steamResults}
        onQuery={setSteamQuery}
        onAdd={addSteamGame}
        onManual={() => {
          steamDialogRef.current?.close();
          openGameDialog();
        }}
      />

      <GameDialog
        dialogRef={gameDialogRef}
        game={formGame}
        editing={Boolean(editingId)}
        onChange={setFormGame}
        onSubmit={saveGame}
      />
    </div>
  );
}

function GameRow({ game, selected, onSelect }: { game: Game; selected: boolean; onSelect: () => void }) {
  const progress = clamp(Number(game.completion_percentage || 0), 0, 100);
  return (
    <div className={`game-row ${selected ? "selected" : ""}`} role="button" tabIndex={0} onClick={onSelect} onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && onSelect()}>
      <span className="select-box">{selected ? "✓" : ""}</span>
      <span className="game-cell">
        <Cover game={game} />
        <span className="game-title">
          <strong>{game.title}</strong>
          <small>{game.genre || "Unknown"}</small>
        </span>
      </span>
      <span className={`chip ${statusClass(game)}`}>{statusIcon(game)} {game.status}</span>
      <span>{Number(game.hours_played).toLocaleString()}h</span>
      <span className="progress-cell">
        <span className="progress-track">
          <span className="progress-fill" style={{ width: `${progress}%` }} />
        </span>
        {progress ? `${progress}%` : "—"}
      </span>
      <span className="pill">
        <i className={`dot ${priorityClass(game.priority)}`} />
        {game.priority}
      </span>
      <span className="pill">{timeBucket(game)}</span>
      <span>{formatLastPlayed(game.last_played_at)}</span>
      <span>⋮</span>
    </div>
  );
}

function GameDetails({ game }: { game: Game | null }) {
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
        <DetailLine label="Rating" value={`${game.rating}/10`} />
        <DetailLine
          label="Store"
          value={game.steam_appid ? <a href={`https://store.steampowered.com/app/${game.steam_appid}/`} target="_blank" rel="noreferrer">Open on Steam</a> : game.store}
        />
        {game.steam_appid ? <DetailLine label="Steam AppID" value={game.steam_appid} /> : null}
      </div>
      <section className="notes">
        <strong>Notes</strong>
        <p>{game.notes || "No notes yet."}</p>
      </section>
    </div>
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

function SteamDialog({
  dialogRef,
  query,
  results,
  onQuery,
  onAdd,
  onManual
}: {
  dialogRef: React.RefObject<HTMLDialogElement | null>;
  query: string;
  results: SteamSearchResult[];
  onQuery: (value: string) => void;
  onAdd: (result: SteamSearchResult) => void;
  onManual: () => void;
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
                  <small>Steam AppID {result.appid}</small>
                </span>
                <b>Add</b>
              </button>
            ))}
          </div>
        </div>
        <footer>
          <button type="button" onClick={onManual}>Manual entry</button>
          <button type="button" onClick={() => dialogRef.current?.close()}>Cancel</button>
        </footer>
      </form>
    </dialog>
  );
}

function GameDialog({
  dialogRef,
  game,
  editing,
  onChange,
  onSubmit
}: {
  dialogRef: React.RefObject<HTMLDialogElement | null>;
  game: GamePayload;
  editing: boolean;
  onChange: (game: GamePayload) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  function update<K extends keyof GamePayload>(key: K, value: GamePayload[K]) {
    onChange({ ...game, [key]: value });
  }

  return (
    <dialog ref={dialogRef}>
      <form onSubmit={onSubmit}>
        <header>
          <h2>{editing ? "Edit Game" : "Add Game"}</h2>
          <button type="button" className="nav-icon" onClick={() => dialogRef.current?.close()}>×</button>
        </header>
        <div className="form-grid">
          <label>Title<input value={game.title} onChange={(event) => update("title", event.target.value)} required /></label>
          <label>Genre<input value={game.genre} onChange={(event) => update("genre", event.target.value)} /></label>
          <label>Store<input value={game.store} onChange={(event) => update("store", event.target.value)} /></label>
          <label>Ownership<select value={game.ownership} onChange={(event) => update("ownership", event.target.value as GamePayload["ownership"])}><option>Owned</option><option>Wishlist</option><option>Game pass</option></select></label>
          <label>Status<select value={game.status} onChange={(event) => update("status", event.target.value as GamePayload["status"])}><option>Not Started</option><option>In Progress</option><option>Completed</option></select></label>
          <label>Priority<select value={game.priority} onChange={(event) => update("priority", event.target.value as GamePayload["priority"])}><option>Low</option><option>Medium</option><option>High</option></select></label>
          <label>Rating<input value={game.rating} onChange={(event) => update("rating", Number(event.target.value))} type="number" min="0" max="10" step="1" /></label>
          <label>Hours<input value={game.hours_played} onChange={(event) => update("hours_played", Number(event.target.value))} type="number" min="0" step="0.1" /></label>
          <label>Completion<input value={game.completion_percentage} onChange={(event) => update("completion_percentage", Number(event.target.value))} type="number" min="0" max="100" step="1" /></label>
          <label>Date Added<input value={game.date_added ?? ""} onChange={(event) => update("date_added", event.target.value)} /></label>
          <label>Last Played<input value={game.last_played_at ?? ""} onChange={(event) => update("last_played_at", event.target.value)} /></label>
          <label>Steam AppID<input value={game.steam_appid ?? ""} onChange={(event) => update("steam_appid", event.target.value)} /></label>
          <label className="wide">Notes<textarea value={game.notes} onChange={(event) => update("notes", event.target.value)} /></label>
        </div>
        <footer>
          <button type="button" onClick={() => dialogRef.current?.close()}>Cancel</button>
          <button className="shuffle-button">Save</button>
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

function toPayload(game: Game): GamePayload {
  return {
    title: game.title,
    genre: game.genre,
    store: game.store,
    ownership: game.ownership,
    status: game.status,
    rating: game.rating,
    hours_played: game.hours_played,
    completion_percentage: game.completion_percentage,
    priority: game.priority,
    date_added: game.date_added,
    last_played_at: game.last_played_at,
    notes: game.notes,
    steam_appid: game.steam_appid
  };
}

function statRows(stats: StatsPayload) {
  const total = stats.total || 1;
  return [
    ["▦", "Total Games", stats.total],
    ["✓", "Completed", `${stats.completed} (${Math.round((stats.completed / total) * 100)}%)`],
    ["▣", "In Progress", `${stats.in_progress} (${Math.round((stats.in_progress / total) * 100)}%)`],
    ["□", "Not Started", `${total - stats.completed - stats.in_progress} (${Math.round(((total - stats.completed - stats.in_progress) / total) * 100)}%)`],
    ["♡", "Wishlist", stats.wishlist],
    ["◴", "Hours Played (All)", Number(stats.hours).toLocaleString()],
    ["◎", "Completion Rate", `${stats.avg_completion}%`]
  ] as const;
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
  if (hours >= 50) return "Long";
  if (hours >= 10) return "Medium";
  return "Short";
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
