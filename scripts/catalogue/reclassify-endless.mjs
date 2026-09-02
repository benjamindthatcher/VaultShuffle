/**
 * Ask the tags whether a game ends, for every game in the catalogue.
 *
 * The catalogue's answer was never really being computed. A HowLongToBeat match
 * writes duration_kind = 'finite', and HLTB has a main-story figure for almost
 * everything - Rainbow Six Siege is recorded at 3h19 - so across owned games every
 * one of the 16,292 HLTB matches came out finite. The 787 endless rows all came
 * from a hand-curated promotion list in a migration, and that list could only ever
 * touch rows HLTB had failed to match. So the tags were never asked.
 *
 * This asks them, using lib/game-classification.ts so the rule the report is built
 * from is the same one the app reads.
 *
 * PREVIEW BY DEFAULT. Nothing is written without --apply. The preview is the point:
 * a rule change here moves what 570 people are offered, and the sensible order is
 * read the report, spot-check the biggest movers, then apply.
 *
 *   node scripts/catalogue/reclassify-endless.mjs                  # report only
 *   node scripts/catalogue/reclassify-endless.mjs --with-hours     # + our own playtime witness
 *   node scripts/catalogue/reclassify-endless.mjs --apply          # write it
 *
 * Only ever promotes finite -> endless. It never demotes, and it never touches a
 * row carrying duration_manual_override, because a person has already ruled there.
 */

import { writeFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { endlessVerdict, endlessWitnessLabel } from "../../lib/game-classification.ts";

const APPLY = process.argv.includes("--apply");
const WITH_HOURS = process.argv.includes("--with-hours") || APPLY;
const REPORT_PATH = argumentValue("--out") ?? "data/exports/endless-reclassification.json";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

/** PostgREST caps a response at 1,000 rows, so every unbounded read pages. */
const PAGE_SIZE = 1000;

/**
 * Hours are read per ownership row and reduced here rather than in SQL: this
 * checkout must not run DDL against the project (see docs/vault-recommender.md on
 * the migration drift), so there is no RPC to lean on. 322,020 rows at a thousand
 * a page is a few hundred round trips and a couple of minutes.
 */
async function loadOwnerHours() {
  const hoursByAppId = new Map();

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("user_games")
      .select("id, catalog_steam_appid, hours_played")
      .not("catalog_steam_appid", "is", null)
      .gte("hours_played", 2)
      .order("id")
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;

    for (const row of data ?? []) {
      const appId = Number(row.catalog_steam_appid);
      const hours = Number(row.hours_played);
      if (!Number.isFinite(appId) || appId <= 0 || !Number.isFinite(hours)) continue;
      const held = hoursByAppId.get(appId);
      if (held) held.push(hours);
      else hoursByAppId.set(appId, [hours]);
    }

    if ((data ?? []).length < PAGE_SIZE) break;
    if (offset % 50_000 === 0 && offset) process.stderr.write(`  ...${offset} ownership rows\n`);
  }

  // Median rather than mean: one person with four thousand hours in a short game
  // is a completionist, and a mean lets them speak for everybody who owns it.
  const summary = new Map();
  for (const [appId, hours] of hoursByAppId) {
    hours.sort((left, right) => left - right);
    const middle = Math.floor(hours.length / 2);
    const median = hours.length % 2
      ? hours[middle]
      : (hours[middle - 1] + hours[middle]) / 2;
    summary.set(appId, { medianOwnerHours: median, engagedOwners: hours.length });
  }
  return summary;
}

async function loadOwnerCounts() {
  const counts = new Map();
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("user_games")
      .select("id, catalog_steam_appid")
      .not("catalog_steam_appid", "is", null)
      .order("id")
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    for (const row of data ?? []) {
      const appId = Number(row.catalog_steam_appid);
      if (Number.isFinite(appId) && appId > 0) counts.set(appId, (counts.get(appId) ?? 0) + 1);
    }
    if ((data ?? []).length < PAGE_SIZE) break;
  }
  return counts;
}

async function* catalogueRows() {
  const columns = [
    "steam_appid", "name", "tags", "genres", "categories",
    "main_story_minutes", "completionist_minutes",
    "duration_kind", "duration_source", "duration_status", "duration_manual_override",
    "steam_type"
  ].join(",");

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("catalog_games")
      .select(columns)
      .order("steam_appid")
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    for (const row of data ?? []) yield row;
    if ((data ?? []).length < PAGE_SIZE) break;
  }
}

process.stderr.write(`Reading the catalogue${WITH_HOURS ? " and everyone's hours" : ""}...\n`);
const ownerHours = WITH_HOURS ? await loadOwnerHours() : new Map();
const ownerCounts = await loadOwnerCounts();

const promotions = [];
const vetoed = [];
const counts = { seen: 0, alreadyEndless: 0, manual: 0, notAGame: 0, unchanged: 0 };
const byWitness = new Map();

