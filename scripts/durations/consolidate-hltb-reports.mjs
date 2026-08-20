import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const outputIndex = process.argv.indexOf("--output");
if (outputIndex === -1 || !process.argv[outputIndex + 1]) {
  throw new Error("Usage: node consolidate-hltb-reports.mjs <report...> --output <file.json>");
}
const outputPath = path.resolve(process.argv[outputIndex + 1]);
const inputPaths = process.argv.slice(2, outputIndex).map((value) => path.resolve(value));
if (!inputPaths.length) throw new Error("At least one HLTB report is required.");

const byAppId = new Map();
const counts = {};
let sourceRows = 0;
for (const inputPath of inputPaths) {
  const rows = JSON.parse(await readFile(inputPath, "utf8"));
  if (!Array.isArray(rows)) throw new Error(`${inputPath} must contain a JSON array.`);
  for (const row of rows) {
    sourceRows += 1;
    const status = row.match_status === "matched" ? "matched" : String(row.status ?? "unknown");
    counts[status] = (counts[status] ?? 0) + 1;
    const steamAppId = positiveInteger(row.steam_app_id ?? row.steam_appid);
    if (!steamAppId || row.match_status !== "matched" || row.provider !== "hltb") continue;
    byAppId.set(steamAppId, {
      steam_app_id: steamAppId,
      provider: "hltb",
      provider_game_id: positiveInteger(row.provider_game_id),
      main_story_minutes: positiveInteger(row.main_story_minutes),
      main_extra_minutes: positiveInteger(row.main_extra_minutes),
      completionist_minutes: positiveInteger(row.completionist_minutes),
      submission_count: null,
      match_status: "matched",
      match_confidence: "high",
      provider_updated_at: null,
      checked_at: row.checked_at,
      next_refresh_at: null,
      last_error_code: null,
      updated_at: row.updated_at,
    });
  }
}

const results = [...byAppId.values()].sort((left, right) => left.steam_app_id - right.steam_app_id);
await writeFile(outputPath, `${JSON.stringify({
  schema_version: 1,
  source: "HowLongToBeat local high-confidence fallback",
  consolidated_at: new Date().toISOString(),
  source_files: inputPaths,
  source_rows: sourceRows,
  counts,
  matched_rows: results.length,
  results,
})}\n`, "utf8");
console.log(JSON.stringify({
  stage: "hltb_reports_consolidated",
  source_files: inputPaths.length,
  source_rows: sourceRows,
  counts,
  matched_rows: results.length,
  output_path: outputPath,
}));

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
