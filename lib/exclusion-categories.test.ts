import assert from "node:assert/strict";
import test from "node:test";
import {
  EXCLUSION_CATEGORIES,
  availableExclusionCategories,
  exclusionCategoriesFor,
  exclusionCategory,
  isExclusionCategory
} from "./exclusion-categories.ts";

test("every category has a unique id and at least one signal to match on", () => {
  const ids = EXCLUSION_CATEGORIES.map((category) => category.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const category of EXCLUSION_CATEGORIES) {
    assert.ok(category.label.length, `${category.id} needs a label`);
    assert.ok(
      category.tags.length || category.categories?.length,
      `${category.id} would never match anything`
    );
    // Tags are compared lowercased, so a capitalised entry here would silently
    // never fire.
    for (const tag of category.tags) assert.equal(tag, tag.toLowerCase(), `${category.id}: "${tag}"`);
  }
});

test("the ARPG category catches what the feedback named", () => {
  // Last Epoch, with its real vote counts.
  const lastEpoch = exclusionCategoriesFor({
    tags: {
      "Action RPG": 412, Loot: 348, "Hack and Slash": 300, RPG: 272, Isometric: 206,
      Multiplayer: 199, Action: 133, "Co-op": 122
    },
    genres: ["RPG", "Action"],
    categories: ["Single-player", "Multi-player", "Co-op"]
  });
  assert.ok(lastEpoch.includes("arpg"));

  // Diablo IV.
  assert.ok(exclusionCategoriesFor({
    tags: { "Action RPG": 1000, "Hack and Slash": 780, Loot: 720, Singleplayer: 450 }
  }).includes("arpg"));
});

test("Age of Empires lands in Strategy, which is what that complaint actually wanted", () => {
  const aoe = exclusionCategoriesFor({
    tags: {
      Strategy: 947, RTS: 621, "City Builder": 514, Multiplayer: 467, Historical: 342,
      Singleplayer: 333, Medieval: 324, "Base-Building": 431, "Resource Management": 274
    },
    genres: ["Strategy"],
    categories: ["Single-player", "Multi-player", "PvP", "Online PvP", "LAN PvP"]
  });
  assert.ok(aoe.includes("strategy"));
  // It is not an ARPG and not horror, and a control that claimed otherwise would
  // hide games the user did not ask to hide.
  assert.ok(!aoe.includes("arpg"));
  assert.ok(!aoe.includes("horror"));
});

test("a minority tag does not hide a game", () => {
  // A comedy platformer carrying a handful of Horror votes is not horror. At
  // 5% of the top tag it is nowhere near the 40% share the control needs.
  const platformer = exclusionCategoriesFor({
    tags: { Platformer: 2000, Funny: 1800, Comedy: 1500, Horror: 100 }
  });
  assert.ok(platformer.includes("platformer"));
  assert.ok(!platformer.includes("horror"));

  // At 40% it does count: the game is substantially being described that way.
  assert.ok(exclusionCategoriesFor({
    tags: { Platformer: 2000, Horror: 800 }
  }).includes("horror"));
});

test("Steam's own genre strings count in full", () => {
  // Publisher-set rather than voted on, so one is a statement. A game with no
  // crowd tags at all still classifies.
  assert.deepEqual(exclusionCategoriesFor({ tags: {}, genres: ["Horror"] }), ["horror"]);
  assert.ok(exclusionCategoriesFor({ genres: ["Sports"] }).includes("sports-racing"));
});

test("VR and couch play are read from the official categories, not from votes", () => {
  // A VR-only game is unplayable without a headset, so this has to work even
  // when the crowd never tagged it.
  assert.ok(exclusionCategoriesFor({
    tags: { Simulation: 100 },
    categories: ["Single-player", "VR Only"]
  }).includes("vr"));

  assert.ok(exclusionCategoriesFor({
    tags: { Action: 100 },
    categories: ["Multi-player", "Shared/Split Screen"]
  }).includes("party"));
});

test("a game with nothing to go on falls into no category at all", () => {
  // The safe direction: absent membership must never hide anything.
  assert.deepEqual(exclusionCategoriesFor({}), []);
  assert.deepEqual(exclusionCategoriesFor({ tags: null, genres: null, categories: null }), []);
  assert.deepEqual(exclusionCategoriesFor({ tags: { Weird: 0 } }), []);
});

test("a game can belong to more than one category", () => {
  // Vermintide 2: co-op, competitive-adjacent and a loot grinder at once.
  const many = exclusionCategoriesFor({
    tags: { "Co-op": 1000, Loot: 700, "Hack and Slash": 650, "Action RPG": 600, Horror: 500 }
  });
  assert.ok(many.includes("arpg"));
  assert.ok(many.includes("horror"));
});

test("only categories present in a library are worth offering", () => {
  const present = availableExclusionCategories([["horror"], ["arpg", "horror"], undefined, []]);
  assert.deepEqual([...present].sort(), ["arpg", "horror"]);
});

test("ids are validated so stored rubbish cannot become a filter", () => {
  assert.ok(isExclusionCategory("horror"));
  assert.ok(!isExclusionCategory("Horror"));
  assert.ok(!isExclusionCategory("made-up"));
  assert.ok(!isExclusionCategory(7));
  assert.equal(exclusionCategory("horror")?.label, "Horror");
  assert.equal(exclusionCategory("nope"), null);
});
