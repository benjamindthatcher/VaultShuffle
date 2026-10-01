import fs from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { safeArtworkUrl } from './refresh-images-lib.mjs';

const mode = process.argv[2];
if (!['plan', 'apply'].includes(mode) || !process.argv[3]) throw Error('Usage: node scripts/catalogue/apply-images.mjs <plan|apply> <private-run-directory>');
const directory = path.resolve(process.argv[3]);
const snapshot = JSON.parse(await fs.readFile(path.join(directory, 'catalogue-before.json'), 'utf8'));
const verified = new Map((await fs.readFile(path.join(directory, 'verified-images.ndjson'), 'utf8')).split('\n').filter(Boolean).map(line => {
  const row = JSON.parse(line); return [row.app_id, row];
}));
const changes = [];
for (const game of snapshot.games) {
  const row = verified.get(game.steam_app_id);
  if (!row || row.game_id !== game.game_id || row.retryable) throw Error('Every game must finish image verification without transient errors');
  for (const field of ['header_url', 'capsule_url']) if (row[field] && safeArtworkUrl(row[field], row.app_id) !== row[field]) throw Error('Unsafe verified artwork');
  // Every production card uses Steam header proportions. The verified header
  // preserves that presentation; use another verified capsule if none exists.
  const header = row.header_url || game.header_image_url, capsule = row.header_url || row.capsule_url || game.capsule_image_url;
  if (header !== game.header_image_url || capsule !== game.capsule_image_url) changes.push({ game_id: game.game_id, app_id: game.steam_app_id,
    header, capsule, old_header: game.header_image_url, old_capsule: game.capsule_image_url });
}
const plan = { project_ref: snapshot.project_ref, total_checked: snapshot.games.length, games_with_changes: changes.length,
  headers_changed: changes.filter(r => r.header !== r.old_header).length, capsules_changed: changes.filter(r => r.capsule !== r.old_capsule).length };
console.log(JSON.stringify(plan));
await fs.writeFile(path.join(directory, 'apply-plan.json'), JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 });
if (mode === 'plan') process.exit(0);
const connection = process.env.V2_IMAGE_DATABASE_URL, ca = process.env.V2_DATABASE_CA_PEM;
if (!connection || !ca || !/^[a-z]{20}$/.test(snapshot.project_ref)) throw Error('Provide a private V2_IMAGE_DATABASE_URL and verified V2_DATABASE_CA_PEM');
const sql = postgres(connection, { ssl: { rejectUnauthorized: true, ca }, prepare: false, max: 1, connect_timeout: 15, onnotice: () => {} });
const receipt = { ...plan, started_at: new Date().toISOString(), updated: 0, inserted: 0, already_current: 0, concurrent_change_skips: [] };
try {
  await sql`set role postgres`;
  const marker = await sql`select expected_project_ref from ops.project_marker where marker`;
  if (marker.length !== 1 || marker[0].expected_project_ref !== snapshot.project_ref) throw Error('Production project mismatch');
  for (let offset = 0; offset < changes.length; offset += 250) {
    const batch = changes.slice(offset, offset + 250);
    await sql.begin(async tx => {
      await tx`select set_config('statement_timeout','20000',true),set_config('lock_timeout','3000',true)`;
      // Same identity lock as the catalogue worker; then lock its metadata rows.
      const identities = await tx`select id,steam_app_id::text from catalog.games where id in ${tx(batch.map(r => r.game_id))} order by id for no key update`;
      const ids = new Map(identities.map(g => [g.id, g.steam_app_id]));
      if (batch.some(row => ids.get(row.game_id) !== row.app_id)) throw Error('Catalogue identity changed');
      const current = await tx`select game_id,header_image_url,capsule_image_url,md5((to_jsonb(m)-'header_image_url'-'capsule_image_url')::text) preserved
        from catalog.game_metadata m where game_id in ${tx(batch.map(r => r.game_id))} order by game_id for update`;
      const before = new Map(current.map(row => [row.game_id, row]));
      const accepted = [];
      for (const row of batch) {
        const live = before.get(row.game_id);
        if (live?.header_image_url === row.header && live?.capsule_image_url === row.capsule) { receipt.already_current++; continue; }
        if ((live?.header_image_url ?? null) !== row.old_header || (live?.capsule_image_url ?? null) !== row.old_capsule) {
          receipt.concurrent_change_skips.push(row.app_id); continue;
        }
        accepted.push(row);
      }
      if (!accepted.length) return;
      await fs.appendFile(path.join(directory, 'image-writeback-backup.ndjson'), accepted.map(row => JSON.stringify({
        game_id: row.game_id, app_id: row.app_id, existed: before.has(row.game_id), previous_header: before.get(row.game_id)?.header_image_url ?? null,
        previous_capsule: before.get(row.game_id)?.capsule_image_url ?? null, new_header: row.header, new_capsule: row.capsule })).join('\n') + '\n', { mode: 0o600 });
      const updated = await tx`insert into catalog.game_metadata(game_id,header_image_url,capsule_image_url)
        select game_id,header,capsule from jsonb_to_recordset(${tx.json(accepted)}) as s(game_id integer,header text,capsule text)
        on conflict(game_id) do update set header_image_url=excluded.header_image_url,capsule_image_url=excluded.capsule_image_url
        returning game_id,md5((to_jsonb(game_metadata)-'header_image_url'-'capsule_image_url')::text) preserved`;
      for (const row of updated) {
        const old = before.get(row.game_id);
        if (old && old.preserved !== row.preserved) throw Error('Non-image metadata changed; rolling back');
      }
      receipt.updated += updated.filter(r => before.has(r.game_id)).length;
      receipt.inserted += updated.filter(r => !before.has(r.game_id)).length;
    });
    if (offset % 2500 === 0) console.log(JSON.stringify({ phase: 'apply', processed: Math.min(offset + 250, changes.length), total: changes.length }));
  }
  receipt.completed_at = new Date().toISOString();
  receipt.catalogue_after = (await sql`select count(*)::int total,count(*) filter(where m.game_id is null)::int missing_metadata,
    count(*) filter(where m.header_image_url is null)::int missing_header,count(*) filter(where m.capsule_image_url is null)::int missing_capsule
    from catalog.games g left join catalog.game_metadata m on m.game_id=g.id`)[0];
  await fs.writeFile(path.join(directory, 'apply-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(receipt));
} catch (error) {
  await fs.writeFile(path.join(directory, 'apply-progress.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.error('Image writeback stopped; resumable progress saved.', error.code ?? error.message);
  process.exitCode = 1;
} finally { await sql.end({ timeout: 5 }); }
