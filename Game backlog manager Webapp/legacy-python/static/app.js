const state = {
  games: [],
  selectedId: null,
  editingId: null,
  session: null,
  steamResults: [],
  steamSearchTimer: null,
};

const els = {
  rows: document.querySelector("#gameRows"),
  stats: document.querySelector("#statsGrid"),
  detail: document.querySelector("#detailContent"),
  recs: document.querySelector("#recommendations"),
  search: document.querySelector("#searchInput"),
  sideSearch: document.querySelector("#sideSearchMirror"),
  status: document.querySelector("#statusFilter"),
  ownership: document.querySelector("#ownershipFilter"),
  hideCompleted: document.querySelector("#hideCompletedFilter"),
  visibleCount: document.querySelector("#visibleCount"),
  sort: document.querySelector("#sortSelect"),
  mood: document.querySelector("#moodSelect"),
  time: document.querySelector("#timeSelect"),
  shuffleResult: document.querySelector("#shuffleResult"),
  dialog: document.querySelector("#gameDialog"),
  form: document.querySelector("#gameForm"),
  dialogTitle: document.querySelector("#dialogTitle"),
  steamDialog: document.querySelector("#steamDialog"),
  steamSearch: document.querySelector("#steamSearchInput"),
  steamResults: document.querySelector("#steamResults"),
  steamStatus: document.querySelector("#steamStatus"),
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (response.status === 401) {
    window.location.href = "/login.html";
    return {};
  }
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed.");
  return payload;
}

async function load() {
  state.session = await api("/api/session");
  if (!state.session?.logged_in) {
    window.location.href = "/login.html";
    return;
  }
  const [{ games }, stats, recs] = await Promise.all([
    api("/api/games"),
    api("/api/stats"),
    api("/api/recommendations"),
  ]);
  state.games = games;
  if (state.selectedId == null && games.length) state.selectedId = games[0].id;
  setText(els.steamStatus, `Steam ${state.session.steam_id.slice(-6)}`);
  renderStats(stats);
  renderRecommendations(recs);
  renderShuffleSeed(recs);
  renderRows();
  renderDetails();
}

function filteredGames() {
  const query = (els.search?.value || "").trim().toLowerCase();
  const status = els.status?.value || "All";
  const ownership = els.ownership?.value || "All";
  const sort = els.sort?.value || "hours_desc";
  const hideCompleted = Boolean(els.hideCompleted?.checked);
  const priorityScore = { High: 3, Medium: 2, Low: 1 };
  const statusScore = { "In Progress": 1, "Not Started": 2, Completed: 3 };
  const games = state.games.filter((game) => {
    const text = `${game.title} ${game.genre} ${game.store} ${game.status} ${game.priority} ${game.notes} ${game.steam_appid}`.toLowerCase();
    return (!query || text.includes(query))
      && (status === "All" || game.status === status)
      && (ownership === "All" || game.ownership === ownership)
      && (!hideCompleted || game.status !== "Completed");
  });
  return games.sort((a, b) => {
    if (sort === "title_asc") return a.title.localeCompare(b.title);
    if (sort === "status_asc") return (statusScore[a.status] || 9) - (statusScore[b.status] || 9);
    if (sort === "priority_desc") return (priorityScore[b.priority] || 0) - (priorityScore[a.priority] || 0);
    return Number(b.hours_played || 0) - Number(a.hours_played || 0);
  });
}

function renderStats(stats) {
  const total = stats.total || 1;
  const items = [
    ["▦", "Total Games", stats.total],
    ["✓", "Completed", `${stats.completed} (${Math.round((stats.completed / total) * 100)}%)`],
    ["▣", "In Progress", `${stats.in_progress} (${Math.round((stats.in_progress / total) * 100)}%)`],
    ["□", "Not Started", `${total - stats.completed - stats.in_progress} (${Math.round(((total - stats.completed - stats.in_progress) / total) * 100)}%)`],
    ["♡", "Wishlist", stats.wishlist],
    ["◴", "Hours Played (All)", Number(stats.hours).toLocaleString()],
    ["◎", "Completion Rate", `${stats.avg_completion}%`],
  ];
  if (!els.stats) return;
  els.stats.innerHTML = items.map(([icon, label, value]) => `
    <div class="stat-row"><span>${icon}</span><span>${label}</span><strong>${value}</strong></div>
  `).join("");
}

