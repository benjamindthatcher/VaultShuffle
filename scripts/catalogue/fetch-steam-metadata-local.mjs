import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const manifestPath = path.resolve(stringArgument("--manifest") ?? "data/catalogue/popular-appids-merged-2026-08-20.json");
const outputPath = path.resolve(stringArgument("--output") ?? "data/catalogue/.cache/steam-metadata-local-2026-08-20.ndjson");
const concurrency = integerArgument("--concurrency", 1);
const minRequestIntervalMs = integerArgument("--interval-ms", 1_100);
const limit = integerArgument("--limit", Number.MAX_SAFE_INTEGER);
const includeReviews = process.argv.includes("--include-reviews");
const includeDeck = process.argv.includes("--include-deck");
const explicitAppIds = String(stringArgument("--appids") ?? "").split(",").map(positiveInteger).filter(Boolean);

class SteamHttpError extends Error {
  constructor(status) {
    super(`Steam returned HTTP ${status}.`);
    this.name = "SteamHttpError";
    this.status = status;
  }
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const sourceGames = explicitAppIds.length
  ? [...new Set(explicitAppIds)].slice(0, limit).map((steamAppId) => ({
      steam_appid: steamAppId,
      source_name: `Steam App ${steamAppId}`
    }))
  : manifest.games.slice(0, limit).map((game) => ({
      steam_appid: positiveInteger(game.steam_appid),
      source_name: cleanText(game.name)
    })).filter((game) => game.steam_appid && game.source_name);
if (!sourceGames.length) throw new Error("The source manifest has no valid games.");

await mkdir(path.dirname(outputPath), { recursive: true });
const completed = await completedAppIds(outputPath);
const pending = sourceGames.filter((game) => !completed.has(game.steam_appid));
let nextIndex = 0;
let nextRequestAt = 0;
let writeTail = Promise.resolve();
let ready = 0;
let rejected = 0;
let failed = 0;
let processed = 0;
let rateLimited = false;

console.log(JSON.stringify({
  stage: "steam_local_start",
  manifest_rows: sourceGames.length,
  cached_rows: completed.size,
  pending_rows: pending.length,
  concurrency,
  min_request_interval_ms: minRequestIntervalMs,
  include_reviews: includeReviews,
  include_deck: includeDeck,
  output_path: outputPath
}));

await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
  while (nextIndex < pending.length) {
    const game = pending[nextIndex];
    nextIndex += 1;
    const result = await fetchGame(game);
    if (result.status === "rate_limited") {
      rateLimited = true;
      console.log(JSON.stringify({
        stage: "steam_local_rate_limited",
        steam_appid: game.steam_appid,
        processed,
        error: result.error
      }));
      break;
    }
    if (result.status === "ready") ready += 1;
    else if (result.status === "failed") failed += 1;
    else rejected += 1;
    processed += 1;
    await record(result);
    if (processed % 100 === 0 || processed === pending.length) {
      console.log(JSON.stringify({ stage: "steam_local_progress", processed, total: pending.length, ready, rejected, failed }));
    }
  }
}));
await writeTail;
console.log(JSON.stringify({ stage: "steam_local_complete", processed, ready, rejected, failed, output_path: outputPath }));
if (rateLimited) process.exitCode = 2;

async function fetchGame(game) {
  try {
    const appDetailsUrl = new URL("https://store.steampowered.com/api/appdetails");
    appDetailsUrl.search = new URLSearchParams({ appids: String(game.steam_appid), cc: "US", l: "en" }).toString();
    const payload = await fetchJson(appDetailsUrl);
    const entry = payload?.[game.steam_appid];
    if (entry?.success === false) {
      return result(game, "unavailable", { error: `Steam Store reports AppID ${game.steam_appid} as unavailable.` });
    }
    const data = entry?.data;
    if (!data || typeof data !== "object") return result(game, "failed", { error: "Steam returned incomplete app details." });
    const steamType = cleanText(data.type).toLowerCase();
    const name = cleanText(data.name) || game.source_name;
    if (steamType !== "game") return result(game, "non_game", { steam_type: steamType || "unknown", name });

    const [reviews, deck] = await Promise.all([
      includeReviews ? fetchReviews(game.steam_appid) : null,
      includeDeck ? fetchDeckCompatibility(game.steam_appid) : null
    ]);
    const price = data.price_overview && typeof data.price_overview === "object" ? data.price_overview : null;
    const currency = cleanCurrency(price?.currency);
    const reviewTotal = nonNegativeInteger(reviews?.total_reviews) ?? 0;
    const reviewPositive = Math.min(reviewTotal, nonNegativeInteger(reviews?.total_positive) ?? 0);
    const fetchedAt = new Date().toISOString();
    return result(game, "ready", {
      metadata: {
        steam_appid: game.steam_appid,
        name,
        normalized_name: normalizeName(name) || name.toLowerCase(),
        steam_type: "game",
        developer: stringList(data.developers).join(", ") || null,
        publisher: stringList(data.publishers).join(", ") || null,
        genres: descriptionList(data.genres),
        categories: descriptionList(data.categories),
        short_description: cleanText(data.short_description) || null,
        release_date: steamReleaseDate(data.release_date),
        is_free: Boolean(data.is_free),
        capsule_url: `https://cdn.akamai.steamstatic.com/steam/apps/${game.steam_appid}/library_600x900_2x.jpg`,
        header_url: cleanText(data.header_image) || `https://cdn.akamai.steamstatic.com/steam/apps/${game.steam_appid}/header.jpg`,
        review_positive: reviewPositive,
        review_negative: Math.max(0, reviewTotal - reviewPositive),
        review_total: reviewTotal,
        price_currency: currency === "USD" ? "USD" : null,
        price_initial: currency === "USD" ? nonNegativeInteger(price?.initial) : null,
        price_final: currency === "USD" ? nonNegativeInteger(price?.final) : null,
        discount_percent: currency === "USD" ? clamp(nonNegativeInteger(price?.discount_percent) ?? 0, 0, 100) : 0,
        platform_windows: booleanOrNull(data.platforms?.windows),
        platform_mac: booleanOrNull(data.platforms?.mac),
        platform_linux: booleanOrNull(data.platforms?.linux),
        deck_compatibility: deck,
        deck_checked_at: deck == null ? null : fetchedAt,
        metadata_fetched_at: fetchedAt,
        updated_at: fetchedAt
      }
    });
  } catch (error) {
    if (error instanceof SteamHttpError && (error.status === 403 || error.status === 429)) {
      return result(game, "rate_limited", { error: error.message });
    }
    return result(game, "failed", { error: error instanceof Error ? error.message.slice(0, 500) : "Unknown Steam request failure." });
  }
}

