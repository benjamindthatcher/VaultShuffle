#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function normalized(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function sqlNumber(value) {
  if (value === null || value === undefined || value === "") return "null";
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid numeric migration value: ${value}`);
  return String(Math.round(number));
}

const inputPath = argument("--input");
const outputPath = argument("--output");
if (!inputPath || !outputPath) {
  throw new Error("Usage: generate-hltb-migration.mjs --input report.json --output migration.sql");
}

const report = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const accepted = [];
const skipped = [];

for (const item of report) {
  const directMatch = item.match_status === "matched" || item.status === "matched";
  const exactReviewMatch =
    item.status === "needs_review" &&
    normalized(item.candidate_title) !== "" &&
    [item.searched_as, item.title].some(
      (candidate) => normalized(candidate) === normalized(item.candidate_title),
    );

  if (!directMatch && !exactReviewMatch) {
    skipped.push(item);
    continue;
  }

  accepted.push({
    steamAppId: item.steam_app_id ?? item.steam_appid,
    providerGameId: directMatch ? item.provider_game_id : item.candidate_game_id,
    mainStoryMinutes: directMatch
      ? item.main_story_minutes
      : item.candidate_main_story_minutes,
    mainExtraMinutes: directMatch
      ? item.main_extra_minutes
      : item.candidate_main_extra_minutes,
    completionistMinutes: directMatch
      ? item.completionist_minutes
      : item.candidate_completionist_minutes,
  });
}

const deduplicated = [
  ...new Map(accepted.map((item) => [Number(item.steamAppId), item])).values(),
].sort((left, right) => Number(left.steamAppId) - Number(right.steamAppId));

if (!deduplicated.length) throw new Error("No exact HLTB matches were found in the report.");

const values = deduplicated
  .map(
    (item) =>
      `  (${sqlNumber(item.steamAppId)}, 'hltb', ${sqlNumber(item.providerGameId)}, ` +
      `${sqlNumber(item.mainStoryMinutes)}, ${sqlNumber(item.mainExtraMinutes)}, ` +
      `${sqlNumber(item.completionistMinutes)}, null, 'matched', 'high', now(), ` +
      `now() + interval '365 days', null, now())`,
  )
  .join(",\n");

const appIds = deduplicated.map((item) => sqlNumber(item.steamAppId)).join(", ");
const sql = `-- Generated from exact-title HowLongToBeat matches. Ambiguous candidates are
-- deliberately excluded and remain in the explicit duration review queue.
insert into public.game_duration_estimates (
  steam_app_id,
  provider,
  provider_game_id,
  main_story_minutes,
  main_extra_minutes,
  completionist_minutes,
  submission_count,
  match_status,
  match_confidence,
  checked_at,
  next_refresh_at,
  last_error_code,
  updated_at
)
values
${values}
on conflict (steam_app_id, provider) do update
set provider_game_id = excluded.provider_game_id,
    main_story_minutes = excluded.main_story_minutes,
    main_extra_minutes = excluded.main_extra_minutes,
    completionist_minutes = excluded.completionist_minutes,
    submission_count = excluded.submission_count,
    match_status = excluded.match_status,
    match_confidence = excluded.match_confidence,
    checked_at = excluded.checked_at,
    next_refresh_at = excluded.next_refresh_at,
    last_error_code = excluded.last_error_code,
    updated_at = excluded.updated_at;

update public.game_duration_jobs
set status = 'completed',
    locked_at = null,
    locked_by = null,
    last_error_code = null,
    last_error_message = null,
    updated_at = now()
where steam_app_id in (${appIds});
`;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, sql);
console.log(
  JSON.stringify(
    {
      accepted: deduplicated.length,
      skipped: skipped.length,
      output: outputPath,
    },
    null,
    2,
  ),
);
