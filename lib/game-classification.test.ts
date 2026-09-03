import assert from "node:assert/strict";
import test from "node:test";
import {
  gameProgress,
  hasCorroboratedOnlineLoop,
  hasEndlessDurationShape,
  hasStrongReplayabilitySignals,
  isStoryDriven,
  isEndlessGame,
  endlessVerdict
} from "./game-classification.ts";

test("finite progress is derived from the averaged duration rather than stale stored progress", () => {
  assert.equal(gameProgress({
    title: "The Witcher 2",
    genre: "RPG",
    hours_played: 17.5,
    completion_percentage: 94,
    status: "In Progress",
    main_story_minutes: 1_560,
    main_extras_minutes: 2_580,
    completionist_minutes: 3_600,
    duration_kind: "finite"
  }), 41);

  assert.equal(gameProgress({
    title: "Call of Duty: Modern Warfare",
    genre: "Action",
    hours_played: 10.1,
    completion_percentage: 99,
    status: "In Progress",
    main_story_minutes: 600,
    main_extras_minutes: 780,
    completionist_minutes: 960,
    duration_kind: "finite"
  }), 78);
});

test("explicit finite duration classification prevents broad title/tag fallbacks becoming endless", () => {
  const game = {
    title: "Fancy Skulls",
    genre: "Action / Indie / Free to Play / Early Access",
    hours_played: 4.5,
    duration_kind: "finite" as const,
    main_story_minutes: 240,
    main_extras_minutes: 300,
    completionist_minutes: 360
  };

  assert.equal(isEndlessGame(game), false);
  assert.equal(gameProgress(game), 90);
});

test("explicit endless classification always reports 99 percent even at zero hours", () => {
  const game = {
    title: "Apex Legends",
    genre: "Action",
    hours_played: 0,
    duration_kind: "endless" as const
  };

  assert.equal(isEndlessGame(game), true);
  assert.equal(gameProgress(game), 99);
});

test("a decisive tag only counts when it dominates the game's tags", () => {
  // Runner3 is a linear platformer carrying a minority "Massively Multiplayer"
  // vote; Valheim's survival-craft tag is its top tag.
  assert.equal(hasStrongReplayabilitySignals({
    tags: { "Platformer": 94, "Massively Multiplayer": 42 }, genres: [], categories: []
  }), false);
  assert.equal(hasStrongReplayabilitySignals({
    tags: { "Open World Survival Craft": 2379, "Survival": 2100 }, genres: [], categories: []
  }), true);
});

test("a completion time far beyond the story length reads as endless", () => {
  // Counter-Strike 2: 1h story, 186h completionist.
  assert.equal(hasEndlessDurationShape({ mainStoryMinutes: 60, completionistMinutes: 11160 }), true);
  // A normal long RPG stays finite.
  assert.equal(hasEndlessDurationShape({ mainStoryMinutes: 2400, completionistMinutes: 6000 }), false);
  assert.equal(hasEndlessDurationShape({ mainStoryMinutes: null, completionistMinutes: null }), false);
});

test("a story-driven game is not endless, even with survival-craft tags", () => {
  // Subnautica: Below Zero carries "Open World Survival Craft" at 100% share but
  // has an ending; Valheim carries the same tag and does not.
  assert.equal(hasStrongReplayabilitySignals({
    tags: { "Open World Survival Craft": 2000, "Story Rich": 1900 }, genres: [], categories: []
  }), false);
  assert.equal(hasStrongReplayabilitySignals({
    tags: { "Open World Survival Craft": 2379, "Survival": 2100 }, genres: [], categories: []
  }), true);
});

test("a persistent online world stays endless despite a story", () => {
  // Final Fantasy XI is story rich and an MMO.
  assert.equal(isStoryDriven({ "Story Rich": 500, "MMORPG": 900 }), false);
  assert.equal(isStoryDriven({ "Story Rich": 500, "Singleplayer": 900 }), true);
});

