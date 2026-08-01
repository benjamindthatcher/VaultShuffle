import assert from "node:assert/strict";
import test from "node:test";
import {
  completionFromDuration,
  estimatedTimeToBeatMinutes,
  formatGameDuration,
  getPreferredDurationMinutes
} from "./game-duration.ts";

test("uses the average of every available estimate rounded to an hour", () => {
  const duration = {
    mainStoryMinutes: 600,
    mainExtrasMinutes: 900,
    completionistMinutes: 1_500
  };

  assert.equal(estimatedTimeToBeatMinutes(duration), 1_020);
  assert.equal(getPreferredDurationMinutes(duration), 1_020);
});

test("averages whichever positive provider estimates are available", () => {
  assert.equal(estimatedTimeToBeatMinutes({
    mainStoryMinutes: null,
    mainExtrasMinutes: 600,
    completionistMinutes: 1_200
  }), 900);
});

test("endless games always display Endless and use 99% progress with no playtime", () => {
  const duration = { endless: true };
  assert.equal(formatGameDuration(duration), "Endless");
  assert.equal(completionFromDuration(0, duration), 99);
});

test("displays finite estimates without an About prefix", () => {
  assert.equal(formatGameDuration({ mainStoryMinutes: 5_640 }), "94h estimated");
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

test("derives progress from the averaged duration instead of stale stored percentages", () => {
  assert.equal(completionFromDuration(17.5, { mainStoryMinutes: 2_580 }), 41);
  assert.equal(completionFromDuration(10.1, { mainStoryMinutes: 780 }), 78);
});
