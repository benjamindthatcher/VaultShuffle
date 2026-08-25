import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const aliasPath = path.resolve(requiredArgument("--aliases"));
const outputPath = path.resolve(requiredArgument("--output"));
const reportIndex = process.argv.indexOf("--reports");
if (reportIndex === -1 || reportIndex === process.argv.length - 1) throw new Error("At least one --reports path is required.");
const reportPaths = process.argv.slice(reportIndex + 1).map((value) => path.resolve(value));
const knownPaths = stringArguments("--known").map((value) => path.resolve(value));
const aliasDocument = JSON.parse(await readFile(aliasPath, "utf8"));

const alternateOwners = new Map();
for (const row of aliasDocument.results ?? []) {
  const gameId = positiveInteger(row.igdb_game_id);
  if (!gameId) continue;
  for (const alias of uniqueStrings(row.alternate_aliases ?? [])) {
    const key = normalize(alias);
    const owners = alternateOwners.get(key) ?? new Set();
    owners.add(gameId);
    alternateOwners.set(key, owners);
  }
}

const identitiesByAppId = new Map();
for (const row of aliasDocument.results ?? []) {
  const steamAppId = positiveInteger(row.steam_appid);
  if (!steamAppId) continue;
  const canonicalAliases = uniqueStrings(row.canonical_aliases ?? []);
  const canonicalKeys = new Set(canonicalAliases.map((alias) => normalize(alias)));
  const safeAlternates = uniqueStrings(row.alternate_aliases ?? []).filter((alias) =>
    isSafeAlternate(alias, normalize(alias), canonicalKeys, alternateOwners)
  );
  const aliases = uniqueStrings([...canonicalAliases, ...safeAlternates]);
  identitiesByAppId.set(steamAppId, {
    normalized: new Set(aliases.map((alias) => normalize(alias)).filter(Boolean)),
    canonical: new Set(aliases.map((alias) => canonicalTitle(alias)).filter(Boolean)),
  });
}

const knownAppIds = new Set();
for (const knownPath of knownPaths) {
  const document = JSON.parse(await readFile(knownPath, "utf8"));
  for (const row of document.results ?? []) {
    const steamAppId = positiveInteger(row.steam_app_id ?? row.steam_appid);
    if (steamAppId && (row.match_status === "matched" || row.status === "matched")) knownAppIds.add(steamAppId);
  }
}

let reviewed = 0;
let identityValidated = 0;
const promotedByAppId = new Map();
for (const reportPath of reportPaths) {
  const rows = JSON.parse(await readFile(reportPath, "utf8"));
  if (!Array.isArray(rows)) throw new Error(`${reportPath} must contain a JSON array.`);
  for (const row of rows) {
    if (row.status !== "needs_review") continue;
    reviewed += 1;
    const steamAppId = positiveInteger(row.steam_appid);
    const providerGameId = positiveInteger(row.candidate_game_id);
    const candidateTitle = cleanText(row.candidate_title);
    const identities = identitiesByAppId.get(steamAppId);
    if (!steamAppId || !providerGameId || !candidateTitle || !identities || knownAppIds.has(steamAppId)) continue;
    const candidateNormalized = normalize(candidateTitle);
    const candidateCanonical = canonicalTitle(candidateTitle);
    if (!identities.normalized.has(candidateNormalized) && !identities.canonical.has(candidateCanonical)) continue;
    const durations = {
      main_story_minutes: positiveInteger(row.candidate_main_story_minutes),
      main_extra_minutes: positiveInteger(row.candidate_main_extra_minutes),
      completionist_minutes: positiveInteger(row.candidate_completionist_minutes),
    };
    if (!Object.values(durations).some(Boolean)) continue;
    identityValidated += 1;
    const current = promotedByAppId.get(steamAppId);
    if (current && Number(current.similarity) >= Number(row.candidate_similarity ?? 0)) continue;
    const now = new Date().toISOString();
    promotedByAppId.set(steamAppId, {
      steam_app_id: steamAppId,
      provider: "hltb",
      provider_game_id: providerGameId,
      ...durations,
      submission_count: null,
      match_status: "matched",
      match_confidence: "high",
      provider_updated_at: null,
      checked_at: now,
      next_refresh_at: null,
      last_error_code: null,
      updated_at: now,
      similarity: Number(row.candidate_similarity ?? 0),
      validated_title: candidateTitle,
    });
  }
}

const results = [...promotedByAppId.values()]
  .sort((left, right) => left.steam_app_id - right.steam_app_id)
  .map(({ similarity: _similarity, validated_title: _validatedTitle, ...row }) => row);
await writeFile(outputPath, `${JSON.stringify({
  schema_version: 1,
  source: "HLTB candidates validated against exact IGDB-to-Steam identities",
  reviewed_rows: reviewed,
  identity_validated_rows: identityValidated,
  matched_rows: results.length,
  results,
})}\n`, "utf8");
console.log(JSON.stringify({
  stage: "igdb_validated_hltb_candidates_complete",
  reviewed_rows: reviewed,
  identity_validated_rows: identityValidated,
  matched_rows: results.length,
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
function canonicalTitle(value) { return normalize(value); }
function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function requiredArgument(name) {
  const value = stringArgument(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
function stringArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}
function stringArguments(name) {
  const values = [];
  for (let index = 0; index < reportIndex; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values;
}
