import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const COUNT = 1000;
const SOURCE_URL = "https://steamspy.com/api.php?request=all&page=0";
const capturedAt = new Date().toISOString().slice(0, 10);
const response = await fetch(SOURCE_URL, { headers: { "User-Agent": "VaultShuffle catalogue seed/1.0" } });
if (!response.ok) throw new Error(`SteamSpy returned HTTP ${response.status}.`);
const raw = await response.text();
const parsed = JSON.parse(raw);

// Numeric object keys are re-enumerated by JavaScript. Read their source order
// before lookup so the published owners ranking is preserved exactly.
const orderedAppIds = [...raw.matchAll(/"(\d+)":\{/g)].map((match) => match[1]);
if (orderedAppIds.length !== COUNT) throw new Error(`Expected ${COUNT} ranked entries, received ${orderedAppIds.length}.`);
if (new Set(orderedAppIds).size !== COUNT) throw new Error("SteamSpy response contains duplicate AppIDs.");

const games = orderedAppIds.map((key, index) => {
  const item = parsed[key];
  if (!item || Number(item.appid) !== Number(key)) throw new Error(`Malformed SteamSpy row for AppID ${key}.`);
  const [popularityLow, popularityHigh] = ownerBounds(item.owners);
  return {
    rank: index + 1,
    steam_appid: Number(key),
    name: String(item.name || "").trim(),
    developer: nullableText(item.developer),
    publisher: nullableText(item.publisher),
    positive: nonNegativeInteger(item.positive),
    negative: nonNegativeInteger(item.negative),
    popularity_low: popularityLow,
    popularity_high: popularityHigh,
    popularity_ccu: nonNegativeInteger(item.ccu),
    price_final: nonNegativeInteger(item.price),
    price_initial: nonNegativeInteger(item.initialprice),
    discount_percent: clamp(nonNegativeInteger(item.discount), 0, 100),
    source: "SteamSpy",
    metric: "estimated_owners",
    source_url: SOURCE_URL,
    captured_at: capturedAt
  };
});

const output = {
  schema_version: 1,
  source: "SteamSpy",
  metric: "estimated_owners",
  source_url: SOURCE_URL,
  captured_at: capturedAt,
  requested_count: COUNT,
  source_sha256: createHash("sha256").update(raw).digest("hex"),
  notes: "SteamSpy documents request=all&page=0 as 1,000 games sorted by estimated owners. Rank preserves raw JSON source order.",
  games
};

const outputDir = path.resolve("data/catalogue");
await mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, `steam-top-${COUNT}-owners-${capturedAt}.json`);
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, count: games.length, first: games[0], last: games.at(-1), source_sha256: output.source_sha256 }, null, 2));

function ownerBounds(value) {
  const matches = String(value || "").match(/[\d,]+/g) || [];
  if (matches.length !== 2) return [null, null];
  return matches.map((part) => Number(part.replaceAll(",", "")));
}
function nullableText(value) { const text = String(value || "").trim(); return text || null; }
function nonNegativeInteger(value) { const number = Number(value); return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0; }
function clamp(value, min, max) { return Math.max(min, Math.min(value, max)); }
