import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const manifestPath = path.resolve(requiredArgument("--manifest"));
const cacheDir = path.resolve(requiredArgument("--cache-dir"));
const outputPath = path.resolve(requiredArgument("--output"));
const excludePath = stringArgument("--exclude");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (!Array.isArray(manifest.games)) throw new Error("The manifest must contain a games array.");
const excluded = new Set();
if (excludePath) {
  const exclude = JSON.parse(await readFile(path.resolve(excludePath), "utf8"));
  for (const row of exclude.results ?? []) {
    if (row.status === "ready") excluded.add(positiveInteger(row.steam_appid));
  }
}
const wanted = new Set(manifest.games.map((game) => positiveInteger(game.steam_appid)).filter(Boolean));
const results = new Map();
let duplicateSourceRows = 0;

const pageFiles = (await readdir(cacheDir)).filter((name) => /^page-\d+\.json$/.test(name)).sort();
for (const pageFile of pageFiles) {
  const page = JSON.parse(await readFile(path.join(cacheDir, pageFile), "utf8"));
  for (const raw of Object.values(page)) {
    const steamAppId = positiveInteger(raw?.appid);
    const name = cleanText(raw?.name);
    if (!steamAppId || !wanted.has(steamAppId) || excluded.has(steamAppId) || !name) continue;
    if (results.has(steamAppId)) {
      duplicateSourceRows += 1;
      continue;
    }
    const priceFinal = nullableNonNegativeInteger(raw?.price);
    const priceInitial = nullableNonNegativeInteger(raw?.initialprice);
    const genres = cleanText(raw?.genre).split(",").map(cleanText).filter(Boolean);
    const isFree = priceFinal === 0 && genres.some((genre) => genre.toLowerCase() === "free to play");
    const fetchedAt = new Date().toISOString();
    results.set(steamAppId, {
      steam_appid: steamAppId,
      source_name: name,
      status: "ready",
      source: "SteamSpy owner-ranked all-page metadata",
      source_captured_at: manifest.captured_at ?? null,
      metadata: {
        steam_appid: steamAppId,
        name,
        normalized_name: normalizeName(name) || name.toLowerCase(),
        steam_type: "game",
        developer: nullableText(raw?.developer),
        publisher: nullableText(raw?.publisher),
        genres,
        categories: [],
        short_description: null,
        release_date: null,
        is_free: isFree,
        capsule_url: `https://cdn.akamai.steamstatic.com/steam/apps/${steamAppId}/library_600x900_2x.jpg`,
        header_url: `https://cdn.akamai.steamstatic.com/steam/apps/${steamAppId}/header.jpg`,
        review_positive: nonNegativeInteger(raw?.positive) ?? 0,
        review_negative: nonNegativeInteger(raw?.negative) ?? 0,
        review_total: (nonNegativeInteger(raw?.positive) ?? 0) + (nonNegativeInteger(raw?.negative) ?? 0),
        price_currency: priceFinal && priceFinal > 0 ? "USD" : null,
        price_initial: priceInitial && priceInitial > 0 ? priceInitial : null,
        price_final: priceFinal && priceFinal > 0 ? priceFinal : null,
        discount_percent: clamp(nonNegativeInteger(raw?.discount) ?? 0, 0, 100),
        platform_windows: null,
        platform_mac: null,
        platform_linux: null,
        deck_compatibility: null,
        deck_checked_at: null,
        metadata_fetched_at: fetchedAt,
        updated_at: fetchedAt
      }
    });
  }
}

const output = {
  schema_version: 1,
  source: "SteamSpy owner-ranked all-page metadata",
  source_captured_at: manifest.captured_at ?? null,
  manifest_path: manifestPath,
  cache_dir: cacheDir,
  manifest_rows: wanted.size,
  excluded_rows: excluded.size,
  matched_rows: results.size,
  duplicate_source_rows: duplicateSourceRows,
  results: [...results.values()].sort((left, right) => left.steam_appid - right.steam_appid)
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output)}\n`, "utf8");
console.log(JSON.stringify({
  stage: "steamspy_metadata_extract_complete",
  manifest_rows: wanted.size,
  excluded_rows: excluded.size,
  matched_rows: results.size,
  duplicate_source_rows: duplicateSourceRows,
  output_path: outputPath
}));

function requiredArgument(name) {
  const value = stringArgument(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
function stringArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}
function nullableNonNegativeInteger(value) {
  if (value == null || value === "") return null;
  return nonNegativeInteger(value);
}
function cleanText(value) {
  return String(value ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
}
function nullableText(value) {
  return cleanText(value) || null;
}
function normalizeName(value) {
  return cleanText(value).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}
