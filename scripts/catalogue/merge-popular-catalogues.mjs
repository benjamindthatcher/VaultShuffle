import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertUniqueCohort, mergePopularCohorts, sha256 } from "./popular-catalogue-lib.mjs";

const [steamSpyInput, igdbInput] = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
if (!steamSpyInput || !igdbInput) {
  throw new Error("Usage: node scripts/catalogue/merge-popular-catalogues.mjs <steamspy.json> <igdb.json> [--output <path>]");
}
const steamSpy = JSON.parse(await readFile(steamSpyInput, "utf8"));
const igdb = JSON.parse(await readFile(igdbInput, "utf8"));
assertUniqueCohort(steamSpy.games, expectedCount(steamSpy, "SteamSpy"), "SteamSpy");
assertUniqueCohort(igdb.games, expectedCount(igdb, "IGDB"), "IGDB");

const merged = mergePopularCohorts(steamSpy.games, igdb.games);
const capturedAt = [steamSpy.captured_at, igdb.captured_at].sort().at(-1);
const outputPath = path.resolve(stringArgument("--output") ?? `data/catalogue/popular-appids-merged-${capturedAt}.json`);
const output = {
  schema_version: 1,
  captured_at: capturedAt,
  source_counts: { steamspy: steamSpy.games.length, igdb: igdb.games.length },
  overlap_count: merged.diagnostics.overlap,
  unique_count: merged.games.length,
  name_conflict_count: merged.diagnostics.name_conflicts.length,
  source_files: {
    steamspy: { path: steamSpyInput, sha256: sha256(await readFile(steamSpyInput)) },
    igdb: { path: igdbInput, sha256: sha256(await readFile(igdbInput)) }
  },
  games: merged.games
};
const serialized = `${JSON.stringify(output, null, 2)}\n`;
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, serialized, "utf8");

const conflictsPath = outputPath.replace(/\.json$/, ".name-conflicts.json");
await writeFile(conflictsPath, `${JSON.stringify(merged.diagnostics.name_conflicts, null, 2)}\n`, "utf8");
const reportPath = outputPath.replace(/\.json$/, ".quality.md");
await writeFile(reportPath, qualityReport(output, outputPath, conflictsPath), "utf8");
console.log(JSON.stringify({ stage: "merge_complete", output_path: outputPath, quality_report: reportPath, source_overlap: output.overlap_count, unique_rows: output.unique_count, sha256: sha256(serialized) }));

function qualityReport(result, manifestPath, conflictsPath) {
  const duplicateCount = result.games.length - new Set(result.games.map((game) => game.steam_appid)).size;
  const emptyNames = result.games.filter((game) => !String(game.name ?? "").trim()).length;
  return `# Popular catalogue data-quality report

- Capture date: ${result.captured_at}
- Grain: one row per Steam AppID
- SteamSpy cohort: ${result.source_counts.steamspy.toLocaleString()} rows
- IGDB cohort: ${result.source_counts.igdb.toLocaleString()} rows
- Cross-source overlap: ${result.overlap_count.toLocaleString()} AppIDs
- Deduplicated union: ${result.unique_count.toLocaleString()} AppIDs
- Duplicate AppIDs after merge: ${duplicateCount}
- Empty names after merge: ${emptyNames}
- Cross-source name conflicts: ${result.name_conflict_count.toLocaleString()}

## Quality gate

${duplicateCount === 0 && emptyNames === 0 ? "PASS" : "FAIL"}: the merged manifest is ${duplicateCount === 0 ? "unique by AppID" : "not unique by AppID"} and ${emptyNames === 0 ? "has a name for every row" : "contains empty names"}.

Steam AppID is authoritative for deduplication. Identical names on different AppIDs are retained; differing names for the same AppID use SteamSpy first and are preserved for review in the conflict artifact.

- Manifest: \`${manifestPath}\`
- Name conflicts: \`${conflictsPath}\`
`;
}

function stringArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function expectedCount(cohort, label) {
  const expected = Number(cohort.accepted_count ?? cohort.requested_count ?? cohort.games?.length);
  if (!Number.isSafeInteger(expected) || expected <= 0) {
    throw new Error(`${label} manifest does not declare a valid accepted count.`);
  }
  return expected;
}