function renderRows() {
  const games = filteredGames();
  setText(els.visibleCount, `${games.length} ${games.length === 1 ? "game" : "games"}`);
  if (!els.rows) return;
  els.rows.replaceChildren(...games.map((game) => {
    const progress = clamp(Number(game.completion_percentage || 0), 0, 100);
    const row = document.createElement("div");
    row.className = `game-row ${game.id === state.selectedId ? "selected" : ""}`;
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.innerHTML = `
      <span class="select-box">${game.id === state.selectedId ? "✓" : ""}</span>
      <span class="game-cell">
        ${cover(game)}
        <span class="game-title"><strong>${escapeHtml(game.title)}</strong><small>${escapeHtml(game.genre || "Unknown")}</small></span>
      </span>
      <span class="chip ${statusClass(game)}">${statusIcon(game)} ${escapeHtml(game.status)}</span>
      <span>${Number(game.hours_played).toLocaleString()}h</span>
      <span class="progress-cell"><span class="progress-track"><span class="progress-fill" style="width:${progress}%"></span></span>${progress ? `${progress}%` : "—"}</span>
      <span class="pill"><i class="dot ${priorityClass(game.priority)}"></i>${escapeHtml(game.priority)}</span>
      <span class="pill">${timeBucket(game)}</span>
      <span>${lastPlayed(game)}</span>
      <span>⋮</span>
    `;
    row.addEventListener("click", () => selectGame(game.id));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") selectGame(game.id);
    });
    return row;
  }));
}

function renderShuffleSeed(recs) {
  const cards = [...(recs.backlog || [])].slice(0, 5);
  if (!els.shuffleResult) return;
  if (!cards.length) {
    els.shuffleResult.innerHTML = `<div class="rec-tile">${cover({ title: "No pick" })}<div><span>No pick yet</span><p>Choose a vibe and roll an unfinished owned game.</p></div></div>`;
    return;
  }
  els.shuffleResult.innerHTML = cards.map((game) => `
    <div class="rec-tile" data-id="${game.id}">
      ${cover(game)}
      <div><span>${escapeHtml(game.title)}</span><p>~${Number(game.hours_played).toLocaleString()}h · ${escapeHtml(game.priority)}</p></div>
    </div>
  `).join("");
  els.shuffleResult.querySelectorAll(".rec-tile").forEach((tile) => {
    tile.addEventListener("click", () => selectGame(Number(tile.dataset.id)));
  });
}

function renderDetails() {
  const game = selectedGame();
  if (!els.detail) return;
  if (!game) {
    els.detail.className = "detail-content empty";
    els.detail.textContent = "Select a game from the library.";
    return;
  }
  const progress = clamp(Number(game.completion_percentage || 0), 0, 100);
  els.detail.className = "detail-content";
  els.detail.innerHTML = `
    <div class="hero-cover">${steamImage(game, "header")}</div>
    <p class="detail-kicker">Now selected</p>
    <div class="detail-title">${escapeHtml(game.title)}</div>
    <div class="detail-subtitle">${escapeHtml(game.genre || "Unknown")} · ${escapeHtml(game.store || "Steam")}</div>
    <div class="detail-pills">
      ${detailPill(statusIcon(game), game.status)}
      ${detailPill("◴", timeBucket(game))}
      ${detailPill("◎", game.priority)}
    </div>
    <div class="detail-progress">
      <div><span>Progress</span><strong>${progress}%</strong></div>
      <span class="progress-track"><span class="progress-fill" style="width:${progress}%"></span></span>
    </div>
    <div class="detail-list">
      ${detailLine("Playtime", `${Number(game.hours_played).toLocaleString()}h`)}
      ${detailLine("Rating", `${game.rating}/10`)}
      ${detailLine("Store", game.steam_appid ? `<a href="https://store.steampowered.com/app/${encodeURIComponent(game.steam_appid)}/" target="_blank" rel="noreferrer">Open on Steam</a>` : escapeHtml(game.store || "Steam"))}
      ${game.steam_appid ? detailLine("Steam AppID", escapeHtml(game.steam_appid)) : ""}
    </div>
    <section class="notes"><strong>Notes</strong><p>${escapeHtml(game.notes || "No notes yet.")}</p></section>
`;
}

