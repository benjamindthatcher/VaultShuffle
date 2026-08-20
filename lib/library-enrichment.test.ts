import assert from "node:assert/strict";
import test from "node:test";
import type { DemoGame } from "./demo-data.ts";
import { measureLibraryEnrichment } from "./library-enrichment.ts";

const game = (overrides: Partial<DemoGame> = {}) =>
  ({ id: "g", title: "Game", ownership: "Owned", genres: ["Action"],
     durationStatus: "ready", tagsStatus: "ready", ...overrides }) as unknown as DemoGame;

test("a settled library reports nothing in flight", () => {
  const measure = measureLibraryEnrichment([game(), game({ id: "b" })]);
  assert.equal(measure.processing, 0);
  assert.equal(measure.percent, 100);
});

test("a game with no length found is settled, not still processing", () => {
  // Enrichment ran and concluded there is nothing to find — an endless game has
  // no campaign, and obscure titles are in no duration database. Reporting that
  // as in-progress is untrue and never resolves.
  const measure = measureLibraryEnrichment([
    game({ durationStatus: "review_required" }),
    game({ id: "b", durationStatus: "no_match" }),
    game({ id: "c", durationStatus: "failed" })
  ]);
  assert.equal(measure.processing, 0);
});

test("queued and running work does count", () => {
  const measure = measureLibraryEnrichment([
    game({ durationStatus: "pending" }),
    game({ id: "b", tagsStatus: "processing" }),
    game({ id: "c" })
  ]);
  assert.equal(measure.processing, 2);
});

test("a freshly imported game with no catalogue row yet counts", () => {
  const measure = measureLibraryEnrichment([
    game({ id: "fresh", genres: ["Unknown"], durationStatus: null, tagsStatus: null } as Partial<DemoGame>)
  ]);
  assert.equal(measure.processing, 1);
});

test("an empty library does not divide by zero", () => {
  assert.equal(measureLibraryEnrichment([]).percent, 100);
});
