import assert from "node:assert/strict";
import test from "node:test";
import { IgdbDurationProvider } from "./igdb-duration-provider.ts";
import { secondsToMinutes } from "./duration-provider.ts";

test("secondsToMinutes validates and rounds provider values", () => {
  assert.equal(secondsToMinutes(3601), 60);
  assert.equal(secondsToMinutes(0), null);
  assert.equal(secondsToMinutes(-1), null);
  assert.equal(secondsToMinutes("3600"), null);
});

test("authentication uses a form body and does not expose credentials in the URL", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    if (String(input).includes("oauth2/token")) return Response.json({ access_token: "token", expires_in: 3600 });
    if (String(input).endsWith("external_game_sources")) return Response.json([{ id: 1, name: "Steam" }]);
    if (String(input).endsWith("external_games")) return Response.json([]);
    throw new Error("Unexpected request");
  };
  await new IgdbDurationProvider("client-value", "secret-value", fetcher).findBySteamAppId(10);
  const tokenRequest = requests[0];
  assert.equal(tokenRequest.url, "https://id.twitch.tv/oauth2/token");
  assert.equal(tokenRequest.init?.headers && (tokenRequest.init.headers as Record<string, string>)["Content-Type"], "application/x-www-form-urlencoded");
  assert.match(String(tokenRequest.init?.body), /grant_type=client_credentials/);
  assert.doesNotMatch(tokenRequest.url, /client-value|secret-value/);
});

test("exact Steam mapping returns validated durations", async () => {
  const fetcher = mockFetch([
    { access_token: "test-token", expires_in: 3600 },
    [{ id: 1, name: "Steam" }],
    [{ game: 42, uid: "1086940" }],
    [{ game: 42, hastily: 3601, normally: 7200, completely: 10800, count: 30, updated_at: 1_700_000_000 }]
  ]);
  const result = await new IgdbDurationProvider("client", "secret", fetcher).findBySteamAppId(1086940);
  assert.deepEqual({ status: result.status, main: result.mainStoryMinutes, extras: result.mainExtraMinutes, complete: result.completionistMinutes, confidence: result.confidence },
    { status: "matched", main: 60, extras: 120, complete: 180, confidence: "high" });
});

test("no mapping and conflicting mappings are not title-matched", async () => {
  const missing = new IgdbDurationProvider("client", "secret", mockFetch([{ access_token: "token", expires_in: 3600 }, [{ id: 1, name: "Steam" }], []]));
  assert.equal((await missing.findBySteamAppId(10)).status, "not_found");
  const ambiguous = new IgdbDurationProvider("client", "secret", mockFetch([{ access_token: "token", expires_in: 3600 }, [{ id: 1, name: "Steam" }], [{ game: 1, uid: "10" }, { game: 2, uid: "10" }]]));
  assert.equal((await ambiguous.findBySteamAppId(10)).status, "ambiguous");
});

test("token refresh is shared across concurrent lookups", async () => {
  let tokenCalls = 0;
  const fetcher: typeof fetch = async (input) => {
    if (String(input).includes("oauth2/token")) { tokenCalls += 1; return Response.json({ access_token: "token", expires_in: 3600 }); }
    if (String(input).endsWith("external_game_sources")) return Response.json([{ id: 1, name: "Steam" }]);
    if (String(input).endsWith("external_games")) return Response.json([]);
    throw new Error("Unexpected request");
  };
  const provider = new IgdbDurationProvider("client", "secret", fetcher);
  await Promise.all([provider.findBySteamAppId(1), provider.findBySteamAppId(2)]);
  assert.equal(tokenCalls, 1);
});

test("a 401 refreshes authentication once and retries the same lookup", async () => {
  let tokenCalls = 0;
  let sourceCalls = 0;
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("oauth2/token")) {
      tokenCalls += 1;
      return Response.json({ access_token: `token-${tokenCalls}`, expires_in: 3600 });
    }
    if (url.endsWith("external_game_sources")) {
      sourceCalls += 1;
      if (sourceCalls === 1) return new Response(null, { status: 401 });
      return Response.json([{ id: 1, name: "Steam" }]);
    }
    if (url.endsWith("external_games")) return Response.json([]);
    throw new Error("Unexpected request");
  };
  const result = await new IgdbDurationProvider("client", "secret", fetcher).findBySteamAppId(10);
  assert.equal(result.status, "not_found");
  assert.equal(tokenCalls, 2);
  assert.equal(sourceCalls, 2);
});

test("an exact Steam mapping without timing data returns no_duration", async () => {
  const fetcher = mockFetch([
    { access_token: "test-token", expires_in: 3600 },
    [{ id: 1, name: "Steam" }],
    [{ game: 42, uid: "10" }],
    []
  ]);
  const result = await new IgdbDurationProvider("client", "secret", fetcher).findBySteamAppId(10);
  assert.equal(result.status, "no_duration");
  assert.equal(result.providerGameId, 42);
});

function mockFetch(payloads: unknown[]): typeof fetch {
  let index = 0;
  return async () => Response.json(payloads[index++]);
}