async function fetchReviews(steamAppId) {
  const url = new URL(`https://store.steampowered.com/appreviews/${steamAppId}`);
  url.search = new URLSearchParams({ json: "1", language: "all", purchase_type: "all", num_per_page: "0" }).toString();
  try {
    const payload = await fetchJson(url);
    return payload?.query_summary ?? null;
  } catch {
    return null;
  }
}

async function fetchDeckCompatibility(steamAppId) {
  const url = new URL("https://store.steampowered.com/saleaction/ajaxgetdeckappcompatibilityreport");
  url.search = new URLSearchParams({ nAppID: String(steamAppId), l: "english" }).toString();
  try {
    const payload = await fetchJson(url);
    const category = Number(payload?.results?.resolved_category);
    return payload?.success && Number.isInteger(category) ? category : null;
  } catch {
    return null;
  }
}

async function fetchJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await paceRequest();
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "VaultShuffle local catalogue enrichment/1.0" },
        signal: AbortSignal.timeout(20_000)
      });
      if (response.ok) return await response.json();
      lastError = new SteamHttpError(response.status);
      if (response.status === 403 || response.status === 429) throw lastError;
      if (response.status < 500) throw lastError;
      const retryAfter = Number(response.headers.get("retry-after"));
      await delay(Number.isFinite(retryAfter) ? retryAfter * 1_000 : Math.min(30_000, 1_000 * 2 ** attempt));
    } catch (error) {
      lastError = error;
      if (attempt < 4) await delay(Math.min(30_000, 1_000 * 2 ** attempt));
    }
  }
  throw lastError ?? new Error("Steam request failed.");
}

async function paceRequest() {
  const now = Date.now();
  const requestAt = Math.max(now, nextRequestAt);
  nextRequestAt = requestAt + minRequestIntervalMs;
  if (requestAt > now) await delay(requestAt - now);
}

function record(row) {
  writeTail = writeTail.then(() => appendFile(outputPath, `${JSON.stringify(row)}\n`, "utf8"));
  return writeTail;
}

async function completedAppIds(filePath) {
  try {
    const rows = (await readFile(filePath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    // A live Store miss may be temporary. Only successful games and confirmed
    // non-games are terminal in the local cache; unavailable/failed rows are
    // retried on the next pass.
    return new Set(rows.filter((row) => row.status === "ready" || row.status === "non_game")
      .map((row) => positiveInteger(row.steam_appid)).filter(Boolean));
  } catch (error) {
    if (error?.code === "ENOENT") return new Set();
    throw error;
  }
}

function result(game, status, extra) {
  return { steam_appid: game.steam_appid, source_name: game.source_name, status, ...extra, completed_at: new Date().toISOString() };
}

function stringArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}
function integerArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}
function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}
function cleanText(value) {
  return String(value ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
}
function normalizeName(value) {
  return cleanText(value).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function cleanCurrency(value) {
  const currency = cleanText(value).toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}
function stringList(value) {
  return Array.isArray(value) ? value.map(cleanText).filter(Boolean) : [];
}
function descriptionList(value) {
  return Array.isArray(value) ? value.map((item) => cleanText(typeof item === "string" ? item : item?.description)).filter(Boolean) : [];
}
function steamReleaseDate(value) {
  const raw = cleanText(value?.date);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}
function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
