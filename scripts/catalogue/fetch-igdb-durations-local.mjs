import { createInterface } from "node:readline";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const manifestPath = path.resolve(stringArgument("--manifest") ?? "data/catalogue/popular-appids-merged-2026-08-20.json");
const popularityCacheDir = path.resolve(stringArgument("--popularity-cache") ?? "data/catalogue/.cache/igdb-popularity-2026-08-20");
const cacheDir = path.resolve(stringArgument("--cache-dir") ?? "data/catalogue/.cache/igdb-durations-local-2026-08-20");
const outputPath = path.resolve(stringArgument("--output") ?? "data/catalogue/igdb-durations-local-2026-08-20.json");
let clientId = process.env.IGDB_CLIENT_ID;
let clientSecret = process.env.IGDB_CLIENT_SECRET;
if ((!clientId || !clientSecret) && process.argv.includes("--credentials-stdin")) {
  console.log(JSON.stringify({ stage: "igdb_credentials_waiting", transport: "stdin_memory_only" }));
  [clientId, clientSecret] = await readCredentialsFromStdin();
}
if (!clientId || !clientSecret) throw new Error("IGDB credentials must be injected or supplied with --credentials-stdin.");

async function main() {
await mkdir(cacheDir, { recursive: true });
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const games = manifest.games.map((game) => ({ steam_appid: positiveInteger(game.steam_appid), name: cleanText(game.name) }))
  .filter((game) => game.steam_appid && game.name);
const mappings = await loadPopularityMappings(popularityCacheDir);
const igdb = new IgdbClient(clientId, clientSecret, cacheDir);

const missingAppIds = games.map((game) => game.steam_appid).filter((appid) => !mappings.has(appid));
console.log(JSON.stringify({ stage: "igdb_duration_mapping_start", games: games.length, cached_mappings: games.length - missingAppIds.length, missing_mappings: missingAppIds.length }));
for (let index = 0; index < missingAppIds.length; index += 100) {
  const batch = missingAppIds.slice(index, index + 100);
  const quotedIds = batch.map((appid) => `"${appid}"`).join(",");
  const rows = await igdb.query(
    "external_games",
    `fields game,uid,external_game_source; where external_game_source = 1 & uid = (${quotedIds}); limit 500;`,
    `steam-mapping-${String(index).padStart(6, "0")}`
  );
  addMappings(mappings, rows);
  console.log(JSON.stringify({ stage: "igdb_duration_mapping_progress", processed: Math.min(index + batch.length, missingAppIds.length), total: missingAppIds.length }));
}

const directGameIds = [...new Set(games.flatMap((game) => [...(mappings.get(game.steam_appid) ?? [])]))].sort((a, b) => a - b);
const directDurations = await fetchTimeToBeats(igdb, directGameIds, "direct-duration");
const gamesWithoutDirectDuration = directGameIds.filter((gameId) => !hasUsableDuration(directDurations.get(gameId)));
const parentByGame = await fetchVersionParents(igdb, gamesWithoutDirectDuration);
const parentIds = [...new Set(parentByGame.values())].sort((a, b) => a - b);
const parentDurations = await fetchTimeToBeats(igdb, parentIds, "parent-duration");

const results = games.map((game) => durationResult(game, mappings, directDurations, parentByGame, parentDurations));
const counts = results.reduce((summary, row) => ({ ...summary, [row.status]: (summary[row.status] ?? 0) + 1 }), {});
const output = {
  schema_version: 1,
  captured_at: new Date().toISOString(),
  source_manifest: manifestPath,
  source_rows: games.length,
  exact_mapping_game_ids: directGameIds.length,
  parent_game_ids: parentIds.length,
  counts,
  results
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ stage: "igdb_duration_complete", output_path: outputPath, rows: results.length, counts }));
}

async function loadPopularityMappings(directory) {
  const mapping = new Map();
  const files = (await readdir(directory)).filter((file) => /^mapping-.*\.json$/.test(file)).sort();
  for (const file of files) addMappings(mapping, JSON.parse(await readFile(path.join(directory, file), "utf8")));
  return mapping;
}

function addMappings(mapping, rows) {
  for (const row of rows) {
    const appid = positiveInteger(row.uid);
    const gameId = positiveInteger(row.game);
    if (!appid || !gameId) continue;
    const ids = mapping.get(appid) ?? new Set();
    ids.add(gameId);
    mapping.set(appid, ids);
  }
}

async function fetchTimeToBeats(client, gameIds, prefix) {
  const byGame = new Map();
  for (let index = 0; index < gameIds.length; index += 400) {
    const batch = gameIds.slice(index, index + 400);
    const rows = await client.query(
      "game_time_to_beats",
      `fields game_id,hastily,normally,completely,count,updated_at; where game_id = (${batch.join(",")}); limit 500;`,
      `${prefix}-${String(index).padStart(6, "0")}`
    );
    for (const row of rows) {
      const gameId = positiveInteger(row.game_id);
      if (!gameId) continue;
      const values = byGame.get(gameId) ?? [];
      values.push(row);
      byGame.set(gameId, values);
    }
    console.log(JSON.stringify({ stage: "igdb_duration_rows_progress", source: prefix, processed: Math.min(index + batch.length, gameIds.length), total: gameIds.length, returned: [...byGame.values()].reduce((sum, values) => sum + values.length, 0) }));
  }
  return byGame;
}

