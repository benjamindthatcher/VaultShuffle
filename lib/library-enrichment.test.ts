import assert from "node:assert/strict";
import test from "node:test";
import type { DemoGame } from "./demo-data.ts";
import { measureLibraryEnrichment } from "./library-enrichment.ts";

const game = (overrides: Partial<DemoGame> = {}) =>
  ({ id: "g", title: "Game", ownership: "Owned", genres: ["Action"],
     duration: { mainStoryMinutes: 600 }, ...overrides }) as unknown as DemoGame;

test("a fully known library reports complete", () => {
  const measure = measureLibraryEnrichment([game(), game({ id: "b" })]);
  assert.equal(measure.percent, 100);
  assert.equal(measure.ready, 2);
});

test("missing lengths and genres are counted separately", () => {
  const measure = measureLibraryEnrichment([
    game(),
    game({ id: "b", duration: undefined } as Partial<DemoGame>),
    game({ id: "c", genres: ["Unknown"] })
  ]);
  assert.equal(measure.missingLength, 1);
  assert.equal(measure.missingGenres, 1);
  assert.equal(measure.ready, 1);
});

test("an endless game counts as known, not missing", () => {
  // Having no estimate because a game has no ending is knowledge, not a gap.
  const measure = measureLibraryEnrichment([
    game({ duration: { mainStoryMinutes: null, endless: true } } as Partial<DemoGame>)
  ]);
  assert.equal(measure.missingLength, 0);
  assert.equal(measure.percent, 100);
});

test("an empty library does not divide by zero", () => {
  assert.equal(measureLibraryEnrichment([]).percent, 100);
});
