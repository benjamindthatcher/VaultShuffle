import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { blogPageProperties } from "./blog-analytics.ts";

function load(path: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { fileName: path, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", ...Object.keys(globals), compiled)(
    (name: string) => {
      if (name in imports) return imports[name];
      throw new Error(`Unexpected dependency: ${name}`);
    }, loaded, loaded.exports, ...Object.values(globals),
  );
  return loaded.exports;
}

test("pageview context distinguishes blog pages without leaking into the app", () => {
  assert.deepEqual(blogPageProperties("/blog"), { app_area: "blog", blog_page_type: "index" });
  assert.deepEqual(blogPageProperties("/blog/steam-deck-games"), {
    app_area: "blog", blog_page_type: "article", post_slug: "steam-deck-games",
  });
  assert.deepEqual(blogPageProperties("/vault"), {});
  assert.deepEqual(blogPageProperties("/blog/not/a/post"), {});
});

function engagementHarness() {
  let now = 0;
  let tick: (() => void) | undefined;
  let visibilityChange: (() => void) | undefined;
  let enabled = true;
  const doc = {
    visibilityState: "visible",
    addEventListener: (_name: string, callback: () => void) => { visibilityChange = callback; },
    removeEventListener: () => { visibilityChange = undefined; },
  };
  const bounds = { top: 0, bottom: 2000, height: 2000 };
  const events: Array<{ visibleSeconds: number; articleProgress: number }> = [];
  const { observeBlogEngagement } = load("lib/blog-analytics.ts", {}, {
    document: doc,
    performance: { now: () => now },
    window: {
      innerHeight: 800,
      setInterval: (callback: () => void) => { tick = callback; return 1; },
      clearInterval: () => { tick = undefined; },
    },
  }) as typeof import("./blog-analytics.ts");
  const cleanup = observeBlogEngagement(
    { getBoundingClientRect: () => bounds } as HTMLElement,
    (event) => events.push(event),
    () => enabled,
  );
  return {
    events, bounds, cleanup,
    advance(seconds: number, step = 1) {
      for (let i = 0; i < seconds; i += step) { now += step * 1000; tick?.(); }
    },
    visible(value: boolean) { doc.visibilityState = value ? "visible" : "hidden"; visibilityChange?.(); },
    enabled(value: boolean) { enabled = value; },
    active: () => Boolean(tick || visibilityChange),
  };
}

test("engagement needs both visible time and halfway progress, and fires only once", () => {
  const h = engagementHarness();
  h.advance(30);
  assert.equal(h.events.length, 0, "time alone is not engagement");
  h.bounds.top = -300;
  h.bounds.bottom = 1700;
  h.advance(1);
  assert.deepEqual(h.events, [{ visibleSeconds: 31, articleProgress: 55 }]);
  h.advance(60);
  assert.equal(h.events.length, 1);
  assert.equal(h.active(), false);
});

test("hidden tabs, suspended timers and offscreen articles cannot qualify", () => {
  const h = engagementHarness();
  h.bounds.top = -300;
  h.visible(false);
  h.advance(60);
  h.visible(true);
  h.advance(120, 120);
  h.bounds.bottom = -1;
  h.advance(60);
  h.bounds.bottom = 1700;
  h.advance(29);
  assert.equal(h.events.length, 0);
  h.advance(1);
  assert.equal(h.events.length, 1);
});

test("opting out resets reading time; leaving a page removes the observer", () => {
  const h = engagementHarness();
  h.bounds.top = -300;
  h.advance(20);
  h.enabled(false);
  h.advance(60);
  h.enabled(true);
  h.advance(29);
  assert.equal(h.events.length, 0);
  h.cleanup();
  h.advance(60);
  assert.equal(h.active(), false);
  assert.equal(h.events.length, 0);
});