test("persisted endless classification requires official multiplayer corroboration", () => {
  assert.equal(hasCorroboratedOnlineLoop({
    tags: { "Battle Royale": 900, "Shooter": 1000 },
    genres: ["Action"],
    categories: ["Multi-player", "PvP"]
  }), true);
  assert.equal(hasCorroboratedOnlineLoop({
    tags: { "Battle Royale": 900, "Shooter": 1000 },
    genres: ["Action"],
    categories: []
  }), false);
});

test("official single-player and story signals veto persisted endless classification", () => {
  assert.equal(hasCorroboratedOnlineLoop({
    tags: { "MOBA": 900 },
    genres: ["Action"],
    categories: ["Single-player", "Multi-player"]
  }), false);
  assert.equal(hasCorroboratedOnlineLoop({
    tags: { "Story Rich": 900, "Battle Royale": 1000 },
    genres: ["Action"],
    categories: ["Multi-player", "PvP"]
  }), false);
});

test("generic competitive tags need meaningful vote share", () => {
  assert.equal(hasCorroboratedOnlineLoop({
    tags: { "FPS": 1000, "PvP": 360 },
    genres: ["Action"],
    categories: ["Multi-player"]
  }), true);
  assert.equal(hasCorroboratedOnlineLoop({
    tags: { "FPS": 1000, "PvP": 340 },
    genres: ["Action"],
    categories: ["Multi-player"]
  }), false);
});

test("team-based co-op alone is not persisted as endless", () => {
  assert.equal(hasCorroboratedOnlineLoop({
    tags: { "Tactical RPG": 1000, "Team-Based": 900, "Co-op": 850 },
    genres: ["RPG", "Strategy"],
    categories: ["Multi-player", "Co-op"]
  }), false);
  assert.equal(hasCorroboratedOnlineLoop({
    tags: { "Tactical RPG": 1000, "Team-Based": 900, "Co-op": 850 },
    genres: ["RPG", "Strategy"],
    categories: ["Multi-player", "PvP"]
  }), true);
});

test("the competitive loop is read from tag share, not from a single-player category", () => {
  // Rainbow Six Siege: HowLongToBeat records a 3h19 "story", so the catalogue
  // called it finite. Its tags are 91% competitive against its top tag, and it
  // lists Single-player like almost every game on Steam does.
  const siege = endlessVerdict({
    tags: {
      FPS: 9892, PvP: 9194, Tactical: 9103, Multiplayer: 9103, "e-sports": 9102,
      Competitive: 9007, Shooter: 9091, Action: 8949, "Hero Shooter": 8901
    },
    genres: ["Action"],
    categories: ["Single-player", "Multi-player", "PvP", "Online PvP", "Co-op"],
    mainStoryMinutes: 199,
    completionistMinutes: null
  });
  assert.equal(siege.endless, true);
  assert.ok(siege.witnesses.includes("competitive-loop"));

  // Rocket League, the same shape at a lower share: Competitive is 69% of its
  // top tag. It takes the largest popularity boost in the "has an ending" filter.
  const rocketLeague = endlessVerdict({
    tags: {
      Multiplayer: 6610, "Football (Soccer)": 5241, Competitive: 4577, Sports: 4018,
      Racing: 3889, "Team-Based": 3425, "Online Co-Op": 2876, "Fast-Paced": 2208
    },
    genres: ["Action", "Sports"],
    categories: ["Single-player", "Multi-player", "PvP", "Online PvP"],
    mainStoryMinutes: 280,
    completionistMinutes: null
  });
  assert.equal(rocketLeague.endless, true);
  assert.ok(rocketLeague.witnesses.includes("competitive-loop"));
});

test("a competitive tag without an official multiplayer category is not enough", () => {
  const verdict = endlessVerdict({
    tags: { Strategy: 1000, Competitive: 900 },
    genres: ["Strategy"],
    categories: ["Single-player"],
    mainStoryMinutes: 600,
    completionistMinutes: 1200
  });
  assert.equal(verdict.endless, false);
});

