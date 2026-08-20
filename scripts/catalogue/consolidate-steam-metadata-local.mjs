import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const inputPath = path.resolve(process.argv[2] ?? "");
const outputPath = path.resolve(process.argv[3] ?? "");
if (!process.argv[2] || !process.argv[3]) {
  throw new Error("Usage: node consolidate-steam-metadata-local.mjs <input.ndjson> <output.json>");
}

const rows = (await readFile(inputPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
const byAppId = new Map();
const unavailableAttempts = new Map();
for (const row of rows) {
  const steamAppId = positiveInteger(row.steam_appid);
  if (!steamAppId) continue;
  if (row.status === "unavailable") {
    unavailableAttempts.set(steamAppId, (unavailableAttempts.get(steamAppId) ?? 0) + 1);
  }
  const existing = byAppId.get(steamAppId);
  const existingTerminal = existing?.status === "ready" || existing?.status === "non_game";
  if (!existingTerminal || row.status === "ready" || row.status === "non_game") {
    byAppId.set(steamAppId, row);
  }
}

const results = [...byAppId.values()].map((row) => ({
  ...row,
  unavailable_attempts: unavailableAttempts.get(Number(row.steam_appid)) ?? 0
})).sort((left, right) => Number(left.steam_appid) - Number(right.steam_appid));
const counts = results.reduce((summary, row) => ({
  ...summary,
  [row.status]: (summary[row.status] ?? 0) + 1
}), {});
const output = {
  schema_version: 1,
  source: "VaultShuffle local Steam Store worker",
  source_path: inputPath,
  source_rows: rows.length,
  unique_appids: results.length,
  counts,
  results
};
await writeFile(outputPath, `${JSON.stringify(output)}\n`, "utf8");
console.log(JSON.stringify({
  stage: "steam_metadata_consolidated",
  source_rows: rows.length,
  unique_appids: results.length,
  counts,
  output_path: outputPath
}));

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