for await (const row of catalogueRows()) {
  counts.seen += 1;
  const appId = Number(row.steam_appid);

  if (row.duration_kind === "endless") { counts.alreadyEndless += 1; continue; }
  // Demos, DLC and software are a different problem - see the quarantine notes in
  // docs/vault-recommender.md - and not one a length verdict should be guessing at.
  if (String(row.steam_type ?? "").toLowerCase() !== "game") { counts.notAGame += 1; continue; }

  const hours = ownerHours.get(appId) ?? {};
  const verdict = endlessVerdict({
    tags: row.tags,
    genres: row.genres,
    categories: row.categories,
    mainStoryMinutes: row.main_story_minutes,
    completionistMinutes: row.completionist_minutes,
    medianOwnerHours: hours.medianOwnerHours ?? null,
    engagedOwners: hours.engagedOwners ?? null,
    manualOverride: row.duration_manual_override === true
  });

  const entry = {
    steamAppId: appId,
    name: row.name,
    owners: ownerCounts.get(appId) ?? 0,
    was: { duration_kind: row.duration_kind, duration_source: row.duration_source },
    storyHours: row.main_story_minutes ? Number((row.main_story_minutes / 60).toFixed(1)) : null,
    completionistHours: row.completionist_minutes ? Number((row.completionist_minutes / 60).toFixed(1)) : null,
    medianOwnerHours: hours.medianOwnerHours ?? null,
    engagedOwners: hours.engagedOwners ?? null,
    witnesses: verdict.witnesses
  };

  if (verdict.vetoedBy === "manual-override") { counts.manual += 1; continue; }
  if (verdict.vetoedBy) { vetoed.push({ ...entry, vetoedBy: verdict.vetoedBy }); continue; }
  if (!verdict.endless) { counts.unchanged += 1; continue; }

  promotions.push(entry);
  for (const witness of verdict.witnesses) {
    byWitness.set(witness, (byWitness.get(witness) ?? 0) + 1);
  }
}

promotions.sort((left, right) => right.owners - left.owners || left.name.localeCompare(right.name));

const report = {
  generatedAt: new Date().toISOString(),
  mode: APPLY ? "apply" : "preview",
  hoursWitnessIncluded: WITH_HOURS,
  counts: { ...counts, promotions: promotions.length, vetoed: vetoed.length },
  byWitness: Object.fromEntries([...byWitness].sort((left, right) => right[1] - left[1])),
  promotions,
  vetoed: vetoed.slice(0, 200)
};

await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);

console.log(`\n${APPLY ? "APPLYING" : "PREVIEW"} — endless reclassification`);
console.log(`  catalogue rows read      ${counts.seen}`);
console.log(`  already endless          ${counts.alreadyEndless}`);
console.log(`  skipped, not a game      ${counts.notAGame}`);
console.log(`  skipped, manual ruling   ${counts.manual}`);
console.log(`  left finite              ${counts.unchanged}`);
console.log(`  vetoed by a story tag    ${vetoed.length}`);
console.log(`  WOULD PROMOTE            ${promotions.length}`);
console.log(`\nby witness (a game can have more than one):`);
for (const [witness, total] of report.byWitness ? Object.entries(report.byWitness) : []) {
  console.log(`  ${String(total).padStart(6)}  ${witness.padEnd(20)} ${endlessWitnessLabel(witness)}`);
}
console.log(`\nthe 25 most widely owned games this would change:`);
for (const entry of promotions.slice(0, 25)) {
  const story = entry.storyHours === null ? "  —  " : `${String(entry.storyHours).padStart(5)}h`;
  console.log(`  ${String(entry.owners).padStart(4)} owners  ${story} story  ${entry.name.slice(0, 46).padEnd(46)} ${entry.witnesses.join(", ")}`);
}
console.log(`\nfull report: ${REPORT_PATH}`);

if (!APPLY) {
  console.log(`\nNothing was written. Re-run with --apply once the list above looks right.`);
  process.exit(0);
}

let written = 0;
for (const batch of chunks(promotions, 200)) {
  // The HLTB minutes are kept rather than nulled, which is where this differs from
  // the migration that promoted the original 787. Those rows had no match to keep;
  // these have a real figure that was merely being read as a finish line. Nothing
  // reads the minutes once duration_kind is endless - isEndlessGame short-circuits
  // and deriveSessionFits opens every session - so keeping them costs nothing and
  // makes this reversible from the report.
  const { error } = await supabase
    .from("catalog_games")
    .update({
      duration_kind: "endless",
      duration_source: "classification",
      duration_status: "ready",
      duration_confidence: "medium",
      duration_source_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .in("steam_appid", batch.map((entry) => entry.steamAppId))
    .neq("duration_manual_override", true);
  if (error) throw error;
  written += batch.length;
  process.stderr.write(`  ...${written}/${promotions.length}\n`);
}

console.log(`\nPromoted ${written} games to endless. The report holds the previous`);
console.log(`duration_kind for every one of them, so this is reversible.`);

function chunks(items, size) {
  const out = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
