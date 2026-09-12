import assert from "node:assert/strict";
import test from "node:test";
import { transformIdentityBatch } from "./accounts.ts";
import {
  CapabilityTransformError,
  transformCapabilities,
  type CapabilityTransformInput,
  type LegacyAccountCapabilityRow,
  type LegacyProfileCapabilityRow,
} from "./capabilities.ts";
import {
  accountMapFromIdentityResult,
  type AccountMap,
  type TransformRunIdentity,
} from "./sessions.ts";

const MANUAL = "11111111-1111-4111-8111-111111111111";
const STEAM_A = "22222222-2222-4222-8222-222222222222";
const STEAM_B = "33333333-3333-4333-8333-333333333333";
const DELETED_ID = "44444444-4444-4444-8444-444444444444";
const DELETED_MERGE = "55555555-5555-4555-8555-555555555555";
const PRIVATE_SENTINEL = "source-private-capability-note-7f9e";

const RUN: TransformRunIdentity = Object.freeze({
  runId: "m3-e-capability-run",
  snapshotHash: "cd".repeat(32),
  observedAt: "2026-09-10 12:00:00.000001+00:00",
});

const MAP: AccountMap = Object.freeze({
  run: RUN,
  entries: Object.freeze([
    {
      legacyId: MANUAL,
      accountId: 1,
      accountKind: "manual" as const,
      identityVerified: false,
      lifecycleStatus: "active" as const,
    },
    {
      legacyId: STEAM_A,
      accountId: 2,
      accountKind: "steam" as const,
      identityVerified: true,
      lifecycleStatus: "active" as const,
    },
    {
      legacyId: STEAM_B,
      accountId: 3,
      accountKind: "steam" as const,
      identityVerified: true,
      lifecycleStatus: "active" as const,
    },
  ]),
});

function accountRow(
  legacyId: string,
  accountType: "manual" | "steam",
  values: Partial<Omit<LegacyAccountCapabilityRow, "legacyId" | "accountType">> = {},
): LegacyAccountCapabilityRow {
  return {
    legacyId,
    accountType,
    libraryVisible: null,
    playtimeVisible: null,
    lastPlayedVisible: null,
    checkedAt: null,
    gamesSeen: null,
    ...values,
  };
}

function profileRow(
  legacyId: string,
  values: Partial<Omit<LegacyProfileCapabilityRow, "legacyId">> = {},
): LegacyProfileCapabilityRow {
  return {
    legacyId,
    libraryVisible: null,
    playtimeVisible: null,
    lastPlayedVisible: null,
    checkedAt: null,
    gamesSeen: null,
    ...values,
  };
}

function baseInput(overrides: Partial<CapabilityTransformInput> = {}): CapabilityTransformInput {
  return {
    run: RUN,
    accountMap: MAP,
    accountRows: [
      accountRow(MANUAL, "manual"),
      accountRow(STEAM_A, "steam", {
        libraryVisible: true,
        playtimeVisible: "f",
        lastPlayedVisible: null,
        checkedAt: "2026-09-10 10:00:00.123456+00:00",
        gamesSeen: "0000000007",
      }),
      accountRow(STEAM_B, "steam", {
        libraryVisible: false,
        playtimeVisible: null,
        lastPlayedVisible: false,
        checkedAt: null,
        gamesSeen: null,
      }),
    ],
    profileRows: [
      profileRow(STEAM_A, {
        libraryVisible: false,
        playtimeVisible: true,
        lastPlayedVisible: null,
        checkedAt: "2026-09-09 10:00:00.123456+00:00",
        gamesSeen: 6,
      }),
    ],
    ...overrides,
  };
}

