import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseSteamSpyPage, sha256 } from "./popular-catalogue-lib.mjs";

const PAGE_SIZE = 1_000;
const TARGET_COUNT = integerArgument("--count", 10_000);
const MAX_PAGE_COUNT = integerArgument("--max-pages", Math.ceil(TARGET_COUNT / PAGE_SIZE) + 10);
const MIN_REQUEST_INTERVAL_MS = integerArgument("--interval-ms", 61_000);
const capturedAt = stringArgument("--captured-at") ?? new Date().toISOString().slice(0, 10);
const cacheDir = path.resolve("data/catalogue/.cache", `steamspy-owners-${capturedAt}`);
const outputPath = path.resolve(stringArgument("--output") ?? `data/catalogue/steamspy-top-${TARGET_COUNT}-owners-${capturedAt}.json`);

await mkdir(cacheDir, { recursive: true });
const games = [];
const pages = [];
const seenGames = new Map();
const pageOverlaps = [];
let lastRequestAt = 0;

for (let page = 0; games.length < TARGET_COUNT; page += 1) {
  if (page >= MAX_PAGE_COUNT) throw new Error(`SteamSpy did not yield ${TARGET_COUNT} unique AppIDs within ${MAX_PAGE_COUNT} pages.`);
  const sourceUrl = `https://steamspy.com/api.php?request=all&page=${page}`;
  const cachePath = path.join(cacheDir, `page-${String(page).padStart(3, "0")}.json`);
  let raw;
  let cached = false;
  try {
    raw = await readFile(cachePath, "utf8");
    cached = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const waitMs = Math.max(0, MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt));
    if (waitMs) {
      console.log(JSON.stringify({ stage: "steamspy_wait", page, wait_ms: waitMs }));
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    console.log(JSON.stringify({ stage: "steamspy_fetch", page, source_url: sourceUrl }));
    const response = await fetch(sourceUrl, {
      headers: { Accept: "application/json", "User-Agent": "VaultShuffle popular catalogue seed/2.0" },
      signal: AbortSignal.timeout(30_000)
    });
    lastRequestAt = Date.now();
    if (!response.ok) throw new Error(`SteamSpy page ${page} returned HTTP ${response.status}.`);
    raw = await response.text();
    JSON.parse(raw);
    await writeFile(cachePath, raw, "utf8");
  }

  const pageGames = parseSteamSpyPage(raw, page, PAGE_SIZE);
  let acceptedNew = 0;
  for (const game of pageGames) {
    const existing = seenGames.get(game.steam_appid);
    if (existing) {
      pageOverlaps.push({ steam_appid: game.steam_appid, kept_rank: existing.rank, repeated_rank: game.rank });
      continue;
    }
    seenGames.set(game.steam_appid, game);
    games.push(game);
    acceptedNew += 1;
  }
  pages.push({
    page,
    source_url: sourceUrl,
    sha256: sha256(raw),
    cached,
    source_rows: PAGE_SIZE,
    usable_rows: pageGames.length,
    skipped_rows: PAGE_SIZE - pageGames.length,
    accepted_new: acceptedNew
  });
  console.log(JSON.stringify({
    stage: "steamspy_page_ready",
    page,
    source_rows: PAGE_SIZE,
    usable_rows: pageGames.length,
    skipped_rows: PAGE_SIZE - pageGames.length,
    accepted_new: acceptedNew,
    unique_rows: games.length,
    cached
  }));
}

const acceptedGames = games.slice(0, TARGET_COUNT);

const output = {
  schema_version: 2,
  source: "SteamSpy",
  metric: "estimated_owners",
  captured_at: capturedAt,
  requested_count: TARGET_COUNT,
  accepted_count: acceptedGames.length,
  source_rows_scanned: pages.length * PAGE_SIZE,
  cross_page_duplicate_count: pageOverlaps.length,
  page_overlaps: pageOverlaps,
  page_size: PAGE_SIZE,
  page_count: pages.length,
  ranking_note: "SteamSpy request=all pages are returned in decreasing estimated-owner order; raw JSON order is preserved and repeated AppIDs from shifting live pages keep their first occurrence.",
  pages,
  games: acceptedGames
};
const serialized = `${JSON.stringify(output, null, 2)}\n`;
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, serialized, "utf8");
console.log(JSON.stringify({ stage: "steamspy_complete", output_path: outputPath, rows: acceptedGames.length, page_overlaps: pageOverlaps.length, sha256: sha256(serialized) }));

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
