import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const inputPath = process.argv[2];
const source = argumentValue("--source");
if (!inputPath || !source) {
  throw new Error("Usage: npm run catalogue:import-durations -- <file.json> --source <licensed-provider>");
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}

const payload = JSON.parse(await readFile(inputPath, "utf8"));
const rawRows = Array.isArray(payload) ? payload : payload.games;
if (!Array.isArray(rawRows)) throw new Error("Duration import must be an array or an object with a games array.");

const rows = rawRows.map(validateRow);
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

let importedCount = 0;
let skippedCount = 0;
const importedAppids = [];

for (const batch of chunks(rows, 100)) {
  const appids = batch.map((row) => row.steam_appid);
  const { data: existing, error: lookupError } = await supabase
    .from("catalog_games")
    .select("steam_appid")
    .in("steam_appid", appids);
  if (lookupError) throw lookupError;

  const knownAppids = new Set((existing ?? []).map((row) => Number(row.steam_appid)));
  const updates = batch.filter((row) => knownAppids.has(row.steam_appid));
  skippedCount += batch.length - updates.length;

  for (const row of updates) {
    const { error } = await supabase
      .from("catalog_games")
      .update({
        main_story_minutes: row.main_story_minutes,
        main_extras_minutes: row.main_extras_minutes,
        completionist_minutes: row.completionist_minutes,
        duration_source: source,
        duration_source_game_id: row.source_game_id,
        duration_source_updated_at: row.source_updated_at,
        duration_confidence: row.confidence,
        duration_status: "ready",
        updated_at: new Date().toISOString()
      })
      .eq("steam_appid", row.steam_appid);
    if (error) throw error;
    importedAppids.push(row.steam_appid);
    importedCount += 1;
  }
}

if (importedAppids.length) {
  const { error } = await supabase.rpc("sync_catalog_duration_to_user_games", { p_appids: importedAppids });
  if (error) throw error;
}

const { error: auditError } = await supabase.from("catalog_duration_import_runs").insert({
  source,
  imported_count: importedCount,
  skipped_count: skippedCount,
  source_updated_at: newestSourceDate(rows)
});
if (auditError) throw auditError;

console.log(JSON.stringify({ source, imported: importedCount, skipped: skippedCount }, null, 2));

function validateRow(row, index) {
  const steamAppid = Number(row.steam_appid);
  if (!Number.isSafeInteger(steamAppid) || steamAppid <= 0) {
    throw new Error(`Row ${index + 1}: steam_appid must be a positive integer.`);
  }
  const durations = {
    main_story_minutes: minutes(row.main_story_minutes, index, "main_story_minutes"),
    main_extras_minutes: minutes(row.main_extras_minutes, index, "main_extras_minutes"),
    completionist_minutes: minutes(row.completionist_minutes, index, "completionist_minutes")
  };
  if (!Object.values(durations).some((value) => value !== null)) {
    throw new Error(`Row ${index + 1}: at least one duration estimate is required.`);
  }
  const confidence = row.confidence ?? null;
  if (confidence !== null && !["low", "medium", "high"].includes(confidence)) {
    throw new Error(`Row ${index + 1}: confidence must be low, medium, high or null.`);
  }
  const sourceUpdatedAt = row.source_updated_at ? new Date(row.source_updated_at) : new Date();
  if (Number.isNaN(sourceUpdatedAt.valueOf())) throw new Error(`Row ${index + 1}: invalid source_updated_at.`);
  return {
    steam_appid: steamAppid,
    source_game_id: row.source_game_id ? String(row.source_game_id) : null,
    source_updated_at: sourceUpdatedAt.toISOString(),
    confidence,
    ...durations
  };
}

function minutes(value, index, field) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Row ${index + 1}: ${field} must be a positive whole number of minutes.`);
  }
  return parsed;
}

function newestSourceDate(rows) {
  if (!rows.length) return null;
  return rows.reduce((latest, row) => row.source_updated_at > latest ? row.source_updated_at : latest, rows[0].source_updated_at);
}

function chunks(values, size) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
