import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validSteamAppId } from "../catalogue/popular-catalogue-lib.mjs";

export function buildHltbInput(source) {
  const rows = Array.isArray(source) ? source : source?.games;
  if (!Array.isArray(rows)) throw new Error("Provide a Steam catalogue array or an object with a games array.");
  const byAppId = new Map();
  for (const row of rows) {
    const steamAppId = validSteamAppId(row?.steam_appid);
    const name = cleanText(row?.name);
    if (!steamAppId || !name) continue;
    // A prior provider's match status is not evidence of an HLTB match.
    // HLTB's own checkpointed --resume workflow handles completed lookups.
    byAppId.set(steamAppId, { steam_appid: steamAppId, name });
  }
  return [...byAppId.values()].sort((left, right) => left.steam_appid - right.steam_appid);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const sourceArgument = stringArgument("--source");
  if (!sourceArgument) throw new Error("Usage: node scripts/durations/build-hltb-input.mjs --source <steam-catalogue.json> [--output <hltb-input.json>]");
  const outputPath = path.resolve(stringArgument("--output") ?? "data/catalogue/hltb-input.json");
  const source = JSON.parse(await readFile(path.resolve(sourceArgument), "utf8"));
  const games = buildHltbInput(source);
  await writeFile(outputPath, `${JSON.stringify(games)}\n`, "utf8");
  console.log(JSON.stringify({ stage: "hltb_input_complete", input_rows: games.length, output_path: outputPath }));
}

function stringArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}
function cleanText(value) {
  return String(value ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
}