test("blog links send one contextual event with navigation transport and no full URLs", () => {
  const captures: Array<{ name: string; properties: Record<string, unknown>; options: unknown }> = [];
  const analytics = load("lib/analytics.ts", {
    "@/lib/posthog-client": {
      captureProductEvent: (name: string, properties: Record<string, unknown>, options: unknown) => {
        captures.push({ name, properties, options });
      },
    },
  }, { window: { location: { pathname: "/blog" } } });
  class Target {
    dataset: Record<string, string>;
    constructor(dataset: Record<string, string>) { this.dataset = dataset; }
    closest() { return this; }
  }
  const { BlogAnalytics } = load("components/blog/BlogAnalytics.tsx", {
    react: { useEffect: () => {}, useRef: () => ({ current: null }) },
    "react/jsx-runtime": { jsx: (_type: string, props: unknown) => props },
    "@/lib/analytics": analytics,
    "@/lib/blog-analytics": {},
    "@/lib/posthog-client": {},
  }, { Element: Target }) as { BlogAnalytics: (props: Record<string, unknown>) => {
    onClickCapture: (event: unknown) => void; onAuxClickCapture: (event: unknown) => void;
  } };
  const index = BlogAnalytics({ children: null });
  index.onClickCapture({ button: 0, target: new Target({ blogAction: "open_post", postSlug: "short-games", postTopic: "Steam Deck" }), currentTarget: { contains: () => true } });
  const article = BlogAnalytics({ children: null, slug: "short-games", topic: "Steam Deck" });
  article.onClickCapture({ button: 0, target: new Target({ blogAction: "try_guest" }), currentTarget: { contains: () => true } });
  article.onAuxClickCapture({ button: 1, target: new Target({ blogAction: "open_steam", gameAppid: "620" }), currentTarget: { contains: () => true } });
  article.onAuxClickCapture({ button: 2, target: new Target({ blogAction: "open_steam", gameAppid: "620" }), currentTarget: { contains: () => true } });
  assert.deepEqual(captures.map(({ name }) => name), ["blog_link_clicked", "blog_cta_clicked", "blog_link_clicked"]);
  for (const { properties, options } of captures) {
    assert.equal(properties.post_slug, "short-games");
    assert.equal(properties.topic, "Steam Deck");
    assert.equal(properties.app_area, "blog");
    assert.deepEqual(options, { transport: "sendBeacon", send_instantly: true });
    assert.equal("url" in properties, false);
  }
  assert.equal(captures[2].properties.game_appid, 620);
});

test("queued PostHog captures honor opt out and privacy signals before sending", async () => {
  let consent = "enabled";
  const captures: string[] = [];
  const navigator = { doNotTrack: "0", globalPrivacyControl: false };
  const posthog = {
    init() {},
    get_explicit_consent_status: () => "granted",
    startSessionRecording() {}, stopSessionRecording() {}, reset() {}, opt_out_capturing() {},
    has_opted_out_capturing: () => false,
    get_distinct_id: () => "test-id", get_session_id: () => "test-session",
    capture: (name: string) => captures.push(name),
  };
  const client = load("lib/posthog-client.ts", {
    "./diagnostics": { DIAGNOSTICS_COOKIE: "test", diagnosticId: (value: unknown) => value },
    "posthog-js": { __esModule: true, default: posthog },
  }, {
    process: { env: { NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: "test", NODE_ENV: "test" } },
    window: { localStorage: { getItem: () => consent }, location: { hostname: "localhost" } },
    document: { cookie: "" }, navigator, location: { protocol: "http:" },
  }) as typeof import("./posthog-client.ts");
  await client.enableProductAnalytics();
  client.captureProductEvent("allowed");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(captures, ["allowed"]);
  client.captureProductEvent("queued_before_opt_out");
  consent = "disabled";
  client.disableProductAnalytics();
  await new Promise(resolve => setImmediate(resolve));
  client.captureProductEvent("disabled");
  assert.deepEqual(captures, ["allowed"]);
  consent = "enabled";
  await client.enableProductAnalytics();
  navigator.doNotTrack = "1";
  client.captureProductEvent("dnt");
  await new Promise(resolve => setImmediate(resolve));
  navigator.doNotTrack = "0";
  navigator.globalPrivacyControl = true;
  client.captureProductEvent("gpc");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(captures, ["allowed"]);
});
