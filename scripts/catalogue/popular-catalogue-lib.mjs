import { createHash } from "node:crypto";

export const UINT32_MAX = 4_294_967_295;
export function parseSteamSpyPage(raw, page, expectedCount = 1_000) {
  const parsed = JSON.parse(raw);
  const orderedKeys = [...raw.matchAll(/"(\d+)"\s*:\s*\{/g)].map((match) => match[1]);
  if (orderedKeys.length !== expectedCount) {
    throw new Error(`SteamSpy page ${page} returned ${orderedKeys.length} entries; expected ${expectedCount}.`);
  }
  if (new Set(orderedKeys).size !== orderedKeys.length) {
    throw new Error(`SteamSpy page ${page} contains duplicate AppIDs.`);
  }

  return orderedKeys.flatMap((key, index) => {
    const item = parsed[key];
    const steamAppId = validSteamAppId(key);
    if (!item || !steamAppId || Number(item.appid) !== steamAppId) {
      throw new Error(`SteamSpy page ${page} contains a malformed row for AppID ${key}.`);
    }
    const name = cleanName(item.name);
    // SteamSpy occasionally includes otherwise-valid rows with an empty title.
    // They cannot be inserted into catalog_games, so preserve the raw source
    // rank but skip them and let the caller scan another page to fill its cohort.
    if (!name) return [];
    const [ownersLow, ownersHigh] = ownerBounds(item.owners);
    return [{
      steam_appid: steamAppId,
      name,
      rank: page * expectedCount + index + 1,
      owners_low: ownersLow,
      owners_high: ownersHigh
    }];
  });
}

export function assertUniqueCohort(games, expectedCount, label) {
  if (!Array.isArray(games) || games.length !== expectedCount) {
    throw new Error(`${label} cohort has ${games?.length ?? 0} rows; expected ${expectedCount}.`);
  }
  const ids = games.map((game) => validSteamAppId(game.steam_appid));
  if (ids.some((id) => !id)) throw new Error(`${label} cohort contains an invalid Steam AppID.`);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} cohort contains duplicate Steam AppIDs.`);
  if (games.some((game) => !cleanName(game.name))) throw new Error(`${label} cohort contains an empty name.`);
}

export function cleanName(value) {
  return String(value ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
}

export function normalizeName(value) {
  return cleanName(value).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function validSteamAppId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= UINT32_MAX ? parsed : null;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function ownerBounds(value) {
  const matches = String(value ?? "").match(/[\d,]+/g) ?? [];
  if (matches.length !== 2) return [null, null];
  return matches.map((part) => Number(part.replaceAll(",", "")));
}
