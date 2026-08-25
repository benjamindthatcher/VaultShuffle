import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const sourcePath = path.resolve(stringArgument("--source") ?? "/private/tmp/vaultshuffle-igdb-hltb-aliases-2026-08-24.json");
const outputPath = path.resolve(stringArgument("--output") ?? "/private/tmp/vaultshuffle-hltb-igdb-alias-input.json");
const aliasKind = stringArgument("--alias-kind") ?? "canonical";
if (!new Set(["canonical", "alternate"]).has(aliasKind)) throw new Error("--alias-kind must be canonical or alternate.");
const knownPaths = stringArguments("--known").map((value) => path.resolve(value));
const source = JSON.parse(await readFile(sourcePath, "utf8"));
if (!Array.isArray(source.results)) throw new Error("The IGDB alias source must contain a results array.");

const knownAppIds = new Set();
for (const knownPath of knownPaths) {
  const document = JSON.parse(await readFile(knownPath, "utf8"));
  for (const row of document.results ?? []) {
    const steamAppId = positiveInteger(row.steam_app_id ?? row.steam_appid);
    if (steamAppId && (row.match_status === "matched" || row.status === "matched")) knownAppIds.add(steamAppId);
  }
}

const alternateOwners = new Map();
for (const row of source.results) {
  const gameId = positiveInteger(row.igdb_game_id);
  if (!gameId) continue;
  for (const alias of uniqueStrings(row.alternate_aliases ?? [])) {
    const key = normalize(alias);
    const owners = alternateOwners.get(key) ?? new Set();
    owners.add(gameId);
    alternateOwners.set(key, owners);
  }
}

const byAppId = new Map();
for (const row of source.results) {
  const steamAppId = positiveInteger(row.steam_appid);
  const steamName = cleanText(row.steam_name);
  if (!steamAppId || !steamName || knownAppIds.has(steamAppId)) continue;
  const steamNormalized = normalize(steamName);
  const steamCanonical = canonicalTitle(steamName);
  const canonicalKeys = new Set(uniqueStrings(row.canonical_aliases ?? []).map((alias) => normalize(alias)));
  const sourceAliases = aliasKind === "alternate" ? row.alternate_aliases : row.canonical_aliases;
  const aliases = uniqueStrings(sourceAliases ?? []).filter((alias) => {
    const aliasNormalized = normalize(alias);
    const aliasCanonical = canonicalTitle(alias);
    return aliasNormalized
      && aliasNormalized !== steamNormalized
      && (!aliasCanonical || !steamCanonical || aliasCanonical !== steamCanonical)
      && (aliasKind !== "alternate" || isSafeAlternate(alias, aliasNormalized, canonicalKeys, alternateOwners));
  });
  if (!aliases.length) continue;
  byAppId.set(steamAppId, {
    steam_appid: steamAppId,
    name: steamName,
    aliases,
    igdb_game_id: positiveInteger(row.igdb_game_id),
  });
}

const games = [...byAppId.values()].sort((left, right) => left.steam_appid - right.steam_appid);
await writeFile(outputPath, `${JSON.stringify(games)}\n`, "utf8");
console.log(JSON.stringify({
  stage: "igdb_hltb_alias_input_complete",
  alias_kind: aliasKind,
  source_rows: source.results.length,
  known_duration_appids: knownAppIds.size,
  candidate_games: games.length,
  candidate_aliases: games.reduce((total, game) => total + game.aliases.length, 0),
  output_path: outputPath,
}));

function isSafeAlternate(alias, normalizedAlias, canonicalKeys, ownersByAlias) {
  const tokens = normalizedAlias.split(" ").filter(Boolean);
  if (tokens.length < 2 || normalizedAlias.length < 7) return false;
  if ((ownersByAlias.get(normalizedAlias)?.size ?? 0) !== 1) return false;
  if (canonicalKeys.has(normalizedAlias)) return false;
  if (/[\\/]|\.(?:exe|bat|cmd|com|app|jar|sh|bin|dll|x86|x64)(?:\s|$)/i.test(alias)) return false;
  if (/\b(?:launcher|launch|autorun|executable|shipping|gameclient|dedicated server)\b/i.test(alias)) return false;
  if (/^(?:the\s+)?(?:game|player|client|server|editor|setup|start|boot|build|project|main)(?:\s+\w+)?$/i.test(alias)) return false;
  if (/^(?:collector(?:'s|s)?|deluxe|gold|complete|ultimate|enhanced|anniversary|premium|steam|special|platinum)\s+edition$/i.test(alias)) return false;
  return true;
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
function canonicalTitle(value) {
  const roman = new Map([["i", "1"], ["ii", "2"], ["iii", "3"], ["iv", "4"], ["v", "5"], ["vi", "6"], ["vii", "7"], ["viii", "8"], ["ix", "9"], ["x", "10"]]);
  return normalize(value)
    .replace(/^(?:sid meier s|disney pixar)\s+/, "")
    .split(" ")
    .map((token) => roman.get(token) ?? token)
    .join(" ")
    .replace(/\s+(?:(?:\d+(?:st|nd|rd|th)\s+)?anniversary\s+edition|game\s+of\s+the\s+(?:year|decade)\s+edition|(?:[a-z]+\s+){0,2}edition|hd|remaster(?:ed)?|redux|deluxe|ultimate|gold)$/i, "")
    .trim();
}
function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function stringArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}
function stringArguments(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values;
}
