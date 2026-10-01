import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { hasFiniteWishlistStory, readGuestWishlist, type WishlistGame } from "./wishlist.ts";

// Exercise the actual mutation handlers with controllable persistence. Rendering
// and browser storage across navigation are covered by e2e/wishlist.spec.ts.
function load<T>(path: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const compiled = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), {
    fileName: path,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", ...Object.keys(globals), compiled)(
    (name: string) => {
      if (name in imports) return imports[name];
      throw new Error(`Unexpected dependency: ${name}`);
    }, loaded, loaded.exports, ...Object.values(globals),
  );
  return loaded.exports as T;
}

type Capture = { event: string; properties: Record<string, unknown>; options: unknown };
function analyticsHarness() {
  const captures: Capture[] = [];
  const analytics = load<typeof import("./analytics.ts")>("lib/analytics.ts", {
    "@/lib/posthog-client": { captureProductEvent: (event: string, properties: Record<string, unknown>, options: unknown) => captures.push({ event, properties, options }) },
  }, { window: { location: { pathname: "/wishlist" } } });
  return { captures, analytics };
}

async function mutationHarness(isLive = false) {
  const { captures, analytics } = analyticsHarness();
  const state: unknown[] = [];
  let cursor = 0;
  let stored: string | null = null;
  const storage = { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } };
  const api = { requestJson: async (_path: string, _options?: unknown): Promise<unknown> => ({ games: [], appIds: [], total: 0 }) };
  const { useWishlist: runHook } = load<typeof import("../components/wishlist/useWishlist.ts")>("components/wishlist/useWishlist.ts", {
    react: {
      useState: (initial: unknown) => {
        const index = cursor++;
        if (!(index in state)) state[index] = initial;
        return [state[index], (value: unknown) => { state[index] = typeof value === "function" ? value(state[index]) : value; }];
      },
      useRef: (initial: unknown) => { const index = cursor++; return state[index] ??= { current: initial }; },
      useCallback: (fn: unknown) => fn,
      useEffect: () => {},
    },
    "@/lib/analytics": analytics,
    "@/lib/wishlist": { readGuestWishlist },
    "@/lib/api-client": api,
  }, { localStorage: storage });
  const render = () => { cursor = 0; return runHook(isLive); };
  await render().reload();
  return { captures, render, storage, api };
}

const game: WishlistGame = { appId: 620, title: "Portal 2", image: "", genres: ["Puzzle"], reviews: 100, positive: 99 };

test("wishlist save and removal are counted once after persistence with surface and rank", async () => {
  const h = await mutationHarness();
  await h.render().toggle(game, { surface: "recommendations", recommendation_mode: "for-you", rank: 3 });
  assert.equal(readGuestWishlist(h.storage.getItem()).length, 1);
  await h.render().toggle(game, { surface: "wishlist", rank: 1 });
  assert.equal(readGuestWishlist(h.storage.getItem()).length, 0);
  assert.deepEqual(h.captures.map(({ event }) => event), ["wishlist_game_saved", "wishlist_game_removed"]);
  assert.deepEqual(h.captures[0].properties, { app_area: "wishlist", surface: "recommendations", recommendation_mode: "for-you", rank: 3, steam_appid: 620, storage: "browser", wishlist_count: 1 });
  assert.equal(h.captures[1].properties.wishlist_count, 0);
  assert.equal(h.captures[1].properties.surface, "wishlist");
});

test("failed browser and account writes never report successful saves or change the wishlist", async () => {
  for (const isLive of [false, true]) {
    const h = await mutationHarness(isLive);
    h.storage.setItem = () => { throw new Error("Storage full"); };
    h.api.requestJson = async () => { throw new Error("Account write failed"); };
    await h.render().toggle(game, { surface: "search", rank: 1 });
    assert.deepEqual(h.render().appIds, []);
    assert.equal(h.captures.length, 1);
    assert.equal(h.captures[0].event, "wishlist_action");
    assert.equal(h.captures[0].properties.outcome, "failed");
    assert.equal(h.captures[0].properties.operation, "save");
    assert.equal(h.captures[0].properties.storage, isLive ? "account" : "browser");
  }
});

test("import emits batch outcomes, rejects duplicate clicks, and distinguishes failures", async () => {
  const h = await mutationHarness(true);
  let finish!: (value: unknown) => void;
  h.api.requestJson = async (path) => path.endsWith("/import")
    ? new Promise(resolve => { finish = resolve; })
    : { games: [game], appIds: [620], total: 1 };
  const actions = h.render();
  const pending = actions.importSteam();
  await actions.importSteam();
  assert.equal(h.captures.length, 1);
  finish({ imported: 42 });
  await pending;
  assert.deepEqual(h.captures.map(({ properties }) => properties.outcome), ["started", "completed"]);
  assert.equal(h.captures[1].properties.steam_entry_count, 42);
  assert.ok(h.captures.every(({ event }) => event === "wishlist_import"));
  assert.deepEqual(h.render().appIds, [620]);
  h.api.requestJson = async () => { throw new Error("Private wishlist"); };
  await h.render().importSteam();
  assert.deepEqual(h.captures.slice(2).map(({ properties }) => properties.outcome), ["started", "failed"]);
  assert.deepEqual(h.render().appIds, [620]);
});

test("only the View on Steam button navigates and retains purchase context", () => {
  const { captures, analytics } = analyticsHarness();
  type Element = { type: string; props: { children?: Element | Element[]; onClick?: () => void } };
  const jsx = (type: string, props: Element["props"]) => ({ type, props });
  const { WishlistCard } = load<{ WishlistCard: (props: unknown) => Element }>("components/wishlist/WishlistCard.tsx", {
    react: { useState: () => [false, () => {}] },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@/components/shared/VaultIcon": {},
    "@/lib/steam-images": { steamStoreUrl: (id: number) => `https://store.steampowered.com/app/${id}/`, steamHeaderImage: (id: number) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg` },
    "@/lib/analytics": analytics, "./Wishlist.module.css": {},
    "@/lib/wishlist": { hasFiniteWishlistStory },
  });
  function clickLinks(node: Element) {
    if (!node?.props) return;
    if (node.type === "a") node.props.onClick?.();
    const children = node.props.children;
    for (const child of Array.isArray(children) ? children : children ? [children] : []) clickLinks(child);
  }
  clickLinks(WishlistCard({ game, saved: true, disabled: false, context: { surface: "wishlist", rank: 2 } }));
  assert.equal(captures.length, 1);
  for (const capture of captures) {
    assert.equal(capture.event, "wishlist_store_opened");
    assert.deepEqual(capture.options, { transport: "sendBeacon", send_instantly: true });
    assert.equal(capture.properties.steam_appid, 620);
    assert.equal(capture.properties.surface, "wishlist");
    assert.equal(capture.properties.is_saved, true);
    assert.equal(capture.properties.rank, 2);
    assert.equal(capture.properties.control, "store_button");
  }
});