function identityTombstoneMap(): AccountMap {
  const identityResult = transformIdentityBatch({
    runIdentity: { runId: RUN.runId, snapshotHash: RUN.snapshotHash },
    appAccounts: [
      {
        id: STEAM_A,
        account_type: "steam",
        created_at: "2026-01-01 00:00:00.000000+00:00",
        updated_at: "2026-01-02 00:00:00.000000+00:00",
        last_visited_at: null,
      },
    ],
    appUsers: [
      {
        id: STEAM_A,
        steam_id: "76561198000000001",
        display_name: "Steam account",
        avatar_url: null,
        created_at: "2026-01-01 00:00:00.000000+00:00",
        updated_at: "2026-01-02 00:00:00.000000+00:00",
        last_login_at: null,
      },
    ],
    manualSteamProfiles: [],
    accountMerges: [
      {
        id: DELETED_MERGE,
        source_account_id: DELETED_ID,
        target_account_id: STEAM_A,
        verified_steam_id: "76561198000000001",
        merge_mode: "merged_existing",
        created_at: "2026-09-10 11:00:00.000000+00:00",
        analytics_delivered_at: null,
      },
    ],
    mergeTombstones: [
      {
        merge_id: DELETED_MERGE,
        source_account_id: DELETED_ID,
        target_account_id: STEAM_A,
        verified_steam_id: "76561198000000001",
        merge_mode: "merged_existing",
        created_at: "2026-09-10 11:00:00.000000+00:00",
        source_deleted: true,
        provenance: "account_merge_source_deleted",
        created_at_meaning: "merge_observed_at",
      },
    ],
  });
  return accountMapFromIdentityResult(identityResult, RUN.observedAt);
}

function thrownCode(run: () => unknown): string {
  try {
    run();
    assert.fail("expected a stable capability error");
  } catch (error) {
    assert.ok(error instanceof CapabilityTransformError);
    return error.capabilityCode;
  }
}

function canonical(result: ReturnType<typeof transformCapabilities>): string {
  return JSON.stringify({
    run: result.run,
    capabilities: result.capabilities.map((row) => ({ ...row, sourceSnapshotHash: [...row.sourceSnapshotHash] })),
    evidence: result.evidence.map((row) => ({ ...row, sourceSnapshotHash: [...row.sourceSnapshotHash] })),
    counts: result.counts,
  });
}

test("account tuple projects true to visible, false/NULL to unknown, and retains both provenance sides", () => {
  const result = transformCapabilities(baseInput());
  assert.equal(result.capabilities.length, 3);
  const manual = result.capabilities.find((row) => row.accountId === 1)!;
  assert.deepEqual(manual, {
    accountId: 1,
    libraryVisibility: "unknown",
    playtimeVisibility: "unknown",
    lastPlayedVisibility: "unknown",
    checkedAt: null,
    status: "unknown",
    sourceSnapshotHash: manual.sourceSnapshotHash,
  });
  const steamA = result.capabilities.find((row) => row.accountId === 2)!;
  assert.equal(steamA.libraryVisibility, "visible");
  assert.equal(steamA.playtimeVisibility, "unknown");
  assert.equal(steamA.lastPlayedVisibility, "unknown");
  assert.equal(steamA.status, "ok");
  assert.equal(steamA.checkedAt, "2026-09-10 10:00:00.123456+00:00");
  const steamB = result.capabilities.find((row) => row.accountId === 3)!;
  assert.equal(steamB.libraryVisibility, "unknown");
  assert.equal(steamB.playtimeVisibility, "unknown");
  assert.equal(steamB.lastPlayedVisibility, "unknown");
  assert.equal(steamB.status, "unknown");

  assert.equal(result.evidence.length, 4);
  const accountEvidence = result.evidence.find(
    (row) => row.accountId === 2 && row.evidencePrecedence === "account_writer",
  )!;
  assert.deepEqual(
    {
      rawLibraryVisible: accountEvidence.rawLibraryVisible,
      rawPlaytimeVisible: accountEvidence.rawPlaytimeVisible,
      rawLastPlayedVisible: accountEvidence.rawLastPlayedVisible,
      rawCheckedAt: accountEvidence.rawCheckedAt,
      rawGamesCount: accountEvidence.rawGamesCount,
      projectionStatus: accountEvidence.projectionStatus,
      capturedAt: accountEvidence.capturedAt,
      evidence: accountEvidence.evidence,
    },
    {
      rawLibraryVisible: true,
      rawPlaytimeVisible: false,
      rawLastPlayedVisible: null,
      rawCheckedAt: "2026-09-10 10:00:00.123456+00:00",
      rawGamesCount: 7,
      projectionStatus: "visible",
      capturedAt: "2026-09-10T12:00:00.000001Z",
      evidence: {
        sourceRelation: "app_accounts",
        projectionRule: "legacy-boolean-to-capability",
        feedsCompactCapability: true,
      },
    },
  );
  const profileEvidence = result.evidence.find(
    (row) => row.accountId === 2 && row.evidencePrecedence === "profile_reader",
  )!;
  assert.equal(profileEvidence.evidence.sourceRelation, "app_users");
  assert.equal(profileEvidence.evidence.feedsCompactCapability, false);
  assert.equal(profileEvidence.rawPlaytimeVisible, true);
  assert.equal(profileEvidence.rawGamesCount, 6);
  assert.equal(result.counts.visibleAccounts, 1);
  assert.equal(result.counts.unknownAccounts, 2);
});

