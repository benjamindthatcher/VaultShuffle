import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const sourcePath = path.resolve(stringArgument("--source") ?? "data/catalogue/igdb-durations-expanded-local-2026-08-20.json");
const outputPath = path.resolve(stringArgument("--output") ?? "data/catalogue/hltb-unresolved-input-2026-08-20.json");
const source = JSON.parse(await readFile(sourcePath, "utf8"));
if (!Array.isArray(source.results)) throw new Error("The IGDB duration source must contain a results array.");

const byAppId = new Map();
for (const row of source.results) {
  const steamAppId = positiveInteger(row.steam_appid);
  const name = cleanText(row.name);
  if (!steamAppId || !name || row.status === "matched") continue;
  byAppId.set(steamAppId, { steam_appid: steamAppId, name });
}
const games = [...byAppId.values()].sort((left, right) => left.steam_appid - right.steam_appid);
await writeFile(outputPath, `${JSON.stringify(games)}\n`, "utf8");
console.log(JSON.stringify({
  stage: "hltb_input_complete",
  source_rows: source.results.length,
  unresolved_rows: games.length,
  output_path: outputPath,
}));

function stringArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}
function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function cleanText(value) {
  return String(value ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
}
