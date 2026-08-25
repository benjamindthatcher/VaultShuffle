import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const today = new Date().toISOString().slice(0, 10);
const manifestPath = path.resolve(stringArgument("--manifest") ?? "data/catalogue/popular-appids-expanded-2026-08-20.json");
const outputPath = path.resolve(stringArgument("--output") ?? `data/catalogue/steam-bulk-metadata-${today}.json`);
const checkpointPath = path.resolve(stringArgument("--checkpoint") ?? `${outputPath}.checkpoint.ndjson`);
const batchSize = integerArgument("--batch-size", 250);
const minRequestIntervalMs = integerArgument("--interval-ms", 1_000);
const passCount = integerArgument("--passes", 2);
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
      const rows = await fetchMetadataBatch(batch);
      const capturedAt = new Date().toISOString();
      const checkpointLines = [];
      for (const row of rows) {
        const completedRow = { ...row, source_checked_at: capturedAt };
        completed.set(row.steam_appid, completedRow);
        checkpointLines.push(JSON.stringify(completedRow));
      }
      if (checkpointLines.length) await appendFile(checkpointPath, `${checkpointLines.join("\n")}\n`, "utf8");
    } catch (error) {
      failedAttemptRows += batch.length;
      console.error(JSON.stringify({
        stage: "steam_bulk_metadata_batch_failed",
        pass,
        batch: index + 1,
        batch_rows: batch.length,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
    console.log(JSON.stringify({
      stage: "steam_bulk_metadata_progress",
      pass,
      completed_batches: index + 1,
      total_batches: batches.length,
      completed_rows: completed.size,
      remaining_rows: wanted.size - completed.size,
      requests: requestCount,
    }));
  }
}

const results = [...completed.values()]
  .filter((row) => wanted.has(row.steam_appid))
  .sort((left, right) => left.steam_appid - right.steam_appid);
const unresolvedAppids = [...wanted].filter((steamAppId) => !completed.has(steamAppId)).sort((a, b) => a - b);

await writeFile(outputPath, `${JSON.stringify({
  schema_version: 1,
  source: "Steam Store IStoreBrowseService/GetItems",
  source_captured_at: new Date().toISOString(),
  manifest_path: manifestPath,
  manifest_rows: wanted.size,
  completed_rows: results.length,
  unresolved_rows: unresolvedAppids.length,
  unresolved_appids: unresolvedAppids,
  results,
})}\n`, "utf8");

console.log(JSON.stringify({
  stage: "steam_bulk_metadata_complete",
  manifest_rows: wanted.size,
  completed_rows: results.length,
  unresolved_rows: unresolvedAppids.length,
  requests: requestCount,
  failed_attempt_rows: failedAttemptRows,
  output_path: outputPath,
  checkpoint_path: checkpointPath,
}));

async function fetchMetadataBatch(appids) {
  const input = {
    ids: appids.map((appid) => ({ appid })),
    context: { language: "english", country_code: "US", steam_realm: 1 },
    data_request: {
      include_basic_info: true,
      include_assets: true,
      include_platforms: true,
      include_release: true,
      include_reviews: true,
    },
  };
  const url = new URL("https://api.steampowered.com/IStoreBrowseService/GetItems/v1/");
  url.searchParams.set("input_json", JSON.stringify(input));
  const items = await fetchStoreItems(url);
  return items.flatMap((item) => {
    const steamAppId = positiveInteger(item?.appid ?? item?.id);
    if (!steamAppId || !appids.includes(steamAppId)) return [];
    const platforms = item?.platforms && typeof item.platforms === "object" ? item.platforms : null;
    const category = nonNegativeInteger(platforms?.steam_deck_compat_category);
    const reviewCount = nonNegativeInteger(item?.reviews?.summary_filtered?.review_count);
    const percentPositive = boundedPercent(item?.reviews?.summary_filtered?.percent_positive);
    const reviewPositive = reviewCount !== null && percentPositive !== null
      ? Math.round(reviewCount * percentPositive / 100)
      : null;
    const developers = peopleNames(item?.basic_info?.developers);
    const publishers = peopleNames(item?.basic_info?.publishers);
    return [{
      steam_appid: steamAppId,
      name: cleanText(item?.name) || null,
      developer: developers.length ? developers.join(", ") : null,
      publisher: publishers.length ? publishers.join(", ") : null,
      short_description: cleanText(item?.basic_info?.short_description) || null,
      release_date: unixDate(item?.release?.steam_release_date),
      capsule_url: assetUrl(item?.assets, item?.assets?.library_capsule_2x ?? item?.assets?.library_capsule ?? item?.assets?.main_capsule),
      header_url: assetUrl(item?.assets, item?.assets?.header_2x ?? item?.assets?.header),
      platform_windows: platforms ? Boolean(platforms.windows) : null,
      platform_mac: platforms ? Boolean(platforms.mac) : null,
      platform_linux: platforms ? Boolean(platforms.steamos_linux) : null,
      deck_compatibility: category !== null && category <= 3 ? category : null,
      review_total: reviewCount,
      review_positive: reviewPositive,
      review_negative: reviewCount !== null && reviewPositive !== null ? Math.max(0, reviewCount - reviewPositive) : null,
    }];
  });
}

async function fetchStoreItems(url) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await paceRequest();
    requestCount += 1;
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "VaultShuffle catalogue metadata/1.0" },
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
    if (!steamAppId || typeof row?.source_checked_at !== "string") continue;
    rows.set(steamAppId, row);
  }
  return rows;
}

function assetUrl(assets, filename) {
  const format = cleanText(assets?.asset_url_format);
  const file = cleanText(filename);
  if (!format || !file || !format.includes("${FILENAME}")) return null;
  return `https://shared.fastly.steamstatic.com/store_item_assets/${format.replace("${FILENAME}", file)}`;
}
function peopleNames(value) {
  return Array.isArray(value) ? value.map((person) => cleanText(person?.name)).filter(Boolean) : [];
}
function unixDate(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1_000).toISOString().slice(0, 10);
}
function cleanText(value) {
  return String(value ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
}
function boundedPercent(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
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
