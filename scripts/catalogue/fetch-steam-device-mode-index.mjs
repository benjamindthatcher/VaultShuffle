import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const manifestPath = path.resolve(stringArgument("--manifest") ?? "data/catalogue/popular-appids-expanded-2026-08-20.json");
const outputPath = path.resolve(stringArgument("--output") ?? "data/catalogue/steam-device-mode-index-2026-08-20.json");
const concurrency = integerArgument("--concurrency", 6);
const count = integerArgument("--page-size", 100);
const minRequestIntervalMs = integerArgument("--interval-ms", 150);

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const wanted = new Set((manifest.games ?? []).map((game) => positiveInteger(game.steam_appid)).filter(Boolean));
if (!wanted.size) throw new Error("The manifest contains no valid Steam AppIDs.");

let nextRequestAt = 0;
const filters = [
  { id: "deck_verified", params: { deck_compatibility: "3" }, category: 3 },
  { id: "deck_playable", params: { deck_compatibility: "2" }, category: 2 },
  { id: "mac", params: { os: "mac" }, category: null },
];

const indexes = {};
for (const filter of filters) {
  indexes[filter.id] = await fetchIndex(filter);
}

const verified = indexes.deck_verified.appids;
const playable = indexes.deck_playable.appids;
const mac = indexes.mac.appids;
const results = [];
for (const steamAppId of [...wanted].sort((left, right) => left - right)) {
  const deckCompatibility = verified.has(steamAppId) ? 3 : playable.has(steamAppId) ? 2 : null;
  const platformMac = mac.has(steamAppId) ? true : null;
  if (deckCompatibility === null && platformMac === null) continue;
  results.push({
    steam_appid: steamAppId,
    platform_mac: platformMac,
    deck_compatibility: deckCompatibility,
    deck_checked_at: deckCompatibility === null ? null : new Date().toISOString(),
  });
}

const output = {
  schema_version: 1,
  source: "Steam Store official search filters",
  source_captured_at: new Date().toISOString(),
  manifest_path: manifestPath,
  manifest_rows: wanted.size,
  filters: Object.fromEntries(Object.entries(indexes).map(([id, index]) => [id, {
    reported_total: index.reportedTotal,
    fetched_unique_appids: index.appids.size,
    manifest_matches: [...index.appids].filter((appid) => wanted.has(appid)).length,
  }])),
  results,
};
await writeFile(outputPath, `${JSON.stringify(output)}\n`, "utf8");
console.log(JSON.stringify({
  stage: "steam_device_mode_index_complete",
  manifest_rows: wanted.size,
  result_rows: results.length,
  mac_matches: results.filter((row) => row.platform_mac).length,
  deck_verified_matches: results.filter((row) => row.deck_compatibility === 3).length,
  deck_playable_matches: results.filter((row) => row.deck_compatibility === 2).length,
  output_path: outputPath,
}));

async function fetchIndex(filter) {
  const first = await fetchPage(filter.params, 0);
  const starts = [];
  for (let start = count; start < first.totalCount; start += count) starts.push(start);
  const appids = new Set(first.appids);
  let completed = 1;
  for (let offset = 0; offset < starts.length; offset += concurrency) {
    const chunk = starts.slice(offset, offset + concurrency);
    const pages = await Promise.all(chunk.map((start) => fetchPage(filter.params, start)));
    for (const page of pages) for (const appid of page.appids) appids.add(appid);
    completed += chunk.length;
    if (completed % 25 <= concurrency || completed === starts.length + 1) {
      console.log(JSON.stringify({
        stage: "steam_device_mode_index_progress",
        filter: filter.id,
        completed_pages: completed,
        total_pages: starts.length + 1,
        unique_appids: appids.size,
      }));
    }
  }
  return { reportedTotal: first.totalCount, appids };
}

async function fetchPage(filterParams, start) {
  const url = new URL("https://store.steampowered.com/search/results/");
  url.search = new URLSearchParams({
    query: "",
    start: String(start),
    count: String(count),
    dynamic_data: "",
    sort_by: "Name_ASC",
    infinite: "1",
    ...filterParams,
  }).toString();
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await paceRequest();
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "VaultShuffle local device-mode index/1.0" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Steam search returned HTTP ${response.status}.`);
      const payload = await response.json();
      if (!payload?.success || typeof payload.results_html !== "string") throw new Error("Steam search returned an invalid payload.");
      return {
        totalCount: nonNegativeInteger(payload.total_count) ?? 0,
        appids: [...payload.results_html.matchAll(/data-ds-appid="(\d+)"/g)]
          .map((match) => positiveInteger(match[1])).filter(Boolean),
      };
    } catch (error) {
      lastError = error;
      if (attempt < 4) await delay(Math.min(30_000, 1_000 * 2 ** attempt));
    }
  }
  throw lastError ?? new Error("Steam search request failed.");
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
function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