test("a loot loop needs the loot and the genre to agree", () => {
  // Last Epoch: an ARPG treadmill recorded as a 22.8h campaign. This is the case
  // the launch feedback named directly.
  const lastEpoch = endlessVerdict({
    tags: {
      "Action RPG": 412, Loot: 348, "Hack and Slash": 300, RPG: 272, Isometric: 206,
      Multiplayer: 199, Action: 133, "Co-op": 122
    },
    genres: ["RPG", "Action"],
    categories: ["Single-player", "Multi-player", "Co-op"],
    mainStoryMinutes: 1370,
    completionistMinutes: 5056
  });
  assert.equal(lastEpoch.endless, true);
  assert.ok(lastEpoch.witnesses.includes("loot-loop"));

  // Elden Ring drops loot and is an Action RPG, but is neither built around the
  // loop nor tagged for it. It has an ending and must keep one.
  const eldenRing = endlessVerdict({
    tags: {
      "Souls-like": 6994, "Open World": 5078, "Dark Fantasy": 4953, RPG: 4707,
      Difficult: 4595, "Action RPG": 3584, "Third Person": 3403, Multiplayer: 3395
    },
    genres: ["Action", "RPG"],
    categories: ["Single-player", "Multi-player", "PvP", "Co-op"],
    mainStoryMinutes: 3605,
    completionistMinutes: 8170
  });
  assert.equal(eldenRing.endless, false);
  assert.deepEqual(eldenRing.witnesses, []);
});

test("a story rich game is never promoted, whatever else fires", () => {
  const verdict = endlessVerdict({
    tags: { "Action RPG": 1000, Loot: 900, "Hack and Slash": 850, "Story Rich": 800 },
    genres: ["RPG"],
    categories: ["Single-player", "Multi-player"],
    mainStoryMinutes: 1200,
    completionistMinutes: 2000
  });
  assert.equal(verdict.endless, false);
  assert.equal(verdict.vetoedBy, "story-driven");
  assert.ok(verdict.witnesses.includes("loot-loop"));
});

test("loot plus a shooter is a campaign, not a treadmill", () => {
  // Borderlands 2 carries Loot as its single top tag and finishes with credits.
  // It has no Hack and Slash tag at all and Action RPG sits at 0.18, which is
  // what separates it from Diablo. Requiring only loot promoted all four
  // Borderlands games.
  const borderlands = endlessVerdict({
    tags: {
      Loot: 2400, Shooter: 2280, Action: 2256, Multiplayer: 1872, "Co-op": 1848,
      "Looter Shooter": 1776, FPS: 1704, RPG: 1368, "First-Person": 1320,
      Funny: 1248, Comedy: 1200, "Action RPG": 432
    },
    genres: ["Action", "RPG"],
    categories: ["Single-player", "Multi-player", "Co-op"],
    mainStoryMinutes: 1806,
    completionistMinutes: 7794
  });
  assert.equal(borderlands.endless, false);

  // Diablo IV is the same family of tags at the intersection that matters.
  const diablo = endlessVerdict({
    tags: { "Action RPG": 1000, "Hack and Slash": 780, Loot: 720, Singleplayer: 450 },
    genres: ["Action", "RPG"],
    categories: ["Single-player", "Multi-player", "Co-op"],
    mainStoryMinutes: 1800,
    completionistMinutes: 13608
  });
  assert.equal(diablo.endless, true);
  assert.ok(diablo.witnesses.includes("loot-loop"));
});

