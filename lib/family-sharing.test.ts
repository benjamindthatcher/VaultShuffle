import assert from "node:assert/strict";
import test from "node:test";
import {
  canClaimNeverPlayed,
  describeFamilyImport,
  familyImportCounts,
  familyProvenance,
  familyShareEligibility,
  isFamilyAccess,
  planFamilyImport,
  playtimeIsUnknown,
  type FamilyCandidate
} from "./family-sharing.ts";

function candidate(steamAppId: string, facts: FamilyCandidate["facts"] = {}): FamilyCandidate {
  return { steamAppId, title: `Game ${steamAppId}`, facts };
}

test("a game Steam marks as family-shareable is eligible", () => {
  assert.equal(
    familyShareEligibility({ categories: ["Single-player", "Family Sharing"] }),
    "eligible"
  );
});

test("a game whose publisher has opted out is not shareable", () => {
  // The categories are present, so this is a real answer rather than a gap.
  assert.equal(familyShareEligibility({ categories: ["Single-player", "Steam Cloud"] }), "not_shareable");
});

test("missing categories are unknown, never a refusal", () => {
  // The catalogue fills in lazily. Treating a not-yet-fetched game as
  // ineligible would silently drop real games from the family shelf.
  assert.equal(familyShareEligibility({ categories: null }), "unknown");
  assert.equal(familyShareEligibility({ categories: [] }), "unknown");
});

test("free games are excluded even when they carry the category", () => {
  // Nobody needs a family to play a free game, and free titles are most of the
  // difference between two people's public libraries.
  assert.equal(
    familyShareEligibility({ categories: ["Family Sharing"], isFree: true }),
    "free"
  );
});

test("quarantined catalogue entries never reach the family shelf", () => {
  assert.equal(
    familyShareEligibility({ categories: ["Family Sharing"], quarantined: true }),
    "not_shareable"
  );
});

test("games the player already owns are set aside, not reported as excluded", () => {
  const plan = planFamilyImport(
    [candidate("10", { categories: ["Steam Cloud"] })],
    ["10"]
  );
  assert.equal(plan.alreadyOwned.length, 1);
  assert.equal(plan.excluded.length, 0);
  assert.equal(plan.importable.length, 0);
});

test("the plan sorts a real shelf into four honest buckets", () => {
  const plan = planFamilyImport(
    [
      candidate("1", { categories: ["Family Sharing"] }),
      candidate("2", { categories: ["Single-player"] }),
      candidate("3", { categories: null }),
      candidate("4", { categories: ["Family Sharing"] }),
      candidate("5", { categories: ["Family Sharing"], isFree: true })
    ],
    ["4"]
  );

  assert.deepEqual(plan.importable.map((game) => game.steamAppId), ["1"]);
  assert.deepEqual(plan.alreadyOwned.map((game) => game.steamAppId), ["4"]);
  assert.deepEqual(plan.excluded.map((game) => game.steamAppId), ["2", "5"]);
  assert.deepEqual(plan.pending.map((game) => game.steamAppId), ["3"]);
  assert.deepEqual(familyImportCounts(plan), {
    seen: 5,
    importable: 1,
    alreadyOwned: 1,
    excluded: 2,
    pending: 1
  });
});

test("a duplicated AppID is counted once", () => {
  const plan = planFamilyImport(
    [candidate("1", { categories: ["Family Sharing"] }), candidate("1", { categories: ["Family Sharing"] })],
    []
  );
  assert.equal(plan.importable.length, 1);
});

test("the summary names every bucket it has a number for", () => {
  const plan = planFamilyImport(
    [
      candidate("1", { categories: ["Family Sharing"] }),
      candidate("2", { categories: ["Single-player"] })
    ],
    []
  );
  const sentence = describeFamilyImport(familyImportCounts(plan), "Sam");
  assert.match(sentence, /2 games on Sam's shelf/);
  assert.match(sentence, /1 look shareable/);
  assert.match(sentence, /1 cannot be shared/);
});

test("a family game's zero hours is never read as never played", () => {
  // The whole reason access source exists. hours_played = 0 on a family row
  // means "never told" - the only playtime that exists is the owner's.
  assert.equal(canClaimNeverPlayed({ accessSource: "family", hoursPlayed: 0 }), false);
  assert.equal(canClaimNeverPlayed({ accessSource: "owned", hoursPlayed: 0 }), true);
  // A row written before the feature existed has no access source and is owned.
  assert.equal(canClaimNeverPlayed({ hoursPlayed: 0 }), true);
  // Real hours on an owned game are not "never played" either.
  assert.equal(canClaimNeverPlayed({ accessSource: "owned", hoursPlayed: 3 }), false);
});

test("playtime is unknown for family games and known for everything else", () => {
  assert.equal(playtimeIsUnknown({ accessSource: "family" }), true);
  assert.equal(playtimeIsUnknown({ accessSource: "owned" }), false);
  assert.equal(playtimeIsUnknown({}), false);
});

test("owned games are not family games", () => {
  assert.equal(isFamilyAccess("owned"), false);
  assert.equal(isFamilyAccess(undefined), false);
  assert.equal(isFamilyAccess(null), false);
  assert.equal(isFamilyAccess("family"), true);
});

test("an owned game carries no provenance line at all", () => {
  assert.equal(familyProvenance({ accessSource: "owned", familyOwnerName: null }), null);
  assert.equal(familyProvenance({ accessSource: undefined, familyOwnerName: null }), null);
});

test("a family game names whose library it came from", () => {
  const line = familyProvenance({ accessSource: "family", familyOwnerName: "Sam" });
  assert.match(String(line), /Sam's Steam library/);
  // And says why there is no playtime, which is the only caveat that matters.
  assert.match(String(line), /Playtime is theirs/);
});

test("a family game with no known owner still explains itself", () => {
  // The roster and the library load separately, so the name can genuinely be
  // missing for a moment. It must never fall back to a raw Steam ID.
  const line = familyProvenance({ accessSource: "family", familyOwnerName: null });
  assert.match(String(line), /a family member's Steam library/);
  assert.doesNotMatch(String(line), /\d{6}/);
});
