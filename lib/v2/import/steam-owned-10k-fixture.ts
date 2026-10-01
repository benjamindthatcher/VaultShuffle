import {
  STEAM_COMPLETE_OWNED_SCOPE,
  type SteamOwnedFetchComplete
} from "./steam-owned-fetch.ts";
import {
  DEFAULT_MAX_GAMES,
  normalizeSteamOwnedSnapshot,
  type SteamOwnedSnapshotResult
} from "./steam-owned-snapshot.ts";

/**
 * A fixed observation anchor keeps the fixture useful for hash and SQL
 * idempotency checks without making the canonical payload depend on the
 * worker's wall clock.
 */
// Historical fixture evidence keeps local SQL runs valid on any current clock.
// The SQL harness replaces only provenance observation time at execution.
export const STEAM_10K_FIXTURE_OBSERVATION_EPOCH_SECONDS = 1_700_000_000;
export const STEAM_10K_FIXTURE_GAME_COUNT = DEFAULT_MAX_GAMES;

export type SteamOwned10kProviderGame = {
  appid: number;
  playtime_forever?: number | null;
  name?: string;
  rtime_last_played?: number | null;
};

export type SteamOwned10kProviderBody = {
  response: {
    game_count: number;
    games: SteamOwned10kProviderGame[];
  };
};

export type SteamOwned10kFixture = {
  providerBody: SteamOwned10kProviderBody;
  providerBodyJson: string;
  providerBodyBytes: number;
  snapshot: SteamOwnedFetchComplete;
};

/**
 * This is filled from the canonical output produced by the normalizer below.
 * Keeping the value in the fixture gives SQL integration tests a reviewable
 * expected digest instead of asserting only that two calls happened to agree.
 */
export const STEAM_10K_FIXTURE_CONTENT_HASH =
  "5cac4a392b56f5b94ea48313280b0eedb39a40c5bf5a5277c612fde87780f68c";
export const STEAM_10K_FIXTURE_PROVIDER_BODY_BYTES = 839_394;
export const STEAM_10K_FIXTURE_CANONICAL_BYTES = 1_737_832;

/**
 * Build the same complete 10,000-game Steam body on every call, then run the
 * production normalizer over it. The fixture intentionally exercises the
 * uint32 AppID edge, explicit zero/unknown minutes, catalog stubs, and all
 * timestamp provenance branches while staying well under the 8 MiB boundary.
 */
export function createSteamOwned10kFixture(): SteamOwned10kFixture {
  const games: SteamOwned10kProviderGame[] = Array.from(
    { length: STEAM_10K_FIXTURE_GAME_COUNT },
    (_, index) => {
      const appid = index === STEAM_10K_FIXTURE_GAME_COUNT - 1
        ? 4_294_967_295
        : index + 1;
      const game: SteamOwned10kProviderGame = { appid };

      if (index === 0) game.playtime_forever = 0;
      else if (index === 1) game.playtime_forever = null;
      else if (index !== 2) game.playtime_forever = index * 17;

      // Every tenth title is omitted to exercise the explicit catalog stub.
      if (index % 10 !== 0) game.name = `Fixture Game ${appid}`;

      switch (index % 4) {
        case 0:
          game.rtime_last_played = 0;
          break;
        case 1:
          game.rtime_last_played = null;
          break;
        case 2:
          game.rtime_last_played = STEAM_10K_FIXTURE_OBSERVATION_EPOCH_SECONDS - index;
          break;
        default:
          // Omitted is distinct from the provider-reported unknown values.
          break;
      }

      return game;
    }
  );
  const providerBody: SteamOwned10kProviderBody = {
    response: { game_count: STEAM_10K_FIXTURE_GAME_COUNT, games }
  };
  const providerBodyJson = JSON.stringify(providerBody);
  const providerBodyBytes = new TextEncoder().encode(providerBodyJson).byteLength;
  const normalized: SteamOwnedSnapshotResult = normalizeSteamOwnedSnapshot(providerBody, {
    observationTimeEpochSeconds: STEAM_10K_FIXTURE_OBSERVATION_EPOCH_SECONDS
  });
  if (normalized.status !== "complete") {
    throw new Error(`deterministic fixture failed normalization: ${normalized.status}`);
  }

  const snapshot: SteamOwnedFetchComplete = {
    ...normalized,
    provenance: {
      ...STEAM_COMPLETE_OWNED_SCOPE,
      httpStatus: 200,
      bodyBytes: providerBodyBytes,
      observationTimeEpochSeconds: STEAM_10K_FIXTURE_OBSERVATION_EPOCH_SECONDS
    }
  };
  if (providerBodyBytes !== STEAM_10K_FIXTURE_PROVIDER_BODY_BYTES
    || new TextEncoder().encode(snapshot.canonicalJson).byteLength !== STEAM_10K_FIXTURE_CANONICAL_BYTES) {
    throw new Error("deterministic fixture byte size changed");
  }
  if (snapshot.contentHash !== STEAM_10K_FIXTURE_CONTENT_HASH) {
    throw new Error(
      `fixture digest changed: expected ${STEAM_10K_FIXTURE_CONTENT_HASH}, got ${snapshot.contentHash}`
    );
  }
  return { providerBody, providerBodyJson, providerBodyBytes, snapshot };
}
