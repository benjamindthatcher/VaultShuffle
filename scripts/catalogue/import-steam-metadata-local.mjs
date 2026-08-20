import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const snapshotPath = stringArgument("--snapshot");
const livePath = stringArgument("--live");
const batchSource = stringArgument("--batch-source");
const batchSize = integerArgument("--batch-size", 250);
if (!snapshotPath || !batchSource) {
  throw new Error("Usage: node import-steam-metadata-local.mjs --snapshot <file.json> --batch-source <source> [--live <file.ndjson>]");
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
if (!Array.isArray(snapshot.results)) throw new Error("Snapshot input must contain a results array.");
const byAppId = new Map(snapshot.results.filter(isReadyRow).map((row) => [positiveInteger(row.steam_appid), row]));

let liveReadyRows = 0;
if (livePath) {
  const liveRows = (await readFile(livePath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  for (const row of liveRows) {
    if (!isReadyRow(row)) continue;
    byAppId.set(positiveInteger(row.steam_appid), row);
    liveReadyRows += 1;
  }
}

const eligibleAppIds = await loadEligibleAppIds();
const importedAppIds = [];
let imported = 0;
for (const batch of chunks([...byAppId.values()].filter((row) => eligibleAppIds.has(positiveInteger(row.steam_appid))), batchSize)) {
  const now = new Date().toISOString();
  const updates = batch.map((row) => catalogueUpdate(row.metadata, now));
  const { error: upsertError } = await supabase.from("catalog_games").upsert(updates, { onConflict: "steam_appid" });
  if (upsertError) throw upsertError;

  const appids = updates.map((row) => row.steam_appid);
  const { error: queueError } = await supabase.from("catalog_ingest_queue").update({
    status: "ready",
    processed_at: now,
    processing_started_at: null,
    next_attempt_at: null,
    last_error: null,
    rejection_reason: null,
    updated_at: now
  }).in("steam_appid", appids).contains("source_payload", { source: batchSource });
  if (queueError) throw queueError;

  importedAppIds.push(...appids);
  imported += appids.length;
  if (imported % (batchSize * 5) === 0 || imported === eligibleAppIds.size) {
    console.log(JSON.stringify({ stage: "steam_metadata_import_progress", imported, eligible: eligibleAppIds.size }));
  }
}

console.log(JSON.stringify({
  stage: "steam_metadata_import_complete",
  batch_source: batchSource,
  eligible: eligibleAppIds.size,
  source_rows: byAppId.size,
  live_ready_rows: liveReadyRows,
  imported,
  missing: eligibleAppIds.size - imported,
  imported_appids: importedAppIds.length
}));

async function loadEligibleAppIds() {
  const appids = new Set();
  for (let from = 0; ; from += 1_000) {
    const { data, error } = await supabase.from("catalog_ingest_queue")
      .select("steam_appid")
      .contains("source_payload", { source: batchSource })
      .order("steam_appid")
      .range(from, from + 999);
    if (error) throw error;
    for (const row of data ?? []) appids.add(positiveInteger(row.steam_appid));
    if ((data ?? []).length < 1_000) break;
  }
  appids.delete(null);
  return appids;
}

function catalogueUpdate(metadata, now) {
  const steamAppId = positiveInteger(metadata?.steam_appid);
  const name = cleanText(metadata?.name);
  if (!steamAppId || !name) throw new Error("A ready metadata row has an invalid AppID or name.");
  return {
    steam_appid: steamAppId,
    name,
    normalized_name: cleanText(metadata.normalized_name) || normalizeName(name) || name.toLowerCase(),
    steam_type: "game",
    developer: nullableText(metadata.developer),
    publisher: nullableText(metadata.publisher),
    genres: stringList(metadata.genres),
    categories: stringList(metadata.categories),
    short_description: nullableText(metadata.short_description),
    release_date: nullableText(metadata.release_date),
    is_free: Boolean(metadata.is_free),
    deck_compatibility: nullableInteger(metadata.deck_compatibility),
    deck_checked_at: nullableText(metadata.deck_checked_at),
    platform_windows: booleanOrNull(metadata.platform_windows),
    platform_mac: booleanOrNull(metadata.platform_mac),
    platform_linux: booleanOrNull(metadata.platform_linux),
    capsule_url: nullableText(metadata.capsule_url),
    header_url: nullableText(metadata.header_url),
    review_positive: nonNegativeInteger(metadata.review_positive) ?? 0,
    review_negative: nonNegativeInteger(metadata.review_negative) ?? 0,
    price_currency: cleanText(metadata.price_currency).toUpperCase() === "USD" ? "USD" : null,
    price_initial: nullableNonNegativeInteger(metadata.price_initial),
    price_final: nullableNonNegativeInteger(metadata.price_final),
    discount_percent: Math.max(0, Math.min(nonNegativeInteger(metadata.discount_percent) ?? 0, 100)),
    metadata_fetched_at: nullableText(metadata.metadata_fetched_at) || now,
    updated_at: now
  };
}

function isReadyRow(row) {
  return row?.status === "ready" && positiveInteger(row?.steam_appid) && row?.metadata;
}
function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
function nullableNonNegativeInteger(value) {
  return value == null ? null : nonNegativeInteger(value);
}
function nullableInteger(value) {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
function cleanText(value) {
  return String(value ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
}
function nullableText(value) {
  return cleanText(value) || null;
}
function normalizeName(value) {
  return cleanText(value).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function stringList(value) {
  return Array.isArray(value) ? value.map(cleanText).filter(Boolean) : [];
}
function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}
function chunks(values, size) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
}
function stringArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
function integerArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}
