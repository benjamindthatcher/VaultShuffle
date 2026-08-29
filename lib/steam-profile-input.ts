export type SteamProfileReference =
  | { kind: "steam_id"; inputType: "steam_id" | "profile_url"; steamId: string }
  | { kind: "vanity"; inputType: "vanity" | "vanity_url"; vanity: string };

export class SteamProfileInputError extends Error {
  readonly code = "invalid_profile";

  constructor(message = "Enter a Steam profile URL, custom profile URL, or 17-digit Steam ID.") {
    super(message);
    this.name = "SteamProfileInputError";
  }
}

const STEAM_ID_PATTERN = /^\d{17}$/;
const VANITY_PATTERN = /^[A-Za-z0-9_-]{2,64}$/;

/**
 * Parses the handful of public Steam profile forms VaultShuffle supports.
 *
 * The submitted URL is never fetched. We only extract an identifier from the
 * fixed steamcommunity.com host, then use Steam's API from the server. Keeping
 * this parser separate makes that SSRF boundary both obvious and testable.
 */
export function parseSteamProfileInput(value: string): SteamProfileReference {
  const input = value.trim();
  if (!input) throw new SteamProfileInputError();

  if (STEAM_ID_PATTERN.test(input)) {
    return { kind: "steam_id", inputType: "steam_id", steamId: input };
  }

  const looksLikeSteamUrl = /^(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\//i.test(input);
  if (looksLikeSteamUrl) {
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    } catch {
      throw new SteamProfileInputError("That Steam profile URL is not valid.");
    }

    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (hostname !== "steamcommunity.com" || url.username || url.password || url.port) {
      throw new SteamProfileInputError("Use a profile URL from steamcommunity.com.");
    }

    let parts: string[];
    try {
      parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      throw new SteamProfileInputError("That Steam profile URL is not valid.");
    }

    if (parts.length !== 2) {
      throw new SteamProfileInputError("Use the main Steam profile URL, without an extra page after it.");
    }

    const [route, identifier] = parts;
    if (route.toLowerCase() === "profiles" && STEAM_ID_PATTERN.test(identifier)) {
      return { kind: "steam_id", inputType: "profile_url", steamId: identifier };
    }
    if (route.toLowerCase() === "id" && VANITY_PATTERN.test(identifier)) {
      return { kind: "vanity", inputType: "vanity_url", vanity: identifier };
    }
    throw new SteamProfileInputError();
  }

  if (VANITY_PATTERN.test(input)) {
    return { kind: "vanity", inputType: "vanity", vanity: input };
  }

  throw new SteamProfileInputError();
}

export function canonicalSteamProfileUrl(steamId: string) {
  if (!STEAM_ID_PATTERN.test(steamId)) throw new SteamProfileInputError("Steam returned an invalid profile ID.");
  return `https://steamcommunity.com/profiles/${steamId}`;
}

export function isSteamId(value: string) {
  return STEAM_ID_PATTERN.test(value);
}
