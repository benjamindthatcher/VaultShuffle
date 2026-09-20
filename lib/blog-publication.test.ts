import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { BLOG_SCHEDULE, isUnpublishedArticle } from "./blog/schedule.ts";

function registry(environment: "development" | "production", now = "2026-09-20T12:00:00Z") {
  const source = readFileSync(new URL("./blog/posts.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const loaded = { exports: {} };
  class PublicationClock extends Date {
    constructor(value: string | number = now) { super(value); }
    static now() { return new Date(now).getTime(); }
  }
  new Function("require", "module", "exports", "process", "Date", compiled)(
    (name: string) => name === "@/lib/blog/schedule" ? { BLOG_SCHEDULE } : {}, loaded, loaded.exports, { env: { NODE_ENV: environment } },
    PublicationClock,
  );
  return loaded.exports as typeof import("./blog/posts");
}

test("an explicit blog draft cannot publish merely because its date passes", () => {
  const posts = registry("production");
  const draft = { ...posts.BLOG_POSTS[0], draft: true };
  assert.equal(posts.isPublished(draft, new Date("2030-01-01")), false);
  assert.equal(posts.isPublished({ ...draft, draft: false }, new Date("2030-01-01")), true);
});

test("production listings exclude scheduled posts even when previews are requested", () => {
  const posts = registry("production");
  assert.equal(posts.canPreviewScheduled(), false);
  for (const options of [{}, { includeScheduled: true }]) {
    const publicPosts = posts.listPosts(options);
    assert.ok(publicPosts.some((post) => post.slug === "steam-deck-games-you-can-beat-in-under-10-hours"));
    assert.ok(publicPosts.every((post) => !post.draft));
    assert.ok(publicPosts.every((post) => post.slug !== "how-to-choose-your-next-steam-game"));
  }
});

test("development previews show scheduled posts without publishing them", () => {
  const posts = registry("development");
  assert.ok(posts.listPosts({ includeScheduled: true }).some((post) => post.slug === "how-to-choose-your-next-steam-game"));
  assert.ok(posts.listPosts().every((post) => post.slug !== "how-to-choose-your-next-steam-game"));
  const scheduled = { ...posts.BLOG_POSTS[0], draft: false, published: "2030-01-01" };
  assert.equal(posts.isPublished(scheduled, new Date("2029-12-31T23:59:59Z")), false);
  assert.equal(posts.isPublished(scheduled, new Date("2030-01-01T00:00:00Z")), true);
});

test("the next Steam game article becomes public at midnight UTC on 28 September", () => {
  const before = registry("production", "2026-09-27T23:59:59.999Z");
  const after = registry("production", "2026-09-28T00:00:00.000Z");
  const slug = "how-to-choose-your-next-steam-game";
  const post = before.getPost(slug)!;
  assert.equal(post.published, "2026-09-28");
  assert.equal(Boolean(post.draft), false);
  assert.equal(before.isPublished(post), false);
  assert.equal(before.listPosts().some((entry) => entry.slug === slug), false);
  assert.equal(after.isPublished(post), true);
  assert.equal(after.listPosts().some((entry) => entry.slug === slug), true);
});

test("published article metadata becomes indexable", async () => {
  const source = readFileSync(new URL("../app/blog/[slug]/page.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const slug = "how-to-choose-your-next-steam-game";
  for (const published of [false, true]) {
    const posts = registry("production", published ? "2026-09-28T00:00:00Z" : "2026-09-27T23:59:59Z");
    const loaded = { exports: {} };
    new Function("require", "module", "exports", compiled)((name: string) => {
      if (name === "@/lib/blog/posts") return posts;
      if (name === "@/lib/site") return {
        siteConfig: { name: "VaultShuffle", url: "https://vaultshuffle.com" },
        pageOpenGraph: () => ({}), pageTwitter: () => ({}),
      };
      return {};
    }, loaded, loaded.exports);
    const route = loaded.exports as typeof import("../app/blog/[slug]/page");
    const metadata = await route.generateMetadata({ params: Promise.resolve({ slug }) });
    assert.deepEqual(metadata.robots, published
      ? { index: true, follow: true, googleBot: { "max-image-preview": "large" } }
      : { index: false, follow: false });
    if (published) assert.equal(metadata.alternates?.canonical, `/blog/${slug}`);
  }
});


test("the request gate blocks early visits but releases the same URL on schedule", () => {
  const path = "/blog/how-to-choose-your-next-steam-game";
  const before = Date.parse("2026-09-27T23:59:59.999Z");
  const after = Date.parse("2026-09-28T00:00:00Z");
  assert.equal(isUnpublishedArticle(path, before), true);
  assert.equal(isUnpublishedArticle(path + "/", before), true);
  assert.equal(isUnpublishedArticle(path.replace("how", "%68ow"), before), true);
  assert.equal(isUnpublishedArticle(path, after), false);
  assert.equal(isUnpublishedArticle("/blog", before), false);
  assert.equal(isUnpublishedArticle("/blog/unknown", before), false);
  assert.equal(isUnpublishedArticle("/blog/steam-deck-games-you-can-beat-in-under-10-hours", before), false);
});
