import "server-only";

import crypto from "node:crypto";
import { fetchOwnedSteamGames, fetchSteamPlayerSummary } from "@/lib/steam";
import { SteamLibraryUnavailableError } from "@/lib/steam-owned-games";
import { fetchSteamResponse, readSteamJson, SteamApiError } from "@/lib/steam-api-error";
import { saveLibrarySnapshot } from "@/lib/steam-library-snapshot";
import { steamSetupCache } from "@/lib/steam-setup-cache";
import { diagnosticId } from "@/lib/diagnostics";
import type { RequestDiagnostics } from "@/lib/diagnostics-server";
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
  snapshotId?: string;
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
      | "library_empty"
      | "library_unavailable"
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
  const response = await fetchSteamResponse("resolve_vanity",
      `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/?${params.toString()}`,
      {
        headers: { "User-Agent": "VaultShuffle/0.1" },
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      },
    );
  const payload = await readSteamJson(response, "resolve_vanity") as { response?: { success?: number; steamid?: unknown } };
  if (![1, 42].includes(Number(payload?.response?.success))) throw new SteamApiError("resolve_vanity", "steam_invalid_response");
  const steamId = String(payload.response?.steamid ?? "");
  if (payload.response?.success !== 1 || !isSteamId(steamId)) {
    throw new ManualSteamProfileError(
      "profile_not_found",
      "We could not find that Steam profile. Check the link or try the 17-digit Steam ID.",
    );
  }
  return steamId;
}

export async function lookupManualSteamProfile(input: string, diagnostics?: RequestDiagnostics): Promise<ManualSteamProfileLookup> {
  const reference = parseSteamProfileInput(input);
  const apiKey = steamApiKey();
  diagnostics?.stage("resolve_profile_reference");
  const steamId = await steamIdForReference(reference, apiKey);

  try {
    diagnostics?.stage("steam_profile_and_library");
    const [profileResult, gamesResult] = await Promise.allSettled([
      fetchSteamPlayerSummary(steamId, apiKey, true),
      fetchOwnedSteamGames(steamId, apiKey),
    ]);
    if (profileResult.status === "rejected") throw profileResult.reason;
    const profile = profileResult.value;
    if (!profile) {
      throw new ManualSteamProfileError(
        "profile_not_found",
        "We could not find that Steam profile. Check the link and try again.",
      );
    }

    if (gamesResult.status === "rejected") {
      if (gamesResult.reason instanceof SteamLibraryUnavailableError && profile.community_visibility_state && profile.community_visibility_state !== 3) {
        throw new SteamLibraryUnavailableError("library_private");
      }
      throw gamesResult.reason;
    }
    const games = gamesResult.value;
    diagnostics?.stage("setup_library_cache");
    const snapshotId = await saveLibrarySnapshot(steamSetupCache(), steamId, games).catch(() => {
      diagnostics?.event("warning", { error_code: "cache_unavailable", cache_result: "write_failed" });
      return undefined;
    });

    return {
      ...(snapshotId ? { snapshotId } : {}),
      steamId,
      profileUrl: canonicalSteamProfileUrl(steamId),
      displayName: profile.display_name || "Steam player",
      avatarUrl: profile.avatar_url,
      gameCount: games.length,
      inputType: reference.inputType,
    };
  } catch (error) {
    if (error instanceof ManualSteamProfileError || error instanceof SteamApiError) throw error;
    if (error instanceof SteamLibraryUnavailableError) {
      throw new ManualSteamProfileError(
        error.code,
        error.message,
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
    && (token.snapshotId === undefined || Boolean(diagnosticId(token.snapshotId)))
    && token.displayName.length > 0
    && token.displayName.length <= 80
    && (token.avatarUrl === null || (typeof token.avatarUrl === "string" && token.avatarUrl.length <= 2048))
    && Number.isInteger(token.gameCount)
    && Number(token.gameCount) > 0
    && ["steam_id", "profile_url", "vanity", "vanity_url"].includes(String(token.inputType));
}