test("a sandbox the crowd plays alone is a sandbox with an ending", () => {
  // Subnautica: Open World Survival Craft on 100% of its top tag's votes, and a
  // real ending. The existing Story Rich veto does not reach it - it carries no
  // such tag - so a dominant Singleplayer identity is what tells it from Valheim.
  const subnautica = endlessVerdict({
    tags: {
      "Open World Survival Craft": 1000, Survival: 990, Horror: 880, "Open World": 830,
      Underwater: 830, Exploration: 810, Crafting: 690, "Base-Building": 670,
      Singleplayer: 660, Adventure: 560, "First-Person": 550
    },
    genres: ["Action", "Adventure", "Indie"],
    categories: ["Single-player"],
    mainStoryMinutes: 1776,
    completionistMinutes: 3108
  });
  assert.equal(subnautica.endless, false);

  // Valheim carries the same decisive tag and no Singleplayer tag at all.
  const valheim = endlessVerdict({
    tags: {
      "Open World Survival Craft": 2379, Survival: 2100, Crafting: 1900,
      "Base-Building": 1700, Multiplayer: 1600, Exploration: 1500
    },
    genres: ["Action", "Adventure"],
    categories: ["Single-player", "Multi-player", "Co-op"],
    mainStoryMinutes: 4956,
    completionistMinutes: 8868
  });
  assert.equal(valheim.endless, true);
  assert.ok(valheim.witnesses.includes("decisive-tags"));

  // A clicker is solo and endless by definition, and must not be argued out of
  // it - the solo test applies only to the sandbox signals.
  const cookieClicker = endlessVerdict({
    tags: { Clicker: 1000, Incremental: 950, Singleplayer: 900, Casual: 700 },
    genres: ["Casual", "Simulation"],
    categories: ["Single-player"]
  });
  assert.equal(cookieClicker.endless, true);
  assert.ok(cookieClicker.witnesses.includes("decisive-tags"));
});

test("the genres column carries junk, so the persistent path wants the categories to agree", () => {
  // House Flipper is a single-player renovation sim owned by 272 people here, and
  // Steam lists it under the genre "Massively Multiplayer". With its Sandbox tag
  // that read as a live-service world. Its categories say Single-player only.
  const houseFlipper = {
    tags: {
      Simulation: 1000, Sandbox: 980, Building: 960, Casual: 950, Relaxing: 940,
      "Immersive Sim": 930, Education: 920, Singleplayer: 900, Multiplayer: 300,
      "Base-Building": 280, Management: 260, Moddable: 240
    },
    genres: ["Action", "Adventure", "Casual", "Indie", "Massively Multiplayer", "Simulation", "Strategy"],
    categories: ["Single-player", "Remote Play on Tablet"],
    mainStoryMinutes: 795,
    completionistMinutes: 2988
  };
  assert.equal(hasStrongReplayabilitySignals(houseFlipper), false);
  assert.equal(endlessVerdict(houseFlipper).endless, false);

  // The same signals with a real Multi-player category is a real persistent world.
  assert.equal(hasStrongReplayabilitySignals({
    ...houseFlipper,
    categories: ["Single-player", "Multi-player", "Co-op"]
  }), true);
});

test("a person's ruling outranks every rule", () => {
  const verdict = endlessVerdict({
    tags: { MOBA: 1000, Competitive: 950 },
    genres: ["Action"],
    categories: ["Multi-player"],
    manualOverride: true
  });
  assert.equal(verdict.endless, false);
  assert.equal(verdict.vetoedBy, "manual-override");
});

test("the lowered completion ratio catches a co-op grind without touching a long RPG", () => {
  // Deep Rock Galactic: 44.7h story against 480h completionist, a ratio of 10.7.
  // The old threshold of 12 called this a campaign.
  const deepRock = endlessVerdict({
    tags: { Dwarf: 6515, "Co-op": 2547, PvE: 2152, FPS: 2008, "Class-Based": 1802 },
    genres: ["Action"],
    categories: ["Single-player", "Multi-player", "Co-op"],
    mainStoryMinutes: 2683,
    completionistMinutes: 28798
  });
  assert.equal(deepRock.endless, true);
  assert.ok(deepRock.witnesses.includes("duration-shape"));

  // Black Myth: Wukong is 1.8, Elden Ring 2.3. Neither comes near 6.
  assert.equal(hasEndlessDurationShape({ mainStoryMinutes: 2274, completionistMinutes: 4060 }), false);
  assert.equal(hasEndlessDurationShape({ mainStoryMinutes: 3605, completionistMinutes: 8170 }), false);
});