test("account/profile tuples compare atomically and stable ordering survives permutations", () => {
  const forward = transformCapabilities(baseInput());
  const shuffled = transformCapabilities(
    baseInput({
      accountRows: [...baseInput().accountRows].reverse(),
      profileRows: [...baseInput().profileRows].reverse(),
      accountMap: Object.freeze({ run: RUN, entries: [...MAP.entries].reverse() }),
    }),
  );
  assert.equal(canonical(forward), canonical(shuffled));
  const accountEvidence = forward.evidence.find(
    (row) => row.accountId === 2 && row.evidencePrecedence === "account_writer",
  )!;
  assert.equal(accountEvidence.rawGamesCount, 7);
  assert.equal(accountEvidence.rawCheckedAt, "2026-09-10 10:00:00.123456+00:00");
  assert.equal(forward.evidence[0].evidencePrecedence, "account_writer");
  assert.equal(forward.evidence[1].evidencePrecedence, "account_writer");
});

test("false and NULL never become hidden, private, or error states", () => {
  const result = transformCapabilities(
    baseInput({
      accountRows: [
        accountRow(MANUAL, "manual", { libraryVisible: false, playtimeVisible: null, lastPlayedVisible: false }),
        accountRow(STEAM_A, "steam", { libraryVisible: null, playtimeVisible: false, lastPlayedVisible: null }),
        accountRow(STEAM_B, "steam", { libraryVisible: false, playtimeVisible: false, lastPlayedVisible: null }),
      ],
      profileRows: [],
    }),
  );
  for (const row of result.capabilities) {
    assert.deepEqual(
      [row.libraryVisibility, row.playtimeVisibility, row.lastPlayedVisibility],
      ["unknown", "unknown", "unknown"],
    );
    assert.equal(row.status, "unknown");
    assert.equal((row as Record<string, unknown>).status === "private", false);
    assert.equal((row as Record<string, unknown>).status === "error", false);
  }
  assert.equal(result.evidence.every((row) => row.projectionStatus === "unknown"), true);
});

