import assert from 'node:assert/strict';
import test from 'node:test';
import { artworkFromStoreItem, imageCandidates, safeArtworkUrl, verifyImage } from './refresh-images-lib.mjs';

const item = { success: 1, item_type: 0, id: 1091500, appid: 1091500,
  assets: { asset_url_format: 'steam/apps/1091500/${FILENAME}?t=1784714077', header: 'abc/header.jpg', header_2x: 'abc/header_2x.jpg', main_capsule: 'def/capsule_616x353.jpg' } };
test('uses provider asset hashes and versions, choosing large landscape art first', () => {
  const result = artworkFromStoreItem(item, '1091500');
  assert.equal(result.header[0], 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/abc/header_2x.jpg?t=1784714077');
  assert.equal(result.capsule[0], result.header[0]);
  assert.ok(result.capsule.includes('https://shared.akamai.steamstatic.com/steam/apps/1091500/def/capsule_616x353.jpg?t=1784714077'));
  assert.ok(result.capsule.every(url => !url.includes('library_600x900')));
});
test('rejects mismatched identities, failed items and unsafe URLs', () => {
  assert.equal(artworkFromStoreItem(item, '413150'), null);
  assert.equal(artworkFromStoreItem({ ...item, success: 2 }, '1091500'), null);
  assert.equal(artworkFromStoreItem({ ...item, item_type: 1 }, '1091500'), null);
  for (const url of ['https://evil.example/steam/apps/1091500/header.jpg', 'https://cdn.akamai.steamstatic.com/steam/apps/413150/header.jpg', 'https://user:pass@cdn.akamai.steamstatic.com/steam/apps/1091500/header.jpg', 'http://cdn.akamai.steamstatic.com/steam/apps/1091500/header.jpg']) assert.equal(safeArtworkUrl(url, '1091500'), null);
  assert.equal(safeArtworkUrl('https://cdn.akamai.steamstatic.com/steam/apps/1091500/header.jpg', '.*'), null);
  assert.deepEqual(artworkFromStoreItem({ ...item, assets: { ...item.assets, header: '../../header.jpg', header_2x: 'https://evil.example/a.jpg' } }, '1091500').header, []);
});
test('keeps previous working images ahead of guessed fallbacks when Store artwork is unavailable', () => {
  const game = { steam_app_id: '1091500', header_image_url: 'https://shared.akamai.steamstatic.com/steam/apps/1091500/old/header.jpg?t=1' };
  assert.equal(imageCandidates(game, null, 'header')[0], game.header_image_url);
  assert.equal(imageCandidates(game, artworkFromStoreItem(item, '1091500'), 'header')[0], artworkFromStoreItem(item, '1091500').header[0]);
});
test('verification rejects HTML, empty images and missing resources; network failures are retryable', async () => {
  const url = 'https://shared.akamai.steamstatic.com/steam/apps/10/header.jpg';
  const verify = (status, contentType, length = '100') => verifyImage(url, async () => new Response(null, { status, headers: { 'Content-Type': contentType, 'Content-Length': length } }));
  assert.equal((await verify(200, 'image/jpeg')).status, 'valid');
  assert.equal((await verify(200, 'text/html')).status, 'retryable');
  assert.equal((await verify(200, 'image/jpeg', '0')).status, 'retryable');
  assert.equal((await verify(404, 'text/html')).status, 'missing');
  assert.equal((await verifyImage(url, async () => { throw Error('network'); })).status, 'retryable');
  await assert.rejects(() => verify(429, 'text/html'), /artwork_rate_limited/);
});