test("our own hours can convict a game the tags and durations miss", () => {
  const base = {
    tags: { Strategy: 1000, RTS: 660 },
    genres: ["Strategy"],
    categories: ["Single-player", "Multi-player"],
    mainStoryMinutes: 300
  };

  assert.equal(endlessVerdict({ ...base, medianOwnerHours: 60, engagedOwners: 40 }).endless, true);
  // Too few players for the median to mean anything.
  assert.equal(endlessVerdict({ ...base, medianOwnerHours: 60, engagedOwners: 4 }).endless, false);
  // Played twice over, which is a replay rather than a treadmill.
  assert.equal(endlessVerdict({ ...base, medianOwnerHours: 10, engagedOwners: 40 }).endless, false);
});

test("the completion ratio needs a long story behind it, or a reason to excuse a short one", () => {
  // SUPERHOT: 2.4h story against 20h completionist, a ratio of 8.3, and it has
  // credits. The ratio alone promoted it, along with Streets of Rage 4 (3.2h,
  // 9.3x) and Baba Is You (7.5h, 6.2x).
  const superhot = endlessVerdict({
    tags: { Action: 1000, FPS: 900, "Time Manipulation": 850, Singleplayer: 800, Difficult: 500 },
    genres: ["Action", "Indie"],
    categories: ["Single-player", "Steam Achievements"],
    mainStoryMinutes: 144,
    completionistMinutes: 1200
  });
  assert.equal(superhot.endless, false);
  assert.deepEqual(superhot.witnesses, []);

  // Deep Rock Galactic is the same ratio band with 44.7h of story behind it.
  assert.equal(endlessVerdict({
    tags: { Dwarf: 6515, "Co-op": 2547, PvE: 2152, FPS: 2008 },
    genres: ["Action"],
    categories: ["Single-player", "Multi-player", "Co-op"],
    mainStoryMinutes: 2683,
    completionistMinutes: 28798
  }).witnesses.includes("duration-shape"), true);
});

test("a short story is excused when a run is the whole game, or when there is no campaign", () => {
  // Brotato: the story figure describes one run, and the run is the game.
  const brotato = endlessVerdict({
    tags: { Roguelite: 1000, "Bullet Heaven": 900, Action: 850, Singleplayer: 700 },
    genres: ["Action", "Indie"],
    categories: ["Single-player"],
    mainStoryMinutes: 342,
    completionistMinutes: 3000
  });
  assert.equal(brotato.endless, true);
  assert.ok(brotato.witnesses.includes("duration-shape"));

  // Half-Life 2: Deathmatch has no campaign at all; the 2.5h is HowLongToBeat
  // describing something that does not exist.
  const deathmatch = endlessVerdict({
    tags: { FPS: 1000, Multiplayer: 950, Action: 900, Shooter: 880 },
    genres: ["Action"],
    categories: ["Multi-player", "Valve Anti-Cheat enabled"],
    mainStoryMinutes: 150,
    completionistMinutes: 1110
  });
  assert.equal(deathmatch.endless, true);
  assert.ok(deathmatch.witnesses.includes("duration-shape"));

  // A finite co-op beat 'em up is not excused by shipping co-op.
  assert.equal(endlessVerdict({
    tags: { "Beat 'em up": 1000, Action: 900, Singleplayer: 600, "Co-op": 550 },
    genres: ["Action"],
    categories: ["Single-player", "Multi-player", "Co-op", "Shared/Split Screen"],
    mainStoryMinutes: 192,
    completionistMinutes: 1794
  }).endless, false);
});
