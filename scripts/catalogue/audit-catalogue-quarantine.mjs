/**
 * Read-only audit of the catalogue against Steam's PICS records.
 *
 * `catalog_games` carries a `steam_type = 'game'` check constraint, so every row
 * in it claims to be a game whatever it actually is. The true type only ever
 * reaches the quarantine row, which means the catalogue cannot be re-checked
 * against itself - a rule change needs a fresh pass over Steam.
 *
 * This writes nothing. It prints the disagreements between what Steam says and
 * what the quarantine currently does, so a rule change can be reviewed before
 * anything is applied.
 *
 *   node scripts/catalogue/audit-catalogue-quarantine.mjs
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the
 * environment or in .env.local.
 */
import fs from "node:fs";
import path from "node:path";

const PICS_ENDPOINT = "https://api.steamcmd.net/v1/info";
const CONCURRENCY = 24;

// Types Steam gets right. `advertising`, `mod`, `video`, `series` and `episode`
// are deliberately absent: each one mislabels real games often enough to be
// useless as a verdict. See docs/catalogue-quarantine.md.
const NON_GAME_TYPES = new Set([
  "dlc", "demo", "application", "tool", "hardware", "beta", "config", "music", "video", "media"
]);

function loadEnv() {
  const file = path.join(process.cwd(), ".env.local");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const at = line.indexOf("=");
      if (at <= 0) continue;
      const key = line.slice(0, at).trim();
      if (!process.env[key]) process.env[key] = line.slice(at + 1).trim();
    }
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  return { url, key };
}

async function readAll({ url, key }, table, select) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(
      `${url}/rest/v1/${table}?select=${select}&order=steam_appid.asc&limit=1000&offset=${offset}`,
      { headers: { apikey: key, authorization: `Bearer ${key}` } }
    );
    if (!res.ok) throw new Error(`${res.status} reading ${table}: ${(await res.text()).slice(0, 200)}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

async function steamType(appid) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${PICS_ENDPOINT}/${appid}`, {
        headers: { "user-agent": "VaultShuffle-catalogue-audit/1.0" },
        signal: AbortSignal.timeout(25_000)
      });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((done) => setTimeout(done, 2000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return null;
      const common = (await res.json())?.data?.[String(appid)]?.common;
      return common?.type ? String(common.type).toLowerCase() : null;
    } catch {
      if (attempt === 2) return null;
      await new Promise((done) => setTimeout(done, 1500 * (attempt + 1)));
    }
  }
  return null;
}

const env = loadEnv();
const [catalogue, quarantine] = await Promise.all([
  readAll(env, "catalog_games", "steam_appid,name"),
  readAll(env, "catalog_game_quarantine", "steam_appid,review_status,matched_rule,source")
]);
const decisions = new Map(quarantine.map((row) => [row.steam_appid, row]));
console.error(`Checking ${catalogue.length} catalogue rows against Steam…`);

const types = new Map();
let done = 0;
let cursor = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (cursor < catalogue.length) {
    const row = catalogue[cursor++];
    types.set(row.steam_appid, await steamType(row.steam_appid));
    if (++done % 2000 === 0) console.error(`  ${done}/${catalogue.length}`);
  }
}));

const hidden = (appid) => decisions.get(appid)?.review_status === "excluded";
const visibleNonGames = [];
const hiddenGames = [];
for (const row of catalogue) {
  const type = types.get(row.steam_appid);
  if (!type) continue;
  if (NON_GAME_TYPES.has(type) && !hidden(row.steam_appid)) visibleNonGames.push([row, type]);
  // Steam types plenty of software as `game` (Wallpaper Engine, RetroArch), so
  // this half of the report is a prompt to look, never a verdict on its own.
  if (type === "game" && hidden(row.steam_appid)) hiddenGames.push([row, decisions.get(row.steam_appid)]);
}

console.log(`\nNon-games Steam reports that are still visible: ${visibleNonGames.length}`);
for (const [row, type] of visibleNonGames) {
  console.log(`  ${String(row.steam_appid).padStart(8)}  ${type.padEnd(12)} ${row.name ?? ""}`);
}
console.log(`\nHidden despite Steam typing them 'game': ${hiddenGames.length}`);
console.log("  (expected: software Steam mistypes, test builds, and manual calls)");
for (const [row, decision] of hiddenGames) {
  console.log(`  ${String(row.steam_appid).padStart(8)}  ${String(decision.matched_rule).padEnd(30)} ${row.name ?? ""}`);
}
const pending = quarantine.filter((row) => row.review_status === "pending");
console.log(`\nAwaiting a human decision: ${pending.length}`);
for (const row of pending) console.log(`  ${String(row.steam_appid).padStart(8)}  ${row.matched_rule}`);
