import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  buildIgdbCohort,
  IGDB_METRICS,
  resolveIgdbMetricTypes,
  sha256,
  validSteamAppId
} from "./popular-catalogue-lib.mjs";

const PAGE_SIZE = 500;
const MAPPING_BATCH_SIZE = 300;
const REQUEST_INTERVAL_MS = 300;
const COHORT_SIZE = integerArgument("--count", 10_000);
const PER_METRIC_LIMIT = integerArgument("--per-metric-limit", 15_000);
const capturedAt = stringArgument("--captured-at") ?? new Date().toISOString().slice(0, 10);
const outputPath = path.resolve(stringArgument("--output") ?? `data/catalogue/igdb-top-${COHORT_SIZE}-steam-popularity-${capturedAt}.json`);
const cacheDir = path.resolve("data/catalogue/.cache", `igdb-popularity-${capturedAt}`);
let clientId = process.env.IGDB_CLIENT_ID;
let clientSecret = process.env.IGDB_CLIENT_SECRET;
if ((!clientId || !clientSecret) && process.argv.includes("--credentials-stdin")) {
  console.log(JSON.stringify({ stage: "igdb_credentials_waiting", transport: "stdin_memory_only" }));
  [clientId, clientSecret] = await readCredentialsFromStdin();
}
if (!clientId || !clientSecret) {
  throw new Error("IGDB credentials must be injected by the runtime or supplied with --credentials-stdin.");
}

async function main() {
await mkdir(cacheDir, { recursive: true });
const igdb = new IgdbClient(clientId, clientSecret, cacheDir);
const steamSources = await igdb.query("external_game_sources", 'fields id,name; where name = "Steam"; limit 10;', "steam-source");
const steamSourceIds = [...new Set(steamSources.filter((row) => row.name === "Steam" && Number.isInteger(Number(row.id))).map((row) => Number(row.id)))];
if (steamSourceIds.length !== 1) throw new Error(`Expected one IGDB Steam source; found ${steamSourceIds.length}.`);
const steamSourceId = steamSourceIds[0];

const popularityTypes = await igdb.query(
  "popularity_types",
  "fields id,name,external_popularity_source; limit 500;",
  "popularity-types"
);
const metricTypes = resolveIgdbMetricTypes(popularityTypes, steamSourceId);
console.log(JSON.stringify({ stage: "igdb_types_ready", steam_source_id: steamSourceId, metric_types: metricTypes }));

const rankings = {};
for (const [metric, type] of Object.entries(metricTypes)) {
  rankings[metric] = await fetchRanking(igdb, metric, type.id, PER_METRIC_LIMIT);
  console.log(JSON.stringify({ stage: "igdb_metric_ready", metric, popularity_type_id: type.id, rows: rankings[metric].length }));
}

const gameIds = [...new Set(Object.values(rankings).flatMap((rows) => rows.map((row) => row.game_id)))].sort((a, b) => a - b);
const mappings = [];
for (let start = 0; start < gameIds.length; start += MAPPING_BATCH_SIZE) {
  const batch = gameIds.slice(start, start + MAPPING_BATCH_SIZE);
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const key = `mapping-${String(start).padStart(6, "0")}-${String(offset).padStart(5, "0")}`;
    const body = `fields game,uid,name,external_game_source; where external_game_source = ${steamSourceId} & game = (${batch.join(",")}); sort game asc; limit ${PAGE_SIZE}; offset ${offset};`;
    const rows = await igdb.query("external_games", body, key);
    mappings.push(...rows.flatMap((row) => {
      const steamAppId = validSteamAppId(row.uid);
      const gameId = positiveInteger(row.game);
      return steamAppId && gameId ? [{ game_id: gameId, steam_appid: steamAppId, name: row.name }] : [];
    }));
    if (rows.length < PAGE_SIZE) break;
  }
  console.log(JSON.stringify({ stage: "igdb_mapping_progress", processed_game_ids: Math.min(start + batch.length, gameIds.length), total_game_ids: gameIds.length, mappings: mappings.length }));
}

const cohort = buildIgdbCohort(rankings, mappings, COHORT_SIZE);
if (cohort.games.length !== COHORT_SIZE) {
  throw new Error(`IGDB produced ${cohort.games.length} unique named Steam AppIDs; expected ${COHORT_SIZE}. Increase --per-metric-limit.`);
}

const output = {
  schema_version: 1,
  source: "IGDB",
  metric: "weighted_reciprocal_rank",
  captured_at: capturedAt,
  requested_count: COHORT_SIZE,
  accepted_count: cohort.games.length,
  per_metric_limit: PER_METRIC_LIMIT,
  weights: Object.fromEntries(Object.entries(IGDB_METRICS).map(([metric, config]) => [metric, config.weight])),
  metric_types: metricTypes,
  source_counts: Object.fromEntries(Object.entries(rankings).map(([metric, rows]) => [metric, rows.length])),
  mapping_counts: {
    popularity_game_ids: gameIds.length,
    valid_steam_mappings: mappings.length,
    ...cohort.diagnostics,
    mapping_name_conflicts: cohort.diagnostics.mapping_name_conflicts.length
  },
  games: cohort.games
};
const serialized = `${JSON.stringify(output, null, 2)}\n`;
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, serialized, "utf8");
if (cohort.diagnostics.mapping_name_conflicts.length) {
  await writeFile(outputPath.replace(/\.json$/, ".name-conflicts.json"), `${JSON.stringify(cohort.diagnostics.mapping_name_conflicts, null, 2)}\n`, "utf8");
}
console.log(JSON.stringify({ stage: "igdb_complete", output_path: outputPath, rows: cohort.games.length, sha256: sha256(serialized) }));
}

async function fetchRanking(client, metric, popularityTypeId, limit) {
  const ranked = [];
  const seen = new Set();
  for (let offset = 0; offset < limit; offset += PAGE_SIZE) {
    const body = `fields game_id,value,popularity_type,calculated_at; where popularity_type = ${popularityTypeId}; sort value desc; limit ${PAGE_SIZE}; offset ${offset};`;
    const rows = await client.query("popularity_primitives", body, `${metric}-${String(offset).padStart(5, "0")}`);
    for (const row of rows) {
      const gameId = positiveInteger(row.game_id);
      if (!gameId || seen.has(gameId)) continue;
      seen.add(gameId);
      ranked.push({ game_id: gameId, rank: ranked.length + 1, value: finiteNumber(row.value), calculated_at: row.calculated_at ?? null });
      if (ranked.length >= limit) break;
    }
    if (rows.length < PAGE_SIZE || ranked.length >= limit) break;
  }
  return ranked;
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
    const waitMs = Math.max(0, REQUEST_INTERVAL_MS - (Date.now() - this.lastRequestAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    const response = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
      method: "POST",
      headers: {
        "Client-ID": this.clientId,
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "text/plain"
      },
      body,
      signal: AbortSignal.timeout(30_000)
    });
    this.lastRequestAt = Date.now();
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`IGDB ${endpoint} returned HTTP ${response.status}: ${detail}`);
    }
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

function integerArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function stringArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