function renderRecommendations(recs) {
  const groups = [
    ["Top Backlog", recs.backlog],
    ["Top Wishlist", recs.wishlist],
    ["Random Pick", recs.random ? [recs.random] : []],
  ];
  if (!els.recs) return;
  els.recs.innerHTML = groups.map(([title, games]) => `
    <div class="rec">
      <strong>${title}</strong>
      ${games.length ? games.slice(0, 2).map((game) => `
        <button type="button" class="rec-row" data-id="${game.id}">
          ${cover(game)}
          <span>${escapeHtml(game.title)}</span>
        </button>
      `).join("") : "<span>No games found.</span>"}
    </div>
  `).join("");
  els.recs.querySelectorAll(".rec-row").forEach((row) => {
    row.addEventListener("click", () => selectGame(Number(row.dataset.id)));
  });
}

function detailPill(icon, value) {
  return `<span class="detail-pill"><i>${escapeHtml(icon)}</i>${escapeHtml(String(value ?? ""))}</span>`;
}

function detailLine(label, value) {
  return `<div class="detail-line"><span>${escapeHtml(label)}</span><strong>${value}</strong></div>`;
}

function cover(game) {
  return `<span class="cover">${steamImage(game, "capsule")}</span>`;
}

function steamImage(game, type = "capsule") {
  const appId = String(game?.steam_appid || "").replace(/\D/g, "");
  if (!appId) return "";
  const file = type === "header" ? "header.jpg" : "capsule_184x69.jpg";
  const src = `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/${file}`;
  return `<img src="${src}" alt="" loading="lazy" onerror="this.remove()">`;
}

