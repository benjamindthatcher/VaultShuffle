import { writeFile } from "node:fs/promises";
import path from "node:path";

const appids = String(stringArgument("--appids") ?? "").split(",").map(positiveInteger).filter(Boolean);
const outputPath = path.resolve(stringArgument("--output") ?? "data/catalogue/steam-device-mode-gaps-2026-08-20.json");
const minRequestIntervalMs = integerArgument("--interval-ms", 1_100);
if (!appids.length) throw new Error("--appids must contain at least one positive Steam AppID.");

let nextRequestAt = 0;
const results = [];
for (const [index, steamAppId] of [...new Set(appids)].entries()) {
  const [details, deck] = await Promise.all([
    fetchJson(`https://store.steampowered.com/api/appdetails?appids=${steamAppId}&cc=US&l=en`),
    fetchJson(`https://store.steampowered.com/saleaction/ajaxgetdeckappcompatibilityreport?nAppID=${steamAppId}&l=english`),
  ]);
  const data = details?.[steamAppId]?.data;
  const category = Number(deck?.results?.resolved_category);
  const deckCompatibility = deck?.success && Number.isInteger(category) ? category : null;
  const fetchedAt = new Date().toISOString();
  results.push({
    steam_appid: steamAppId,
    platform_windows: booleanOrNull(data?.platforms?.windows),
    platform_mac: booleanOrNull(data?.platforms?.mac),
    platform_linux: booleanOrNull(data?.platforms?.linux),
    deck_compatibility: deckCompatibility,
    deck_checked_at: deckCompatibility === null ? null : fetchedAt,
    fetched_at: fetchedAt,
  });
  if (index === 0 || (index + 1) % 10 === 0 || index + 1 === appids.length) {
    console.log(JSON.stringify({ stage: "steam_device_mode_gap_progress", processed: index + 1, total: appids.length }));
  }
}

await writeFile(outputPath, `${JSON.stringify({
  schema_version: 1,
  source: "Steam Store appdetails and Deck compatibility report",
  source_captured_at: new Date().toISOString(),
  results,
})}\n`, "utf8");
console.log(JSON.stringify({ stage: "steam_device_mode_gap_complete", rows: results.length, output_path: outputPath }));

async function fetchJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await paceRequest();
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "VaultShuffle local device-mode gaps/1.0" },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return await response.json();
      lastError = new Error(`Steam returned HTTP ${response.status}.`);
      if (response.status === 403 || response.status === 429) throw lastError;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 4) await delay(Math.min(30_000, 1_000 * 2 ** attempt));
  }
  return null;
}

async function paceRequest() {
  const now = Date.now();
  const requestAt = Math.max(now, nextRequestAt);
  nextRequestAt = requestAt + minRequestIntervalMs;
  if (requestAt > now) await delay(requestAt - now);
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
function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
