import "server-only";

import crypto from "node:crypto";
import { fetchOwnedSteamGames, fetchSteamPlayerSummary } from "@/lib/steam";
import { SteamLibraryUnavailableError } from "@/lib/steam-owned-games";
import {
  canonicalSteamProfileUrl,
  isSteamId,
  parseSteamProfileInput,
  type SteamProfileReference,
} from "@/lib/steam-profile-input";

export type ManualSteamProfileLookup = {
  steamId: string;
  profileUrl: string;
  displayName: string;
  avatarUrl: string | null;
  gameCount: number;
  inputType: SteamProfileReference["inputType"];
};

export type ManualSteamProfileLookupToken = ManualSteamProfileLookup & {
  version: 1;
  expiresAt: number;
};

export class ManualSteamProfileError extends Error {
  constructor(
    public readonly code:
      | "profile_not_found"
      | "library_private"
      | "steam_unavailable"
      | "lookup_expired"
      | "invalid_lookup",
    message: string,
  ) {
    super(message);
    this.name = "ManualSteamProfileError";
  }
}

function steamApiKey() {
  const apiKey = process.env.STEAM_WEB_API_KEY?.trim();
  if (!apiKey) {
    throw new ManualSteamProfileError(
      "steam_unavailable",
      "Public-profile setup is temporarily unavailable. Please try again shortly.",
    );
  }
  return apiKey;
}

function lookupSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("Missing required environment variable: SESSION_SECRET");
  return secret;
}

async function steamIdForReference(reference: SteamProfileReference, apiKey: string) {
  if (reference.kind === "steam_id") return reference.steamId;

  const params = new URLSearchParams({
    key: apiKey,
    vanityurl: reference.vanity,
    url_type: "1",
    format: "json",
  });
  let response: Response;
  try {
    response = await fetch(
      `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/?${params.toString()}`,
      {
        headers: { "User-Agent": "VaultShuffle/0.1" },
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      },
    );
  } catch {
    throw new ManualSteamProfileError(
      "steam_unavailable",
      "Steam did not answer the profile lookup. Please try again.",
    );
  }

  if (!response.ok) {
    throw new ManualSteamProfileError(
      "steam_unavailable",
      "Steam did not answer the profile lookup. Please try again.",
    );
  }
  const payload = await response.json() as { response?: { success?: number; steamid?: unknown } };
  const steamId = String(payload.response?.steamid ?? "");
  if (payload.response?.success !== 1 || !isSteamId(steamId)) {
    throw new ManualSteamProfileError(
      "profile_not_found",
      "We could not find that Steam profile. Check the link or try the 17-digit Steam ID.",
    );
  }
  return steamId;
}

export async function lookupManualSteamProfile(input: string): Promise<ManualSteamProfileLookup> {
  const reference = parseSteamProfileInput(input);
  const apiKey = steamApiKey();
  const steamId = await steamIdForReference(reference, apiKey);

  try {
    const [profile, games] = await Promise.all([
      fetchSteamPlayerSummary(steamId, apiKey),
      fetchOwnedSteamGames(steamId, apiKey),
    ]);
    if (!profile) {
      throw new ManualSteamProfileError(
        "profile_not_found",
        "We could not find that Steam profile. Check the link and try again.",
      );
    }

    return {
      steamId,
      profileUrl: canonicalSteamProfileUrl(steamId),
      displayName: profile.display_name || "Steam player",
      avatarUrl: profile.avatar_url,
      gameCount: games.length,
      inputType: reference.inputType,
    };
  } catch (error) {
    if (error instanceof ManualSteamProfileError) throw error;
    if (error instanceof SteamLibraryUnavailableError) {
      throw new ManualSteamProfileError(
        "library_private",
        "That profile exists, but Steam is not sharing its games. Set Profile > Edit Profile > Privacy Settings > Game details to Public, then try again.",
      );
    }
    throw new ManualSteamProfileError(
      "steam_unavailable",
      "Steam could not share that library just now. Please try again.",
    );
  }
}

export function signManualSteamProfileLookup(lookup: ManualSteamProfileLookup, lifetimeSeconds = 15 * 60) {
  const payload: ManualSteamProfileLookupToken = {
    version: 1,
    ...lookup,
    expiresAt: Math.floor(Date.now() / 1000) + lifetimeSeconds,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", lookupSecret())
    .update(`manual-profile\u001f${encoded}`)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyManualSteamProfileLookup(token: string): ManualSteamProfileLookupToken {
  const [encoded, suppliedSignature, ...extra] = token.split(".");
  if (!encoded || !suppliedSignature || extra.length) {
    throw new ManualSteamProfileError("invalid_lookup", "Find the Steam profile again before creating your Vault.");
  }
  const expectedSignature = crypto
    .createHmac("sha256", lookupSecret())
    .update(`manual-profile\u001f${encoded}`)
    .digest("base64url");
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    throw new ManualSteamProfileError("invalid_lookup", "Find the Steam profile again before creating your Vault.");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new ManualSteamProfileError("invalid_lookup", "Find the Steam profile again before creating your Vault.");
  }

  if (!isLookupToken(payload)) {
    throw new ManualSteamProfileError("invalid_lookup", "Find the Steam profile again before creating your Vault.");
  }
  if (payload.expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new ManualSteamProfileError("lookup_expired", "That profile check has expired. Find the profile again to continue.");
  }
  return payload;
}

function isLookupToken(value: unknown): value is ManualSteamProfileLookupToken {
  if (!value || typeof value !== "object") return false;
  const token = value as Partial<ManualSteamProfileLookupToken>;
  return token.version === 1
    && typeof token.expiresAt === "number"
    && isSteamId(String(token.steamId ?? ""))
    && token.profileUrl === canonicalSteamProfileUrl(String(token.steamId))
    && typeof token.displayName === "string"
    && token.displayName.length > 0
    && token.displayName.length <= 80
    && (token.avatarUrl === null || (typeof token.avatarUrl === "string" && token.avatarUrl.length <= 2048))
    && Number.isInteger(token.gameCount)
    && Number(token.gameCount) > 0
    && ["steam_id", "profile_url", "vanity", "vanity_url"].includes(String(token.inputType));
}