test("profile-only, newer, and equal-time conflicting cases fail without source details", () => {
  assert.equal(
    thrownCode(
      () =>
        transformCapabilities(
          baseInput({
            accountRows: [accountRow(MANUAL, "manual"), accountRow(STEAM_A, "steam"), accountRow(STEAM_B, "steam")],
            profileRows: [profileRow(STEAM_A, { checkedAt: "2026-09-10 10:00:00+00:00" })],
          }),
        ),
    ),
    "capability_profile_only_dated",
  );

  const newer = (() => {
    try {
      transformCapabilities(
        baseInput({
          profileRows: [
            profileRow(STEAM_A, {
              libraryVisible: true,
              playtimeVisible: false,
              lastPlayedVisible: null,
              checkedAt: "2026-09-10 10:00:00.123457+00:00",
              gamesSeen: "7",
            }),
          ],
        }),
      );
      assert.fail("expected profile-newer guard");
    } catch (error) {
      return error;
    }
  })();
  assert.ok(newer instanceof CapabilityTransformError);
  assert.equal(newer.capabilityCode, "capability_profile_newer");
  assert.equal(JSON.stringify(newer).includes(STEAM_A), false);
  assert.equal(JSON.stringify(newer).includes(PRIVATE_SENTINEL), false);

  assert.equal(
    thrownCode(() =>
      transformCapabilities(
        baseInput({
          accountRows: [
            accountRow(MANUAL, "manual"),
            accountRow(STEAM_A, "steam", {
              libraryVisible: true,
              playtimeVisible: false,
              lastPlayedVisible: null,
              checkedAt: "2026-09-10 10:00:00.123456+00:00",
              gamesSeen: 7,
            }),
            accountRow(STEAM_B, "steam"),
          ],
          profileRows: [
            profileRow(STEAM_A, {
              libraryVisible: false,
              playtimeVisible: false,
              lastPlayedVisible: null,
              checkedAt: "2026-09-10 10:00:00.123456+00:00",
              gamesSeen: 7,
            }),
          ],
        }),
      ),
    ),
    "capability_equal_time_conflict",
  );
});

test("older or undated profile evidence is retained without changing account authority", () => {
  const result = transformCapabilities(
    baseInput({
      profileRows: [
        profileRow(STEAM_A, {
          libraryVisible: false,
          playtimeVisible: true,
          lastPlayedVisible: null,
          checkedAt: "2026-09-09 10:00:00.123455+00:00",
          gamesSeen: 99,
        }),
      ],
    }),
  );
  assert.equal(result.capabilities.find((row) => row.accountId === 2)?.playtimeVisibility, "unknown");
  assert.equal(
    result.evidence.find((row) => row.accountId === 2 && row.evidencePrecedence === "profile_reader")?.rawGamesCount,
    99,
  );

  const undated = transformCapabilities(
    baseInput({
      profileRows: [profileRow(STEAM_A, { libraryVisible: false, playtimeVisible: true, checkedAt: null, gamesSeen: 6 })],
    }),
  );
  assert.equal(undated.capabilities.find((row) => row.accountId === 2)?.libraryVisibility, "visible");
  assert.equal(
    undated.evidence.find((row) => row.accountId === 2 && row.evidencePrecedence === "profile_reader")?.rawPlaytimeVisible,
    true,
  );
});

test("source kind, row shape, identity, and bounds are validated privately", () => {
  assert.equal(
    thrownCode(() =>
      transformCapabilities(
        baseInput({
          accountRows: [
            accountRow(MANUAL, "steam"),
            accountRow(STEAM_A, "steam"),
            accountRow(STEAM_B, "steam"),
          ],
          profileRows: [],
        }),
      ),
    ),
    "capability_account_kind",
  );
  assert.equal(
    thrownCode(() =>
      transformCapabilities(
        baseInput({
          accountRows: [accountRow(MANUAL, "manual"), accountRow(STEAM_A, "steam")],
          profileRows: [],
        }),
      ),
    ),
    "capability_account_missing",
  );
  assert.equal(
    thrownCode(() =>
      transformCapabilities(
        baseInput({
          accountRows: [
            accountRow(MANUAL, "manual", { libraryVisible: PRIVATE_SENTINEL as "t" }),
            accountRow(STEAM_A, "steam"),
            accountRow(STEAM_B, "steam"),
          ],
          profileRows: [],
        }),
      ),
    ),
    "capability_boolean_invalid",
  );
  assert.equal(
    thrownCode(() => transformCapabilities(baseInput({ limits: { maxRows: 1 } }))),
    "capability_input_bound_exceeded",
  );
  const otherRun = { ...RUN, runId: "other-capability-run" };
  assert.equal(
    thrownCode(() =>
      transformCapabilities(
        baseInput({
          accountRows: [accountRow(MANUAL, "manual", { run: otherRun }), accountRow(STEAM_A, "steam"), accountRow(STEAM_B, "steam")],
          profileRows: [],
        }),
      ),
    ),
    "capability_row_run_mismatch",
  );
});

