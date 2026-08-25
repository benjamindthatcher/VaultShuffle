import assert from "node:assert/strict";
import test from "node:test";
import {
  describeRecency,
  idleForAtLeast,
  playedWithin,
  recencySortKey,
  strongerEvidence,
  STEAM_RECENT_WINDOW_DAYS
} from "./recency.ts";

const NOW = new Date("2026-08-25T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86400000).toISOString();

test("no evidence is unknown, not ancient", () => {
  const recency = describeRecency(null, NOW);
  assert.equal(recency.known, false);
  assert.equal(recency.daysSince, null);
  assert.equal(recency.label, null);
  // The bug this whole model exists to remove.
  assert.notEqual(recency.daysSince, Number.POSITIVE_INFINITY);
});

test("an empty row is unknown rather than never played", () => {
  const recency = describeRecency({ lastObservedPlayedAt: null, recencySource: null, recencyEvidenceAt: null }, NOW);
  assert.equal(recency.known, false);
});

test("unknown recency cannot be called abandoned at any threshold", () => {
  const unknown = describeRecency(null, NOW);
  assert.equal(idleForAtLeast(unknown, 1), false);
  assert.equal(idleForAtLeast(unknown, 180), false);
  assert.equal(idleForAtLeast(unknown, 100000), false);
});

test("unknown recency is not claimed as recently played either", () => {
  assert.equal(playedWithin(describeRecency(null, NOW), 14), false);
});

test("an observed playtime rise gives a precise day", () => {
  const recency = describeRecency(
    { lastObservedPlayedAt: daysAgo(3), recencySource: "observed_playtime_change" },
    NOW
  );
  assert.equal(recency.known, true);
  assert.equal(recency.precise, true);
  assert.equal(Math.round(recency.daysSince!), 3);
  assert.equal(recency.label, "Played 3 days ago");
});

test("recent-window evidence is honest about not knowing the day", () => {
  const recency = describeRecency(
    { recencySource: "steam_recent_window", recencyEvidenceAt: daysAgo(1) },
    NOW
  );
  assert.equal(recency.known, true);
  assert.equal(recency.precise, false);
  assert.equal(recency.label, "Played recently");
  // It could have been up to a fortnight before we looked.
  assert.ok(recency.daysSinceAtMost! >= STEAM_RECENT_WINDOW_DAYS);
});

test("an old window observation still dates the activity, approximately", () => {
  const recency = describeRecency(
    { recencySource: "steam_recent_window", recencyEvidenceAt: daysAgo(90) },
    NOW
  );
  assert.equal(recency.precise, false);
  assert.match(recency.label!, /^Played about 3 months ago$/);
});

test("a window's uncertainty cannot tip a game over an abandonment threshold", () => {
  // Seen 179 days ago, so it was played somewhere between 179 and 193 days ago.
  // That is not evidence it crossed 180.
  const recency = describeRecency(
    { recencySource: "steam_recent_window", recencyEvidenceAt: daysAgo(179) },
    NOW
  );
  assert.equal(idleForAtLeast(recency, 180), false);
  assert.equal(idleForAtLeast(recency, 170), true);
});

test("an exact Steam timestamp is still used when it exists", () => {
  const recency = describeRecency(
    { lastObservedPlayedAt: daysAgo(400), recencySource: "steam_exact" },
    NOW
  );
  assert.equal(recency.known, true);
  assert.equal(recency.precise, true);
  assert.equal(recency.label, "Played a year ago");
  assert.equal(idleForAtLeast(recency, 365), true);
});

test("today and yesterday read as themselves", () => {
  assert.equal(
    describeRecency({ lastObservedPlayedAt: daysAgo(0), recencySource: "observed_playtime_change" }, NOW).label,
    "Played today"
  );
  assert.equal(
    describeRecency({ lastObservedPlayedAt: daysAgo(1), recencySource: "observed_playtime_change" }, NOW).label,
    "Played yesterday"
  );
});

test("unknown sorts last, not first and not oldest", () => {
  const known = describeRecency({ lastObservedPlayedAt: daysAgo(500), recencySource: "steam_exact" }, NOW);
  const unknown = describeRecency(null, NOW);
  assert.ok(recencySortKey(unknown) > recencySortKey(known));
});

test("weaker window evidence does not overwrite a watched playtime rise", () => {
  const observed = { lastObservedPlayedAt: daysAgo(1), recencySource: "observed_playtime_change" as const };
  const window = { recencySource: "steam_recent_window" as const, recencyEvidenceAt: daysAgo(1) };
  assert.equal(strongerEvidence(observed, window, NOW), observed);
});

test("newer activity does overwrite older evidence", () => {
  const old = { lastObservedPlayedAt: daysAgo(200), recencySource: "steam_exact" as const };
  const fresh = { lastObservedPlayedAt: daysAgo(2), recencySource: "observed_playtime_change" as const };
  assert.equal(strongerEvidence(old, fresh, NOW), fresh);
});

test("evidence never replaces something with nothing", () => {
  const known = { lastObservedPlayedAt: daysAgo(5), recencySource: "observed_playtime_change" as const };
  const nothing = { recencySource: null, lastObservedPlayedAt: null };
  assert.equal(strongerEvidence(known, nothing, NOW), known);
});

test("first evidence is taken when there was none", () => {
  const incoming = { recencySource: "steam_recent_window" as const, recencyEvidenceAt: daysAgo(0) };
  assert.equal(strongerEvidence(null, incoming, NOW), incoming);
});
