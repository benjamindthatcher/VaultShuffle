import assert from "node:assert/strict";
import test from "node:test";
import {
  estimatedTimeToBeatMinutes,
  getPreferredDurationMinutes
} from "./game-duration.ts";

test("uses the midpoint of main-story and completionist estimates rounded to an hour", () => {
  const duration = {
    mainStoryMinutes: 600,
    mainExtrasMinutes: 900,
    completionistMinutes: 1_500
  };

  assert.equal(estimatedTimeToBeatMinutes(duration), 1_080);
  assert.equal(getPreferredDurationMinutes(duration), 1_080);
});

test("rounds the best available provider fallback to the closest hour", () => {
  assert.equal(estimatedTimeToBeatMinutes({ mainStoryMinutes: 610 }), 600);
  assert.equal(estimatedTimeToBeatMinutes({ mainExtrasMinutes: 690 }), 720);
  assert.equal(estimatedTimeToBeatMinutes({ completionistMinutes: 1_410 }), 1_440);
});

test("does not turn a short valid duration into an unavailable zero", () => {
  assert.equal(estimatedTimeToBeatMinutes({
    mainStoryMinutes: 10,
    completionistMinutes: 20
  }), 60);
});

test("returns null when no positive duration exists", () => {
  assert.equal(estimatedTimeToBeatMinutes({
    mainStoryMinutes: 0,
    mainExtrasMinutes: null,
    completionistMinutes: -1
  }), null);
});
