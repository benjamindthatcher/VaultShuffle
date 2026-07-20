import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const inputPath = process.argv[2];
if (!inputPath) throw new Error("Usage: node scripts/catalogue/build-seed-sql.mjs <starter-set-json>");
const seed = JSON.parse(await readFile(inputPath, "utf8"));
if (!Array.isArray(seed.games) || seed.games.length !== seed.requested_count) throw new Error("Starter set count is invalid.");

const rows = seed.games.map((game) => ({
  steam_appid: game.steam_appid,
  name: game.name,
  normalized_name: normalizeName(game.name),
  steam_type: "game",
  developer: game.developer,
  publisher: game.publisher,
  review_positive: game.positive,
  review_negative: game.negative,
  price_currency: "USD",
  price_initial: game.price_initial,
  price_final: game.price_final,
  discount_percent: game.discount_percent,
  source_captured_at: seed.captured_at,
  first_seen_reason: "seed",
  capsule_url: `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.steam_appid}/capsule_616x353.jpg`,
  header_url: `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.steam_appid}/header.jpg`
}));

const sql = `begin;
insert into public.catalog_seed_runs (source, metric, captured_at, requested_count, accepted_count, source_url, source_sha256)
values (${literal(seed.source)}, ${literal(seed.metric)}, ${literal(seed.captured_at)}::date, ${rows.length}, ${rows.length}, ${literal(seed.source_url)}, ${literal(seed.source_sha256)})
on conflict (source, metric, captured_at) do update set requested_count = excluded.requested_count,
  accepted_count = excluded.accepted_count, source_url = excluded.source_url, source_sha256 = excluded.source_sha256;

with payload as (
  select * from jsonb_to_recordset(${literal(JSON.stringify(rows))}::jsonb) as x(
    steam_appid bigint, name text, normalized_name text, steam_type text, developer text, publisher text,
    review_positive integer, review_negative integer, price_currency varchar(3), price_initial integer,
    price_final integer, discount_percent smallint, source_captured_at date, first_seen_reason text,
    capsule_url text, header_url text
  )
)
insert into public.catalog_games (steam_appid, name, normalized_name, steam_type, developer, publisher,
  review_positive, review_negative, price_currency, price_initial, price_final, discount_percent,
  source_captured_at, first_seen_reason, capsule_url, header_url)
select steam_appid, name, normalized_name, steam_type, developer, publisher, review_positive, review_negative,
  price_currency, price_initial, price_final, discount_percent, source_captured_at, first_seen_reason,
  capsule_url, header_url from payload
on conflict (steam_appid) do update set name = excluded.name, normalized_name = excluded.normalized_name,
  developer = excluded.developer, publisher = excluded.publisher, review_positive = excluded.review_positive,
  review_negative = excluded.review_negative, price_currency = excluded.price_currency,
  price_initial = excluded.price_initial, price_final = excluded.price_final,
  discount_percent = excluded.discount_percent, source_captured_at = excluded.source_captured_at,
  popularity_rank = null, popularity_source = null, popularity_metric = null,
  popularity_low = null, popularity_high = null, popularity_ccu = null,
  capsule_url = excluded.capsule_url, header_url = excluded.header_url, metadata_fetched_at = now(), updated_at = now();

insert into public.catalog_ingest_queue (steam_appid, status, reason, priority, source_payload, processed_at)
select steam_appid, 'ready', 'seed', 100,
  jsonb_build_object('starter_set_source', ${literal(seed.source)}, 'captured_at', source_captured_at), now()
from public.catalog_games where first_seen_reason = 'seed' and source_captured_at = ${literal(seed.captured_at)}::date
on conflict (steam_appid) do update set status = 'ready', reason = 'seed', source_rank = null,
  source_payload = excluded.source_payload, processed_at = now(), updated_at = now();
commit;`;

const outputPath = path.resolve("data/catalogue", `seed-${seed.requested_count}-${seed.captured_at}.sql`);
await writeFile(outputPath, `${sql}\n`, "utf8");
console.log(outputPath);

function normalizeName(value) { return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function literal(value) { return `'${String(value ?? "").replaceAll("'", "''")}'`; }