function initials(title) {
  const words = String(title || "").replace(/[^a-zA-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase() || "SB";
}

function selectGame(id) {
  state.selectedId = id;
  renderRows();
  renderDetails();
}

function selectedGame() {
  return state.games.find((game) => game.id === state.selectedId);
}

function statusClass(game) {
  if (game.ownership === "Wishlist") return "wishlist";
  if (game.status === "Completed") return "completed";
  if (game.status === "In Progress") return "progress";
  return "";
}

function statusIcon(game) {
  if (game.status === "In Progress") return "▶";
  if (game.status === "Completed") return "✓";
  return "↬";
}

function priorityClass(priority) {
  if (priority === "High") return "high";
  if (priority === "Low") return "low";
  return "";
}

function timeBucket(game) {
  const hours = Number(game.hours_played || 0);
  if (hours >= 50) return "Long";
  if (hours >= 10) return "Medium";
  return "Short";
}

function lastPlayed(game) {
  return game.status === "In Progress" ? game.date_added || "—" : "—";
}

function openDialog(game = null) {
  state.editingId = game?.id ?? null;
  setText(els.dialogTitle, game ? "Edit Game" : "Add Game");
  if (!els.form || !els.dialog) return;
  els.form.reset();
  const fields = new FormData(els.form);
  for (const key of fields.keys()) {
    if (game && key in game) els.form.elements[key].value = game[key] ?? "";
  }
  if (!game) {
    els.form.elements.store.value = "Steam";
    els.form.elements.ownership.value = "Owned";
    els.form.elements.status.value = "Not Started";
    els.form.elements.priority.value = "Medium";
    els.form.elements.rating.value = 0;
    els.form.elements.hours_played.value = 0;
    els.form.elements.completion_percentage.value = 0;
    els.form.elements.date_added.value = new Date().toLocaleDateString("en-GB");
  }
  els.dialog.showModal();
}

function openSteamDialog() {
  if (!els.steamDialog) return;
  state.steamResults = [];
  if (els.steamSearch) els.steamSearch.value = "";
  if (els.steamResults) els.steamResults.innerHTML = `<p class="steam-hint">Type a game name to search Steam.</p>`;
  els.steamDialog.showModal();
  window.setTimeout(() => els.steamSearch?.focus(), 80);
}

async function searchSteam() {
  const query = (els.steamSearch?.value || "").trim();
  if (!els.steamResults) return;
  if (query.length < 2) {
    state.steamResults = [];
    els.steamResults.innerHTML = `<p class="steam-hint">Type at least two characters to search Steam.</p>`;
    return;
  }
  els.steamResults.innerHTML = `<p class="steam-hint">Searching Steam...</p>`;
  try {
    const payload = await api(`/api/steam/search?q=${encodeURIComponent(query)}`);
    state.steamResults = payload.results || [];
    renderSteamResults();
  } catch (error) {
    els.steamResults.innerHTML = `<p class="steam-hint">${escapeHtml(error.message)}</p>`;
  }
}

function renderSteamResults() {
  if (!els.steamResults) return;
  if (!state.steamResults.length) {
    els.steamResults.innerHTML = `<p class="steam-hint">No Steam games found for that search.</p>`;
    return;
  }
  els.steamResults.replaceChildren(...state.steamResults.map((game) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "steam-result";
    row.dataset.appid = game.appid;
    row.innerHTML = `
      <span class="steam-result-art">${game.image ? `<img src="${escapeHtml(game.image)}" alt="">` : ""}</span>
      <span><strong>${escapeHtml(game.name)}</strong><small>Steam AppID ${escapeHtml(game.appid)}</small></span>
      <b>Add</b>
    `;
    row.addEventListener("click", () => addSteamGame(game.appid));
    return row;
  }));
}

async function addSteamGame(appid) {
  const result = state.steamResults.find((game) => game.appid === String(appid));
  if (!result) return;
  const payload = {
    title: result.name,
    genre: "Unknown",
    store: "Steam",
    ownership: "Owned",
    status: "Not Started",
    rating: 0,
    hours_played: 0,
    completion_percentage: 0,
    priority: "Medium",
    date_added: new Date().toLocaleDateString("en-GB"),
    notes: `Added from Steam search. AppID: ${result.appid}`,
    steam_appid: result.appid,
  };
  const { game } = await api("/api/games", { method: "POST", body: JSON.stringify(payload) });
  els.steamDialog?.close();
  await load();
  if (game?.id) selectGame(game.id);
}

async function saveForm(event) {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(els.form).entries());
  const id = state.editingId;
  if (id == null) {
    await api("/api/games", { method: "POST", body: JSON.stringify(payload) });
  } else {
    await api(`/api/games/${id}`, { method: "PUT", body: JSON.stringify(payload) });
  }
  if (els.dialog) els.dialog.close();
  await load();
}

async function patchSelected(payload) {
  const game = selectedGame();
  if (!game) return;
  await api(`/api/games/${game.id}`, { method: "PATCH", body: JSON.stringify(payload) });
  await load();
  state.selectedId = game.id;
  renderRows();
  renderDetails();
}

async function deleteSelected() {
  const game = selectedGame();
  if (!game || !confirm(`Delete "${game.title}"?`)) return;
  await api(`/api/games/${game.id}`, { method: "DELETE" });
  state.selectedId = null;
  await load();
}

