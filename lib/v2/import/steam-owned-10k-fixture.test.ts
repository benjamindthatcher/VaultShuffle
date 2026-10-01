import assert from "node:assert/strict";
import test from "node:test";
import {
  createSteamOwned10kFixture,
  STEAM_10K_FIXTURE_CANONICAL_BYTES,
  STEAM_10K_FIXTURE_CONTENT_HASH,
  STEAM_10K_FIXTURE_GAME_COUNT,
  STEAM_10K_FIXTURE_OBSERVATION_EPOCH_SECONDS,
  STEAM_10K_FIXTURE_PROVIDER_BODY_BYTES
} from "./steam-owned-10k-fixture.ts";
import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  MAX_GAME_NAME_LENGTH,
  normalizeSteamOwnedSnapshot
} from "./steam-owned-snapshot.ts";

test("builds a deterministic complete 10,000-game fixture through the production normalizer", () => {
  const first = createSteamOwned10kFixture();
  const second = createSteamOwned10kFixture();

  assert.equal(first.providerBody.response.game_count, STEAM_10K_FIXTURE_GAME_COUNT);
  assert.equal(first.providerBody.response.games.length, STEAM_10K_FIXTURE_GAME_COUNT);
  assert.equal(first.snapshot.status, "complete");
  assert.equal(first.snapshot.gameCount, STEAM_10K_FIXTURE_GAME_COUNT);
  assert.equal(first.snapshot.games.length, STEAM_10K_FIXTURE_GAME_COUNT);
  assert.equal(first.snapshot.contentHash, STEAM_10K_FIXTURE_CONTENT_HASH);
  assert.equal(first.snapshot.provenance.httpStatus, 200);
  assert.equal(first.snapshot.provenance.observationTimeEpochSeconds, STEAM_10K_FIXTURE_OBSERVATION_EPOCH_SECONDS);
  assert.equal(first.providerBodyBytes, STEAM_10K_FIXTURE_PROVIDER_BODY_BYTES);
  assert.equal(new TextEncoder().encode(first.snapshot.canonicalJson).byteLength, STEAM_10K_FIXTURE_CANONICAL_BYTES);
  assert.ok(first.providerBodyBytes < DEFAULT_MAX_PAYLOAD_BYTES);
  assert.ok(STEAM_10K_FIXTURE_CANONICAL_BYTES < DEFAULT_MAX_PAYLOAD_BYTES);

  // The fixture hits all important canonical edge cases without relying on a
  // separately hand-written canonical payload.
  assert.deepEqual(first.snapshot.games[0], {
    appId: "1",
    playtimeMinutes: 0,
    name: "Steam App 1",
    nameSource: "catalog_stub",
    lastPlayedAtEpochSeconds: null,
    lastPlayedSource: "steam.rtime_last_played_unknown"
  });
  assert.equal(first.snapshot.games[1]?.playtimeMinutes, null);
  assert.equal(first.snapshot.games[2]?.lastPlayedSource, "steam.rtime_last_played");
  assert.equal(first.snapshot.games[3]?.lastPlayedSource, "not_provided");
  assert.equal(first.snapshot.games[9]?.nameSource, "steam.name");
  assert.equal(first.snapshot.games.at(-1)?.appId, "4294967295");
  assert.ok(first.snapshot.games.every((game) => Array.from(game.name).length <= MAX_GAME_NAME_LENGTH));

  assert.equal(first.providerBodyJson, second.providerBodyJson);
  assert.equal(first.snapshot.canonicalJson, second.snapshot.canonicalJson);
  assert.equal(first.snapshot.contentHash, second.snapshot.contentHash);
  assert.equal(first.providerBodyBytes, second.providerBodyBytes);
});

test("keeps the fixture hash independent of generated transport metadata", () => {
  const fixture = createSteamOwned10kFixture();
  const withDifferentObservation = {
    ...fixture.snapshot,
    provenance: {
      ...fixture.snapshot.provenance,
      observationTimeEpochSeconds: STEAM_10K_FIXTURE_OBSERVATION_EPOCH_SECONDS + 120
    }
  };
  assert.equal(withDifferentObservation.canonicalJson, fixture.snapshot.canonicalJson);
  assert.equal(withDifferentObservation.contentHash, fixture.snapshot.contentHash);
});

test("keeps the 10k canonical hash stable when provider order is reversed", () => {
  const fixture = createSteamOwned10kFixture();
  const reordered = normalizeSteamOwnedSnapshot({
    response: {
      game_count: fixture.providerBody.response.game_count,
      games: [...fixture.providerBody.response.games].reverse()
    }
  }, {
    observationTimeEpochSeconds: STEAM_10K_FIXTURE_OBSERVATION_EPOCH_SECONDS
  });
  assert.equal(reordered.status, "complete");
  if (reordered.status !== "complete") return;
  assert.equal(reordered.gameCount, fixture.snapshot.gameCount);
  assert.equal(reordered.canonicalJson, fixture.snapshot.canonicalJson);
  assert.equal(reordered.contentHash, fixture.snapshot.contentHash);
});
