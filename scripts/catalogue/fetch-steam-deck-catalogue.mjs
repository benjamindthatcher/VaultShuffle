import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const today = new Date().toISOString().slice(0, 10);
const manifestPath = path.resolve(stringArgument("--manifest") ?? "data/catalogue/popular-appids-expanded-2026-08-20.json");
const outputPath = path.resolve(stringArgument("--output") ?? `data/catalogue/steam-deck-catalogue-${today}.json`);
const checkpointPath = path.resolve(stringArgument("--checkpoint") ?? `${outputPath}.checkpoint.ndjson`);
const batchSize = integerArgument("--batch-size", 250);
const minRequestIntervalMs = integerArgument("--interval-ms", 1_000);
const passCount = integerArgument("--passes", 2);
const directFallback = process.argv.includes("--direct-fallback");
const onlyAppids = process.argv.includes("--only-appids");

if (batchSize > 250) throw new Error("--batch-size must be 250 or fewer to keep Steam request URLs within safe limits.");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const games = Array.isArray(manifest) ? manifest : manifest.games;
if (!Array.isArray(games)) throw new Error("The manifest must be an array or contain a games array.");

const names = new Map();
if (!onlyAppids) {
  for (const game of games) {
    const steamAppId = positiveInteger(game?.steam_appid ?? game?.appid);
    if (!steamAppId) continue;
    const name = typeof game?.name === "string" && game.name.trim() ? game.name.trim() : null;
    if (!names.has(steamAppId) || (!names.get(steamAppId) && name)) names.set(steamAppId, name);
  }
}
for (const raw of (stringArgument("--appids") ?? "").split(",")) {
  const steamAppId = positiveInteger(raw.trim());
  if (steamAppId && !names.has(steamAppId)) names.set(steamAppId, null);
}
if (!names.size) throw new Error("No valid Steam AppIDs were supplied.");

const completed = await readCheckpoint(checkpointPath);
let nextRequestAt = 0;
let requestCount = 0;
let failureCount = 0;

for (let pass = 1; pass <= passCount; pass += 1) {
  const remaining = [...names.keys()].filter((steamAppId) => !completed.has(steamAppId));
  if (!remaining.length) break;
  const batches = chunk(remaining, batchSize);
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    try {
      const rows = await fetchDeckBatch(batch);
      const capturedAt = new Date().toISOString();
      const checkpointLines = [];
      for (const row of rows) {
        completed.set(row.steam_appid, { ...row, deck_checked_at: capturedAt });
        checkpointLines.push(JSON.stringify({ ...row, deck_checked_at: capturedAt }));
      }
      if (checkpointLines.length) await appendFile(checkpointPath, `${checkpointLines.join("\n")}\n`, "utf8");
    } catch (error) {
      failureCount += batch.length;
      console.error(JSON.stringify({
        stage: "steam_deck_batch_failed",
        pass,
        batch: index + 1,
        batch_rows: batch.length,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
    console.log(JSON.stringify({
      stage: "steam_deck_progress",
      pass,
      completed_batches: index + 1,
      total_batches: batches.length,
      completed_rows: completed.size,
      remaining_rows: names.size - completed.size,
      requests: requestCount,
    }));
  }
}

if (directFallback) {
  const remaining = [...names.keys()].filter((steamAppId) => !completed.has(steamAppId));
  for (const [index, steamAppId] of remaining.entries()) {
    const row = await fetchDeckReport(steamAppId);
    if (row) {
      const completedRow = { ...row, deck_checked_at: new Date().toISOString() };
      completed.set(steamAppId, completedRow);
      await appendFile(checkpointPath, `${JSON.stringify(completedRow)}\n`, "utf8");
    }
    if (index === 0 || (index + 1) % 10 === 0 || index + 1 === remaining.length) {
      console.log(JSON.stringify({
        stage: "steam_deck_direct_progress",
        processed_rows: index + 1,
        total_rows: remaining.length,
        completed_rows: completed.size,
        unresolved_rows: names.size - completed.size,
        requests: requestCount,
      }));
    }
  }
}

const results = [...completed.values()]
  .filter((row) => names.has(row.steam_appid))
  .sort((left, right) => left.steam_appid - right.steam_appid)
  .map((row) => ({ ...row, name: names.get(row.steam_appid) }));
const unresolvedAppids = [...names.keys()].filter((steamAppId) => !completed.has(steamAppId)).sort((a, b) => a - b);
const distribution = Object.fromEntries([0, 1, 2, 3].map((category) => [category, results.filter((row) => row.deck_compatibility === category).length]));

await writeFile(outputPath, `${JSON.stringify({
  schema_version: 1,
  source: "Steam Store IStoreBrowseService/GetItems platforms.steam_deck_compat_category",
  source_captured_at: new Date().toISOString(),
  manifest_path: manifestPath,
  manifest_rows: names.size,
  completed_rows: results.length,
  unresolved_rows: unresolvedAppids.length,
  unresolved_appids: unresolvedAppids,
  distribution,
  results,
})}\n`, "utf8");

console.log(JSON.stringify({
  stage: "steam_deck_complete",
  manifest_rows: names.size,
  completed_rows: results.length,
  unresolved_rows: unresolvedAppids.length,
  distribution,
  requests: requestCount,
  failed_attempt_rows: failureCount,
  output_path: outputPath,
  checkpoint_path: checkpointPath,
}));

async function fetchDeckBatch(appids) {
  const input = {
    ids: appids.map((appid) => ({ appid })),
    context: { language: "english", country_code: "GB", steam_realm: 1 },
    data_request: { include_platforms: true },
  };
  const url = new URL("https://api.steampowered.com/IStoreBrowseService/GetItems/v1/");
  url.searchParams.set("input_json", JSON.stringify(input));
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await paceRequest();
    requestCount += 1;
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "VaultShuffle local Steam Deck enrichment/1.0" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const error = new Error(`Steam item service returned HTTP ${response.status}.`);
        error.status = response.status;
        error.retryAfter = nonNegativeInteger(response.headers.get("retry-after"));
        throw error;
      }
      const payload = await response.json();
      const items = payload?.response?.store_items;
      if (!Array.isArray(items)) throw new Error("Steam item service returned an invalid payload.");
      const rows = [];
      for (const item of items) {
        const steamAppId = positiveInteger(item?.appid ?? item?.id);
        const category = nonNegativeInteger(item?.platforms?.steam_deck_compat_category);
        if (!steamAppId || !appids.includes(steamAppId) || category === null || category > 3) continue;
        rows.push({ steam_appid: steamAppId, deck_compatibility: category });
      }
      return rows;
    } catch (error) {
      lastError = error;
      if (attempt < 5) {
        const retryMs = error?.status === 429
          ? Math.max(60_000, (error.retryAfter ?? 0) * 1_000)
          : Math.min(30_000, 1_000 * 2 ** attempt);
        await delay(retryMs);
      }
    }
  }
  throw lastError ?? new Error("Steam item service request failed.");
}