async function importSteamLibrary() {
  let session = state.session || await api("/api/session");
  if (!session.has_steam_key) {
    const apiKey = window.prompt("Paste your Steam Web API key. It will be stored in the local Vault Shuffle database on this Mac.");
    if (!apiKey) return;
    await api("/api/settings/steam-key", { method: "POST", body: JSON.stringify({ api_key: apiKey }) });
    session = await api("/api/session");
    state.session = session;
  }
  const result = await api("/api/steam/owned-games");
  await load();
  window.alert(`Steam library import complete: ${result.imported} games added or updated.`);
}

async function logout() {
  await api("/api/logout", { method: "POST", body: "{}" });
  window.location.href = "/login.html";
}

async function shuffle() {
  const payload = await api(`/api/shuffle?mood=${encodeURIComponent(els.mood?.value || "Any vibe")}&time=${encodeURIComponent(els.time?.value || "Any time")}`);
  if (!els.shuffleResult) return;
  if (!payload.game) {
    els.shuffleResult.innerHTML = `<div class="rec-tile">${cover({ title: "None" })}<div><span>No pick found</span><p>${escapeHtml(payload.reason)}</p></div></div>`;
    return;
  }
  els.shuffleResult.innerHTML = `<div class="rec-tile" data-id="${payload.game.id}">${cover(payload.game)}<div><span>${escapeHtml(payload.game.title)}</span><p>${escapeHtml(payload.reason)}</p></div></div>`;
  selectGame(payload.game.id);
}

function syncSearch(value) {
  if (els.search) els.search.value = value;
  if (els.sideSearch) els.sideSearch.value = value;
  renderRows();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[char]));
}

function setText(element, value) {
  if (element) element.textContent = value;
}

function on(selector, event, handler) {
  const element = document.querySelector(selector);
  if (element) element.addEventListener(event, handler);
}

on("#addButton", "click", openSteamDialog);
on("#clearFilters", "click", () => {
  syncSearch("");
  if (els.status) els.status.value = "All";
  if (els.ownership) els.ownership.value = "All";
  if (els.hideCompleted) els.hideCompleted.checked = false;
  renderRows();
});
on("#shuffleButton", "click", shuffle);
on("#editButton", "click", () => selectedGame() && openDialog(selectedGame()));
on("#startButton", "click", () => patchSelected({ status: "In Progress" }));
on("#completeButton", "click", () => patchSelected({ status: "Completed" }));
on("#deleteButton", "click", deleteSelected);
on("#importSteamButton", "click", importSteamLibrary);
on("#logoutButton", "click", logout);
on("#closeDialog", "click", () => els.dialog?.close());
on("#cancelDialog", "click", () => els.dialog?.close());
on("#closeSteamDialog", "click", () => els.steamDialog?.close());
on("#cancelSteamDialog", "click", () => els.steamDialog?.close());
on("#manualAddButton", "click", () => {
  els.steamDialog?.close();
  openDialog();
});
if (els.form) els.form.addEventListener("submit", saveForm);
if (els.search) els.search.addEventListener("input", () => syncSearch(els.search.value));
if (els.sideSearch) els.sideSearch.addEventListener("input", () => syncSearch(els.sideSearch.value));
if (els.status) els.status.addEventListener("change", renderRows);
if (els.ownership) els.ownership.addEventListener("change", renderRows);
if (els.hideCompleted) els.hideCompleted.addEventListener("change", renderRows);
if (els.sort) els.sort.addEventListener("change", renderRows);
if (els.steamSearch) els.steamSearch.addEventListener("input", () => {
  window.clearTimeout(state.steamSearchTimer);
  state.steamSearchTimer = window.setTimeout(searchSteam, 260);
});

load().catch((error) => {
  console.error(error);
  document.body.innerHTML = `<main class="fatal"><h1>Could not load backlog</h1><p>${escapeHtml(error.message)}</p></main>`;
});
