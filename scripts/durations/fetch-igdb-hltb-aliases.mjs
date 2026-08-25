import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const inputPath = path.resolve(stringArgument("--input") ?? "data/catalogue/igdb-durations-expanded-local-2026-08-20.json");
const outputPath = path.resolve(stringArgument("--output") ?? "/private/tmp/vaultshuffle-igdb-hltb-aliases.json");
const batchSize = integerArgument("--batch-size", 500);
const intervalMs = integerArgument("--interval-ms", 275);
let clientId = process.env.IGDB_CLIENT_ID;
let clientSecret = process.env.IGDB_CLIENT_SECRET;
if ((!clientId || !clientSecret) && process.argv.includes("--credentials-stdin")) {
  console.log(JSON.stringify({ stage: "igdb_credentials_waiting", transport: "stdin_memory_only" }));
  [clientId, clientSecret] = await readCredentialsFromStdin();
}
if (!clientId || !clientSecret) throw new Error("IGDB credentials must be injected or supplied with --credentials-stdin.");

const input = JSON.parse(await readFile(inputPath, "utf8"));
const sourceRows = (input.results ?? []).filter((row) =>
  row.status === "no_duration" && positiveInteger(row.provider_game_id) && positiveInteger(row.steam_appid)
);
const rowsByGameId = new Map();
for (const row of sourceRows) {
  const gameId = positiveInteger(row.provider_game_id);
  const rows = rowsByGameId.get(gameId) ?? [];
  rows.push(row);
  rowsByGameId.set(gameId, rows);
}

let token = null;
let nextRequestAt = 0;
const gamesById = new Map();
const gameIds = [...rowsByGameId.keys()].sort((left, right) => left - right);
for (let start = 0; start < gameIds.length; start += batchSize) {
  const ids = gameIds.slice(start, start + batchSize);
  const games = await igdb(
    "games",
    `fields id,name,alternative_names.name,version_title,version_parent.name,version_parent.alternative_names.name; where id = (${ids.join(",")}); limit ${batchSize};`
  );
  for (const game of games) {
    const gameId = positiveInteger(game?.id);
    if (gameId) gamesById.set(gameId, game);
  }
  const processed = Math.min(start + batchSize, gameIds.length);
  if (processed % 5_000 === 0 || processed === gameIds.length) {
    console.log(JSON.stringify({ stage: "igdb_alias_progress", processed_game_ids: processed, total_game_ids: gameIds.length }));
  }
}

const results = [];
for (const [gameId, rows] of rowsByGameId) {
  const game = gamesById.get(gameId);
  if (!game) continue;
  const canonicalAliases = uniqueStrings([
    game.name,
    game.version_parent?.name,
  ]);
  const alternateAliases = uniqueStrings([
    ...(game.alternative_names ?? []).map((alias) => alias?.name),
    ...(game.version_parent?.alternative_names ?? []).map((alias) => alias?.name),
  ]);
  const aliases = uniqueStrings([...canonicalAliases, ...alternateAliases]);
  for (const row of rows) {
    results.push({
      steam_appid: positiveInteger(row.steam_appid),
      steam_name: cleanText(row.name),
      igdb_game_id: gameId,
      canonical_aliases: canonicalAliases,
      alternate_aliases: alternateAliases,
      aliases,
    });
  }
}

await writeFile(outputPath, `${JSON.stringify({
  schema_version: 1,
  source: "IGDB exact Steam mappings, canonical names, alternate names, and version parents",
  source_rows: sourceRows.length,
  unique_game_ids: gameIds.length,
  resolved_game_ids: gamesById.size,
  results,
  captured_at: new Date().toISOString(),
})}\n`, "utf8");

console.log(JSON.stringify({
  stage: "igdb_alias_complete",
  source_rows: sourceRows.length,
  unique_game_ids: gameIds.length,
  resolved_game_ids: gamesById.size,
  result_rows: results.length,
  rows_with_alternate_identity: results.filter((row) => row.aliases.some((alias) => normalize(alias) !== normalize(row.steam_name))).length,
  output_path: outputPath,
}));

async function igdb(endpoint, body, refreshed = false) {
  const accessToken = await getToken();
  await pace();
  const response = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
    method: "POST",
    headers: {
      "Client-ID": clientId,
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "text/plain",
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 401 && !refreshed) {
    token = null;
    return igdb(endpoint, body, true);
  }
  if (!response.ok) throw new Error(`IGDB returned HTTP ${response.status}.`);
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error("IGDB returned an invalid response.");
  return payload;
}

async function getToken() {
  if (token) return token;
  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`IGDB authentication returned HTTP ${response.status}.`);
  const payload = await response.json();
  if (typeof payload.access_token !== "string") throw new Error("IGDB authentication returned an invalid response.");
  token = payload.access_token;
  return token;
}

async function pace() {
  const now = Date.now();
  const requestAt = Math.max(now, nextRequestAt);
  nextRequestAt = requestAt + intervalMs;
  if (requestAt > now) await new Promise((resolve) => setTimeout(resolve, requestAt - now));
}

function uniqueStrings(values) {
  const byNormalized = new Map();
  for (const value of values) {
    const cleaned = cleanText(value);
    const key = normalize(cleaned);
    if (key && !byNormalized.has(key)) byNormalized.set(key, cleaned);
  }
  return [...byNormalized.values()];
}
function cleanText(value) { return String(value ?? "").normalize("NFC").trim().replace(/\s+/g, " "); }
function normalize(value) { return cleanText(value).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function stringArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}
function integerArgument(name, fallback) {
  const value = stringArgument(name);
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 500) throw new Error(`${name} must be between 1 and 500.`);
  return parsed;
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
