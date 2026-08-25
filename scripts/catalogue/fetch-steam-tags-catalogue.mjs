import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const today = new Date().toISOString().slice(0, 10);
const manifestPath = path.resolve(stringArgument("--manifest") ?? "data/catalogue/popular-appids-expanded-2026-08-20.json");
const outputPath = path.resolve(stringArgument("--output") ?? `data/catalogue/steam-tags-catalogue-${today}.json`);
const checkpointPath = path.resolve(stringArgument("--checkpoint") ?? `${outputPath}.checkpoint.ndjson`);
const batchSize = integerArgument("--batch-size", 250);
const minRequestIntervalMs = integerArgument("--interval-ms", 1_000);
const passCount = integerArgument("--passes", 2);
const steamSpyFallback = process.argv.includes("--steamspy-fallback");
const onlyAppids = process.argv.includes("--only-appids");

if (batchSize > 250) throw new Error("--batch-size must be 250 or fewer to keep Steam request URLs within safe limits.");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const games = Array.isArray(manifest) ? manifest : manifest.games;
if (!Array.isArray(games)) throw new Error("The manifest must be an array or contain a games array.");

const wanted = new Set();
if (!onlyAppids) {
  for (const game of games) {
    const steamAppId = positiveInteger(game?.steam_appid ?? game?.appid);
    if (steamAppId) wanted.add(steamAppId);
  }
}
for (const raw of (stringArgument("--appids") ?? "").split(",")) {
  const steamAppId = positiveInteger(raw.trim());
  if (steamAppId) wanted.add(steamAppId);
}
if (!wanted.size) throw new Error("No valid Steam AppIDs were supplied.");

const tagNames = await fetchTagNames();
const completed = await readCheckpoint(checkpointPath);
let nextRequestAt = 0;
let requestCount = 0;
let failedAttemptRows = 0;