async function fetchDeckReport(steamAppId) {
  const url = new URL("https://store.steampowered.com/saleaction/ajaxgetdeckappcompatibilityreport");
  url.searchParams.set("nAppID", String(steamAppId));
  url.searchParams.set("l", "english");
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await paceRequest();
    requestCount += 1;
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "VaultShuffle local Steam Deck enrichment/1.0" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const error = new Error(`Steam Deck report returned HTTP ${response.status}.`);
        error.status = response.status;
        error.retryAfter = nonNegativeInteger(response.headers.get("retry-after"));
        throw error;
      }
      const payload = await response.json();
      const category = nonNegativeInteger(payload?.results?.resolved_category);
      if (!payload?.success || category === null || category > 3) return null;
      return { steam_appid: steamAppId, deck_compatibility: category };
    } catch (error) {
      lastError = error;
      if (attempt < 5) {
        const retryMs = error?.status === 429
          ? Math.max(60_000, (error.retryAfter ?? 0) * 1_000)
          : Math.min(30_000, 1_000 * 2 ** attempt);
        await delay(retryMs);
      }
    }
  }
  console.error(JSON.stringify({
    stage: "steam_deck_direct_failed",
    steam_appid: steamAppId,
    message: lastError instanceof Error ? lastError.message : String(lastError),
  }));
  return null;
}

async function readCheckpoint(filePath) {
  const rows = new Map();
  let contents;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return rows;
    throw error;
  }
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const steamAppId = positiveInteger(row?.steam_appid);
    const category = nonNegativeInteger(row?.deck_compatibility);
    if (!steamAppId || category === null || category > 3 || typeof row?.deck_checked_at !== "string") continue;
    rows.set(steamAppId, { steam_appid: steamAppId, deck_compatibility: category, deck_checked_at: row.deck_checked_at });
  }
  return rows;
}

async function paceRequest() {
  const now = Date.now();
  const requestAt = Math.max(now, nextRequestAt);
  nextRequestAt = requestAt + minRequestIntervalMs;
  if (requestAt > now) await delay(requestAt - now);
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}
function stringArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}
function integerArgument(name, fallback) {
  const value = stringArgument(name);
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}
function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
