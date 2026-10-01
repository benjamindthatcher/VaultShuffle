import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { artworkFromStoreItem, imageCandidates, verifyImage } from './refresh-images-lib.mjs';

// Deliberate local bulk work. No hosted worker, schedule, metadata or HLTB writes.
const mode = process.argv[2];
if (!['fetch', 'verify'].includes(mode) || !process.argv[3]) throw Error('Usage: node scripts/catalogue/refresh-images.mjs <fetch|verify> <private-run-directory>');
const directory = path.resolve(process.argv[3]);
const snapshot = JSON.parse(await fs.readFile(path.join(directory, 'catalogue-before.json'), 'utf8'));
const games = snapshot.games;
if (!Array.isArray(games) || new Set(games.map(g => g.steam_app_id)).size !== games.length) throw Error('Invalid catalogue snapshot');
const artworkFile = path.join(directory, 'store-artwork.ndjson');
async function records(filename) {
  try { return (await fs.readFile(filename, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
if (mode === 'fetch') {
  const complete = new Set((await records(artworkFile)).filter(r => r.status !== 'retryable').map(r => r.app_id));
  const pending = games.filter(g => !complete.has(g.steam_app_id));
  let count = complete.size;
  for (let offset = 0; offset < pending.length; offset += 100) {
    const batch = pending.slice(offset, offset + 100);
    const input = { ids: batch.map(g => ({ appid: Number(g.steam_app_id) })), context: { language: 'english', country_code: 'US' }, data_request: { include_assets: true } };
    const url = 'https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=' + encodeURIComponent(JSON.stringify(input));
    let items;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000) });
        if (response.status === 429) throw Error('store_rate_limited');
        if (!response.ok) throw Error('store_http_' + response.status);
        const payload = await response.json();
        items = payload?.response?.store_items;
        if (!Array.isArray(items)) throw Error('invalid_store_payload');
        break;
      } catch (error) {
        if (error.message === 'store_rate_limited' || attempt === 2) throw error;
        await delay(2000 * (attempt + 1));
      }
    }
    const byId = new Map(items.map(item => [String(item.appid ?? item.id), item]));
    const output = batch.map(game => {
      const item = byId.get(game.steam_app_id);
      const artwork = artworkFromStoreItem(item, game.steam_app_id);
      return { app_id: game.steam_app_id, checked_at: new Date().toISOString(), status: artwork ? 'available' : 'unavailable', artwork };
    });
    await fs.appendFile(artworkFile, output.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
    count += batch.length;
    if (offset % 1000 === 0 || count === games.length) console.log(JSON.stringify({ phase: 'fetch', completed: count, total: games.length }));
    await delay(650);
  }
} else {
  const fetched = new Map((await records(artworkFile)).map(row => [row.app_id, row]));
  if (games.some(game => !fetched.has(game.steam_app_id))) throw Error('Finish the Store artwork pass before verification');
  const outputFile = path.join(directory, 'verified-images.ndjson');
  const done = new Map((await records(outputFile)).map(row => [row.app_id, row]));
  const retryMissing = process.argv.includes('--retry-missing');
  const pending = games.filter(game => !done.has(game.steam_app_id) || done.get(game.steam_app_id).retryable
    || (retryMissing && (!done.get(game.steam_app_id).header_url || !done.get(game.steam_app_id).capsule_url)));
  let cursor = 0, completed = games.length - pending.length, halted = false;
  const memo = new Map();
  async function check(url) {
    if (!memo.has(url)) memo.set(url, (async () => {
      let result = await verifyImage(url);
      if (result.status === 'retryable') { await delay(500); result = await verifyImage(url); }
      return result;
    })());
    return memo.get(url);
  }
  async function pick(game, artwork, field) {
    let retryable = false;
    for (const url of imageCandidates(game, artwork, field)) {
      const result = await check(url);
      if (result.status === 'valid') return { url, retryable };
      if (result.status === 'retryable') retryable = true;
    }
    return { url: null, retryable };
  }
  async function worker() {
    while (!halted && cursor < pending.length) {
      const game = pending[cursor++];
      const source = fetched.get(game.steam_app_id);
      const artwork = source.artwork && Object.fromEntries(Object.entries(source.artwork).map(([field, urls]) => [field,
        [...new Set(urls.flatMap(url => url.includes('/store_item_assets/') ? [url] : [url.replace('/steam/apps/', '/store_item_assets/steam/apps/'), url]))]]));
      const header = await pick(game, artwork, 'header');
      const capsule = header.url ? { url: header.url, retryable: false } : await pick(game, artwork, 'capsule');
      const row = { game_id: game.game_id, app_id: game.steam_app_id, title: game.title, checked_at: new Date().toISOString(),
        store_status: source.status, header_url: header.url, capsule_url: capsule.url, retryable: header.retryable || capsule.retryable,
        previous_header: game.header_image_url, previous_capsule: game.capsule_image_url };
      await fs.appendFile(outputFile, JSON.stringify(row) + '\n', { mode: 0o600 });
      done.set(row.app_id, row);
      completed++;
      if (completed % 1000 === 0 || completed === games.length) console.log(JSON.stringify({ phase: 'verify', completed, total: games.length }));
    }
  }
  // Artwork uses the public CDN, separately from the paced Store API pass.
  // Bound verification to 32 in-flight requests and stop on a CDN rate limit.
  await Promise.all(Array.from({ length: 32 }, async () => {
    try { await worker(); } catch (error) { halted = true; throw error; }
  }));
  const rows = games.map(game => done.get(game.steam_app_id));
  const summary = { project_ref: snapshot.project_ref, completed_at: new Date().toISOString(), total: games.length,
    store_available: rows.filter(r => r.store_status === 'available').length,
    headers_verified: rows.filter(r => r.header_url).length, capsules_verified: rows.filter(r => r.capsule_url).length,
    headers_unavailable: rows.filter(r => !r.header_url).length, capsules_unavailable: rows.filter(r => !r.capsule_url).length,
    retryable: rows.filter(r => r.retryable).length };
  await fs.writeFile(path.join(directory, 'verification-summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(summary));
}