for (let pass = 1; pass <= passCount; pass += 1) {
  const remaining = [...wanted].filter((steamAppId) => !completed.has(steamAppId));
  if (!remaining.length) break;
  const batches = chunk(remaining, batchSize);
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    try {
      const rows = await fetchTagBatch(batch, tagNames);
      const capturedAt = new Date().toISOString();
      const checkpointLines = [];
      for (const row of rows) {
        const completedRow = { ...row, tags_fetched_at: capturedAt, tags_source: "steam-store" };
        completed.set(row.steam_appid, completedRow);
        checkpointLines.push(JSON.stringify(completedRow));
      }
      if (checkpointLines.length) await appendFile(checkpointPath, `${checkpointLines.join("\n")}\n`, "utf8");
    } catch (error) {
      failedAttemptRows += batch.length;
      console.error(JSON.stringify({
        stage: "steam_tags_batch_failed",
        pass,
        batch: index + 1,
        batch_rows: batch.length,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
    console.log(JSON.stringify({
      stage: "steam_tags_progress",
      pass,
      completed_batches: index + 1,
      total_batches: batches.length,
      completed_rows: completed.size,
      remaining_rows: wanted.size - completed.size,
      requests: requestCount,
    }));
  }
}

if (steamSpyFallback) {
  const remaining = [...wanted].filter((steamAppId) => !completed.has(steamAppId));
  for (const [index, steamAppId] of remaining.entries()) {
    const row = await fetchSteamSpyTags(steamAppId);
    if (row) {
      const completedRow = { ...row, tags_fetched_at: new Date().toISOString(), tags_source: "steamspy" };
      completed.set(steamAppId, completedRow);
      await appendFile(checkpointPath, `${JSON.stringify(completedRow)}\n`, "utf8");
    }
    if (index === 0 || (index + 1) % 10 === 0 || index + 1 === remaining.length) {
      console.log(JSON.stringify({
        stage: "steam_tags_steamspy_progress",
        processed_rows: index + 1,
        total_rows: remaining.length,
        completed_rows: completed.size,
        unresolved_rows: wanted.size - completed.size,
        requests: requestCount,
      }));
    }
  }
}

const results = [...completed.values()]
  .filter((row) => wanted.has(row.steam_appid))
  .sort((left, right) => left.steam_appid - right.steam_appid);
const unresolvedAppids = [...wanted].filter((steamAppId) => !completed.has(steamAppId)).sort((a, b) => a - b);

await writeFile(outputPath, `${JSON.stringify({
  schema_version: 1,
  source: "Steam Store IStoreBrowseService/GetItems weighted tags and IStoreService/GetTagList",
  source_captured_at: new Date().toISOString(),
  manifest_path: manifestPath,
  manifest_rows: wanted.size,
  completed_rows: results.length,
  nonempty_rows: results.filter((row) => Object.keys(row.tags).length > 0).length,
  unresolved_rows: unresolvedAppids.length,
  unresolved_appids: unresolvedAppids,
  results,
})}\n`, "utf8");

console.log(JSON.stringify({
  stage: "steam_tags_complete",
  manifest_rows: wanted.size,
  completed_rows: results.length,
  nonempty_rows: results.filter((row) => Object.keys(row.tags).length > 0).length,
  unresolved_rows: unresolvedAppids.length,
  requests: requestCount,
  failed_attempt_rows: failedAttemptRows,
  output_path: outputPath,
  checkpoint_path: checkpointPath,
}));

async function fetchTagNames() {
  const response = await fetch("https://api.steampowered.com/IStoreService/GetTagList/v1/?language=english", {
    headers: { Accept: "application/json", "User-Agent": "VaultShuffle catalogue enrichment/1.0" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Steam tag list returned HTTP ${response.status}.`);
  const payload = await response.json();
  const tags = payload?.response?.tags;
  if (!Array.isArray(tags)) throw new Error("Steam tag list returned an invalid payload.");
  return new Map(tags.flatMap((tag) => {
    const tagId = positiveInteger(tag?.tagid);
    const name = typeof tag?.name === "string" ? tag.name.trim() : "";
    return tagId && name ? [[tagId, name]] : [];
  }));
}

async function fetchTagBatch(appids, names) {
  const input = {
    ids: appids.map((appid) => ({ appid })),
    context: { language: "english", country_code: "GB", steam_realm: 1 },
    data_request: { include_tag_count: 20 },
  };
  const url = new URL("https://api.steampowered.com/IStoreBrowseService/GetItems/v1/");
  url.searchParams.set("input_json", JSON.stringify(input));
  const items = await fetchStoreItems(url);
  return items.flatMap((item) => {
    const steamAppId = positiveInteger(item?.appid ?? item?.id);
    if (!steamAppId || !appids.includes(steamAppId)) return [];
    const tags = Object.fromEntries((Array.isArray(item?.tags) ? item.tags : []).flatMap((tag) => {
      const tagId = positiveInteger(tag?.tagid);
      const name = tagId ? names.get(tagId) : null;
      const weight = nonNegativeInteger(tag?.weight);
      return name && weight !== null ? [[name, weight]] : [];
    }));
    return [{ steam_appid: steamAppId, tags }];
  });
}

async function fetchStoreItems(url) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await paceRequest();
    requestCount += 1;
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "VaultShuffle catalogue enrichment/1.0" },
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
      return items;
    } catch (error) {
      lastError = error;
      if (attempt < 5) await delay(retryDelay(error, attempt));
    }
  }
  throw lastError ?? new Error("Steam item service request failed.");
}

async function fetchSteamSpyTags(steamAppId) {
  const url = new URL("https://steamspy.com/api.php");
  url.searchParams.set("request", "appdetails");
  url.searchParams.set("appid", String(steamAppId));
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await paceRequest();
    requestCount += 1;
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "VaultShuffle catalogue enrichment/1.0" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const error = new Error(`SteamSpy returned HTTP ${response.status}.`);
        error.status = response.status;
        error.retryAfter = nonNegativeInteger(response.headers.get("retry-after"));
        throw error;
      }
      const payload = await response.json();
      if (Number(payload?.appid) !== steamAppId) return null;
      return { steam_appid: steamAppId, tags: sanitizeTags(payload?.tags) };
    } catch (error) {
      lastError = error;
      if (attempt < 4) await delay(retryDelay(error, attempt));
    }
  }
  console.error(JSON.stringify({
    stage: "steam_tags_steamspy_failed",
    steam_appid: steamAppId,
    message: lastError instanceof Error ? lastError.message : String(lastError),
  }));
  return null;
}

function sanitizeTags(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([rawTag, rawWeight]) => {
    const tag = rawTag.trim().replace(/\s+/g, " ");
    const weight = nonNegativeInteger(rawWeight);
    return tag && tag.length <= 100 && weight !== null ? [[tag, weight]] : [];
  }));
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
    if (!steamAppId || !row?.tags || typeof row.tags !== "object" || Array.isArray(row.tags)) continue;
    if (typeof row?.tags_fetched_at !== "string" || typeof row?.tags_source !== "string") continue;
    rows.set(steamAppId, row);
  }
  return rows;
}

async function paceRequest() {
  const now = Date.now();
  const requestAt = Math.max(now, nextRequestAt);
  nextRequestAt = requestAt + minRequestIntervalMs;
  if (requestAt > now) await delay(requestAt - now);
}
function retryDelay(error, attempt) {
  return error?.status === 429
    ? Math.max(60_000, (error.retryAfter ?? 0) * 1_000)
    : Math.min(30_000, 1_000 * 2 ** attempt);
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
