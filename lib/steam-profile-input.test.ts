import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalSteamProfileUrl,
  parseSteamProfileInput,
  SteamProfileInputError,
} from "./steam-profile-input.ts";

test("parses a SteamID64", () => {
  assert.deepEqual(parseSteamProfileInput("76561198000000000"), {
    kind: "steam_id",
    inputType: "steam_id",
    steamId: "76561198000000000",
  });
});

test("parses canonical and vanity Steam profile URLs", () => {
  assert.deepEqual(parseSteamProfileInput("https://steamcommunity.com/profiles/76561198000000000/"), {
    kind: "steam_id",
    inputType: "profile_url",
    steamId: "76561198000000000",
  });
  assert.deepEqual(parseSteamProfileInput("steamcommunity.com/id/Doppluh"), {
    kind: "vanity",
    inputType: "vanity_url",
    vanity: "Doppluh",
  });
});

test("accepts a raw custom profile name", () => {
  assert.deepEqual(parseSteamProfileInput("Doppluh"), {
    kind: "vanity",
    inputType: "vanity",
    vanity: "Doppluh",
  });
});

test("rejects arbitrary hosts, credentials, ports and nested Steam paths", () => {
  for (const value of [
    "https://example.com/profiles/76561198000000000",
    "https://person@steamcommunity.com/profiles/76561198000000000",
    "https://steamcommunity.com:444/profiles/76561198000000000",
    "https://steamcommunity.com/id/Doppluh/games",
  ]) {
    assert.throws(() => parseSteamProfileInput(value), SteamProfileInputError);
  }
});

test("builds only canonical profile URLs from valid IDs", () => {
  assert.equal(
    canonicalSteamProfileUrl("76561198000000000"),
    "https://steamcommunity.com/profiles/76561198000000000",
  );
  assert.throws(() => canonicalSteamProfileUrl("123"), SteamProfileInputError);
});
