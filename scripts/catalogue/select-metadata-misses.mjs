import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const manifestPath = path.resolve(process.argv[2] ?? "");
const metadataPath = path.resolve(process.argv[3] ?? "");
const outputPath = path.resolve(process.argv[4] ?? "");
const extraMetadataPaths = process.argv.slice(5).map((value) => path.resolve(value));
if (!process.argv[2] || !process.argv[3] || !process.argv[4]) {
  throw new Error("Usage: node select-metadata-misses.mjs <manifest.json> <metadata.json> <output.json>");
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
if (!Array.isArray(manifest.games) || !Array.isArray(metadata.results)) {
  throw new Error("Manifest games and metadata results must both be arrays.");
}
const covered = new Set(metadata.results.filter((row) => row.status === "ready").map((row) => Number(row.steam_appid)));
for (const extraPath of extraMetadataPaths) {
  const extra = JSON.parse(await readFile(extraPath, "utf8"));
  if (!Array.isArray(extra.results)) throw new Error(`${extraPath} must contain a results array.`);
  for (const row of extra.results) {
    if (row.status === "ready") covered.add(Number(row.steam_appid));
  }
}
const games = manifest.games.filter((game) => !covered.has(Number(game.steam_appid)));
const output = {
  ...manifest,
  source_manifest: manifestPath,
  exclusion_metadata: [metadataPath, ...extraMetadataPaths],
  requested_count: games.length,
  accepted_count: games.length,
  games
};
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ stage: "metadata_misses_ready", rows: games.length, output_path: outputPath }));