async function fetchVersionParents(client, gameIds) {
  const parents = new Map();
  for (let index = 0; index < gameIds.length; index += 400) {
    const batch = gameIds.slice(index, index + 400);
    const rows = await client.query(
      "games",
      `fields id,version_parent; where id = (${batch.join(",")}); limit 500;`,
      `version-parent-${String(index).padStart(6, "0")}`
    );
    for (const row of rows) {
      const gameId = positiveInteger(row.id);
      const parentId = positiveInteger(row.version_parent);
      if (gameId && parentId) parents.set(gameId, parentId);
    }
  }
  return parents;
}

function durationResult(game, mapping, direct, parents, parentRows) {
  const gameIds = [...(mapping.get(game.steam_appid) ?? [])];
  if (!gameIds.length) return emptyResult(game, "not_found");
  if (gameIds.length !== 1) return emptyResult(game, "ambiguous");
  const gameId = gameIds[0];
  const directRows = direct.get(gameId) ?? [];
  if (directRows.length > 1) return emptyResult(game, "ambiguous", "igdb", gameId);
  if (hasUsableDuration(directRows)) return matchedResult(game, "igdb", gameId, directRows[0]);
  const parentId = parents.get(gameId);
  const parentsForGame = parentId ? parentRows.get(parentId) ?? [] : [];
  if (parentsForGame.length > 1) return emptyResult(game, "ambiguous", "igdb-parent", parentId);
  if (hasUsableDuration(parentsForGame)) return matchedResult(game, "igdb-parent", parentId, parentsForGame[0]);
  const sourceRow = directRows[0];
  return {
    ...emptyResult(game, "no_duration", "igdb", gameId),
    submission_count: validCount(sourceRow?.count),
    provider_updated_at: validTimestamp(sourceRow?.updated_at)
  };
}

function matchedResult(game, provider, providerGameId, row) {
  const submissionCount = validCount(row.count);
  return {
    steam_appid: game.steam_appid,
    name: game.name,
    provider,
    provider_game_id: providerGameId,
    main_story_minutes: secondsToMinutes(row.hastily),
    main_extra_minutes: secondsToMinutes(row.normally),
    completionist_minutes: secondsToMinutes(row.completely),
    submission_count: submissionCount,
    provider_updated_at: validTimestamp(row.updated_at),
    status: "matched",
    confidence: submissionCount == null ? "low" : submissionCount >= 25 ? "high" : submissionCount >= 5 ? "medium" : "low"
  };
}

function emptyResult(game, status, provider = "igdb", providerGameId = null) {
  return {
    steam_appid: game.steam_appid,
    name: game.name,
    provider,
    provider_game_id: providerGameId,
    main_story_minutes: null,
    main_extra_minutes: null,
    completionist_minutes: null,
    submission_count: null,
    provider_updated_at: null,
    status,
    confidence: "none"
  };
}

function hasUsableDuration(rows) {
  return Array.isArray(rows) && rows.length === 1 && [rows[0].hastily, rows[0].normally, rows[0].completely].some((value) => secondsToMinutes(value));
}

class IgdbClient {
  constructor(id, secret, directory) {
    this.clientId = id;
    this.clientSecret = secret;
    this.cacheDir = directory;
    this.token = null;
    this.lastRequestAt = 0;
  }

  async query(endpoint, body, cacheKey) {
    const cachePath = path.join(this.cacheDir, `${cacheKey}.json`);
    try {
      return JSON.parse(await readFile(cachePath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const token = await this.getToken();
    const waitMs = Math.max(0, 275 - (Date.now() - this.lastRequestAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    const response = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
      method: "POST",
      headers: { "Client-ID": this.clientId, Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "text/plain" },
      body,
      signal: AbortSignal.timeout(30_000)
    });
    this.lastRequestAt = Date.now();
    if (!response.ok) throw new Error(`IGDB ${endpoint} returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error(`IGDB ${endpoint} returned a non-array response.`);
    await writeFile(cachePath, `${JSON.stringify(rows)}\n`, "utf8");
    return rows;
  }

  async getToken() {
    if (this.token) return this.token;
    const body = new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, grant_type: "client_credentials" });
    const response = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`Twitch authentication returned HTTP ${response.status}.`);
    const payload = await response.json();
    if (typeof payload.access_token !== "string") throw new Error("Twitch authentication did not return an access token.");
    this.token = payload.access_token;
    return this.token;
  }
}

function stringArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}
function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function cleanText(value) {
  return String(value ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
}
function secondsToMinutes(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const minutes = Math.round(value / 60);
  return minutes > 0 ? minutes : null;
}
function validCount(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
function validTimestamp(value) {
  return typeof value === "number" && value > 0 ? new Date(value * 1000).toISOString() : null;
}

async function readCredentialsFromStdin() {
  const lines = [];
  const wasRaw = process.stdin.isRaw;
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") process.stdin.setRawMode(true);
  const input = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      lines.push(line.trim());
      if (lines.length === 2) break;
    }
  } finally {
    input.close();
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") process.stdin.setRawMode(Boolean(wasRaw));
  }
  return lines;
}

await main();
