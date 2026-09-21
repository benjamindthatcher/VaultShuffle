import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { MutationQueue } from "./mutation-queue.ts";

/** Exercise the provider's real mutation handlers with a controlled persistence boundary. */
function harness(live = false) {
  const source = ts.createSourceFile("provider.tsx", readFileSync(new URL("../components/app-shell/AppDataProvider.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set(["recordVaultAction", "recordDrawEvent", "predictVaultState", "reduceGuestVaultState", "updateGame"]);
  const functions: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text)) functions.push(node.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  const compiled = ts.transpileModule(functions.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const state = { current: { pinnedIds: [] as string[], pins: [] as Array<{ gameId: string; pinnedAt: string | null; hoursAtPin: number | null }>, snoozedIds: [], currentPickId: null } };
  const games = { current: ["a", "b", "c", "d"].map(id => ({ id, steamAppId: id, hoursPlayed: 5, status: "In Progress" })) };
  const captures: Array<{ event: string; properties: Record<string, unknown> }> = [];
  const queue = new MutationQueue(async () => {});
  let fail = false;
  const dependencies = {
    isLive: live, liveVaultStateRef: state, guestVaultStateRef: state, liveGamesRef: games, guestGamesRef: games,
    setLiveVaultState: setState, setGuestVaultState: setState,
    setLiveGames: (update: (value: unknown) => unknown) => { games.current = update(games.current) as typeof games.current; },
    setGuestGames: (update: (value: unknown) => unknown) => { games.current = update(games.current) as typeof games.current; },
    setLiveVaultHistory: () => {}, setGuestVaultHistory: () => {},
    mutationContext: (context: Record<string, unknown>) => ({ source: "library", ...context }),
    mutations: () => queue,
    persistMutation: (_action: string, _id: string, _context: unknown, write: (version: number) => Promise<unknown>) => queue.enqueue(write),
    api: async (path: string) => { if (fail) throw new Error("offline"); return path.includes("events") ? { event: {} } : structuredClone(state.current); },
    ANALYTICS_EVENTS: new Proxy({}, { get: (_target, name) => name }),
    trackEvent: capture, trackNavigationEvent: capture,
    liveGameSummary: () => "", applyGamePatch: (game: object, patch: object) => ({ ...game, ...patch }),
    pinProgressHours: (game: { hoursPlayed: number }, pin?: { hoursAtPin: number }) => pin ? game.hoursPlayed - pin.hoursAtPin : null,
    crypto,
  };
  function setState(value: unknown) { state.current = (typeof value === "function" ? value(state.current) : value) as typeof state.current; }
  function capture(event: string, properties: Record<string, unknown>) { captures.push({ event, properties }); }
  const api = new Function(...Object.keys(dependencies), `${compiled}; return { recordVaultAction, recordDrawEvent, updateGame };`)(...Object.values(dependencies)) as {
    recordVaultAction: (action: string, id: string, context?: Record<string, unknown>) => Promise<void>;
    recordDrawEvent: (id: string, action: string, context?: Record<string, unknown>) => Promise<void>;
    updateGame: (id: string, patch: object) => Promise<void>;
  };
  return { ...api, state, captures, fail: () => { fail = true; } };
}

test("confirmed add records source and game; repeat acceptance preserves baseline and emits no duplicate", async () => {
  const h = harness(true);
  await h.recordVaultAction("pinned", "a", { source: "vault_save_later", draw_id: "draw" });
  const baseline = structuredClone(h.state.current.pins);
  await h.recordVaultAction("pinned", "a", { source: "vault_play_now" });
  assert.deepEqual(h.state.current.pins, baseline);
  assert.deepEqual(h.captures.map(event => event.event), ["playingNextAdded"]);
  assert.equal(h.captures[0].properties.source, "vault_save_later");
  assert.equal(h.captures[0].properties.draw_id, "draw");
  assert.equal(h.captures[0].properties.game_id, "a");
});

test("full shelf emits no false addition; replacement identifies both games and remains three slots", async () => {
  const h = harness();
  for (const id of ["a", "b", "c"]) await h.recordVaultAction("pinned", id);
  h.captures.length = 0;
  await h.recordVaultAction("pinned", "d");
  assert.equal(h.captures.length, 0);
  await h.recordVaultAction("pinned", "d", { replace_game_id: "b" });
  assert.deepEqual(h.state.current.pinnedIds, ["a", "d", "c"]);
  assert.deepEqual(h.captures.map(event => event.event), ["playingNextAdded", "playingNextReplaced"]);
  assert.equal(h.captures[1].properties.replaced_game_id, "b");
  await h.recordVaultAction("unpinned", "d");
  assert.equal(h.captures.at(-1)?.event, "playingNextRemoved");
});

test("failed persistence never reports an added game", async () => {
  const h = harness(true); h.fail();
  await assert.rejects(h.recordVaultAction("pinned", "a"), /offline/);
  assert.equal(h.captures.length, 0);
});

test("Steam store views do not inflate the launch funnel", async () => {
  const h = harness();
  await h.recordDrawEvent("draw", "opened_on_steam", { launch_target: "steam_store" });
  assert.equal(h.captures.length, 0);
  await h.recordDrawEvent("draw", "opened_on_steam", { launch_target: "steam_client" });
  assert.equal(h.captures[0].event, "vaultPickLaunched");
});

test("completing a commitment frees its slot and records playtime against the baseline", async () => {
  const h = harness();
  await h.recordVaultAction("pinned", "a");
  h.state.current.pins[0].hoursAtPin = 2;
  await h.updateGame("a", { status: "Completed" });
  assert.deepEqual(h.state.current.pinnedIds, []);
  assert.deepEqual(h.state.current.pins, []);
  assert.equal(h.captures.at(-1)?.event, "playingNextCompleted");
  assert.equal(h.captures.at(-1)?.properties.hours_since_choosing, 3);
});
