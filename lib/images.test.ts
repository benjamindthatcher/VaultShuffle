import assert from 'node:assert/strict';
import test from 'node:test';
import { gameImageUrl, steamImageCandidates, steamImageUrl } from './images.ts';
import { steamDetailPayload } from './steam-store-details.ts';

test('current catalogue artwork wins over generated legacy URLs', () => {
  const game = { steam_appid: '1091500', header_url: 'https://shared.akamai.steamstatic.com/steam/apps/1091500/hash/header.jpg?t=2', capsule_url: 'https://shared.akamai.steamstatic.com/steam/apps/1091500/hash/capsule_616x353.jpg?t=2' };
  assert.equal(gameImageUrl(game, 'header'), game.header_url);
  assert.equal(gameImageUrl(game, 'capsule'), game.capsule_url);
  assert.equal(gameImageUrl(game, 'capsuleLarge'), game.capsule_url);
  assert.equal(steamImageCandidates(game, 'header')[0], game.header_url);
  assert.equal(gameImageUrl({ steam_appid: '10' }, 'header'), steamImageUrl('10', 'header'));
});
test('future appdetails refreshes keep provider artwork hashes on landscape cards', () => {
  const header = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/hash/header.jpg?t=2';
  const payload = steamDetailPayload('1091500', { name: 'Cyberpunk 2077', header_image: header });
  assert.equal(payload.header_url, header);
  assert.equal(payload.capsule_url, header);
});