test("identity-proven deleted tombstones are omitted and cannot receive capability rows", () => {
  const map = identityTombstoneMap();
  const active = map.entries.find((entry) => entry.lifecycleStatus === "active")!;
  const deleted = map.entries.find((entry) => entry.lifecycleStatus === "deleted")!;
  assert.ok(deleted.tombstone);

  const result = transformCapabilities({
    run: RUN,
    accountMap: map,
    accountRows: [accountRow(active.legacyId, "steam", { libraryVisible: true })],
    profileRows: [],
  });
  assert.deepEqual(result.counts, {
    accounts: 1,
    accountEvidence: 1,
    profileEvidence: 0,
    visibleAccounts: 1,
    unknownAccounts: 0,
  });
  assert.equal(result.capabilities.some((row) => row.accountId === deleted.accountId), false);
  assert.equal(result.evidence.some((row) => row.accountId === deleted.accountId), false);

  assert.equal(
    thrownCode(() =>
      transformCapabilities({
        run: RUN,
        accountMap: map,
        accountRows: [
          accountRow(active.legacyId, "steam"),
          accountRow(deleted.legacyId, "manual"),
        ],
        profileRows: [],
      }),
    ),
    "capability_deleted_tombstone_row",
  );
  assert.equal(
    thrownCode(() =>
      transformCapabilities({
        run: RUN,
        accountMap: map,
        accountRows: [accountRow(active.legacyId, "steam")],
        profileRows: [profileRow(deleted.legacyId)],
      }),
    ),
    "capability_deleted_tombstone_row",
  );
});

test("capability maps require explicit tombstone proof and validate their boundary", () => {
  const map = identityTombstoneMap();
  const active = map.entries.find((entry) => entry.lifecycleStatus === "active")!;
  const unprovenMap = Object.freeze({
    ...map,
    entries: Object.freeze(
      map.entries.map((entry) =>
        entry.lifecycleStatus === "deleted" ? { ...entry, tombstone: undefined } : entry,
      ),
    ),
  });
  assert.equal(
    thrownCode(() =>
      transformCapabilities({
        run: RUN,
        accountMap: unprovenMap,
        accountRows: [accountRow(active.legacyId, "steam")],
        profileRows: [],
      }),
    ),
    "capability_account_map_invalid",
  );

  const malformedProofMap = Object.freeze({
    ...map,
    entries: Object.freeze(
      map.entries.map((entry) =>
        entry.lifecycleStatus === "deleted"
          ? {
              ...entry,
              tombstone: {
                ...entry.tombstone,
                sourceDeleted: false,
              },
            }
          : entry,
      ),
    ),
  });
  assert.equal(
    thrownCode(() =>
      transformCapabilities({
        run: RUN,
        accountMap: malformedProofMap as unknown as AccountMap,
        accountRows: [accountRow(active.legacyId, "steam")],
        profileRows: [],
      }),
    ),
    "capability_account_map_invalid",
  );

  for (const malformed of [null, undefined, []]) {
    assert.equal(
      thrownCode(() =>
        transformCapabilities(
          baseInput({ accountMap: malformed as unknown as AccountMap }),
        ),
      ),
      "capability_account_map_invalid",
    );
  }
  assert.equal(
    thrownCode(() =>
      transformCapabilities(
        baseInput({
          accountMap: { run: null, entries: [] } as unknown as AccountMap,
        }),
      ),
    ),
    "capability_account_map_invalid",
  );
});
