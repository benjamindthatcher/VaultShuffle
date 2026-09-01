import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDurationReviewResponse,
  durationReviewSubmissionSchema,
} from "./duration-review-input.ts";

test("recognises an exact HLTB game URL", () => {
  assert.deepEqual(
    classifyDurationReviewResponse(" https://howlongtobeat.com/game/131658 "),
    {
      responseText: "https://howlongtobeat.com/game/131658",
      responseKind: "hltb_url",
      sourceUrl: "https://howlongtobeat.com/game/131658",
    },
  );
});

test("keeps a plain-language classification as a note", () => {
  assert.deepEqual(classifyDurationReviewResponse("Endless multiplayer game"), {
    responseText: "Endless multiplayer game",
    responseKind: "note",
    sourceUrl: null,
  });
});

test("does not mistake a search page or another host for an HLTB game", () => {
  assert.equal(classifyDurationReviewResponse("https://howlongtobeat.com/?q=Payday").responseKind, "note");
  assert.equal(classifyDurationReviewResponse("https://example.com/game/123").responseKind, "note");
});

test("requires a positive AppID and a non-empty response", () => {
  assert.equal(durationReviewSubmissionSchema.safeParse({ steamAppId: 0, response: "note" }).success, false);
  assert.equal(durationReviewSubmissionSchema.safeParse({ steamAppId: 123, response: "   " }).success, false);
  assert.equal(durationReviewSubmissionSchema.safeParse({ steamAppId: 123, response: "not popular enough" }).success, true);
});
