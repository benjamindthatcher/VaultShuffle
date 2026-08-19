import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Vercel's Hobby plan allows 1,000 image optimisation transformations a month,
 * and each unique source x width x quality x format counts as one. Routing
 * remote game artwork through next/image scales that with library size, which
 * consumed 75% of the monthly allowance in a few weeks.
 *
 * Steam serves its images at the exact sizes rendered (capsule_231x87.jpg,
 * header.jpg at 460x215) from its own CDN, so optimising them re-encodes an
 * already-optimised file for no benefit. These tests fail if that regresses.
 */

function sourceFiles(dir: string, out: string[] = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx$/.test(entry)) out.push(path);
  }
  return out;
}

function imageElements(source: string) {
  return [...source.matchAll(/<Image\b[\s\S]*?\/>/g)].map((match) => match[0]);
}

test("remote images are never routed through the Vercel optimiser", () => {
  const offenders: string[] = [];
  for (const file of [...sourceFiles("app"), ...sourceFiles("components")]) {
    for (const element of imageElements(readFileSync(file, "utf8"))) {
      const hasRemoteLiteral = /src=["']https?:\/\//.test(element);
      if (hasRemoteLiteral && !/\bunoptimized\b/.test(element)) {
        offenders.push(`${file}: remote <Image> without unoptimized`);
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

test("the shared Artwork component opts remote Steam art out of optimisation", () => {
  const source = readFileSync("components/shared/Artwork.tsx", "utf8");
  assert.match(source, /unoptimized=\{isSteamHosted\(/);
  assert.match(source, /steamstatic\\\.com/);
});

test("image config keeps the per-image transformation count at one", () => {
  const config = readFileSync("next.config.mjs", "utf8");
  const formats = config.match(/formats:\s*\[([^\]]*)\]/)?.[1] ?? "";
  const qualities = config.match(/qualities:\s*\[([^\]]*)\]/)?.[1] ?? "";

  // Each extra format and each extra quality multiplies transformations per image.
  assert.equal(formats.split(",").filter((value) => value.trim()).length, 1, "one output format only");
  assert.equal(qualities.split(",").filter((value) => value.trim()).length, 1, "one quality only");

  // A short cache means the same transformation is billed repeatedly.
  const ttl = Number(config.match(/minimumCacheTTL:\s*(\d+)/)?.[1] ?? 0);
  assert.ok(ttl >= 2678400, `minimumCacheTTL should be at least 31 days, got ${ttl}`);
});
