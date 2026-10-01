import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalIdentityResult,
  IdentityTransformError,
  transformIdentityBatch,
  type AccountMergeSourceRow,
  type AppAccountSourceRow,
  type AppUserSourceRow,
  type IdentityTransformInput,
  type ManualSteamProfileSourceRow,
  type MergeSourceTombstoneEvidence,
} from "./accounts.ts";

const RUN = Object.freeze({ runId: "identity-test-run", snapshotHash: "a".repeat(64) });
const STEAM_ACCOUNT = "10000000-0000-4000-8000-000000000001";
const MANUAL_WITHOUT_PROFILE = "10000000-0000-4000-8000-000000000002";
const MANUAL_WITH_PROFILE = "10000000-0000-4000-8000-000000000003";
const DELETED_SOURCE = "10000000-0000-4000-8000-000000000010";
const PROMOTED_MERGE = "10000000-0000-4000-8000-000000000100";
const DELETED_MERGE = "10000000-0000-4000-8000-000000000101";
const STEAM_ID = "76561198000000001";

function account(
  id: string,
  accountType: "manual" | "steam",
  createdAt: string,
  lastVisitedAt: string | null = null,
): AppAccountSourceRow {
  return {
    id,
    account_type: accountType,
    created_at: createdAt,
    updated_at: "2026-09-10 00:00:10.000000+00",
    last_visited_at: lastVisitedAt,
  };
}

function user(id: string, steamId = STEAM_ID, displayName: string | null = "Verified user"): AppUserSourceRow {
  return {
    id,
    steam_id: steamId,
    display_name: displayName,
    avatar_url: "https://cdn.example/avatar.png",
    created_at: "2026-09-09 23:00:00.000000+00",
    updated_at: "2026-09-10 00:00:03.000000+00",
    last_login_at: "2026-09-10 00:00:00.000001+00",
  };
}

function manualProfile(id: string, steamId = STEAM_ID): ManualSteamProfileSourceRow {
  return {
    id,
    steam_id: steamId,
    steam_profile_url: `https://steamcommunity.com/profiles/${steamId}`,
    display_name: "Manual workspace",
    steam_display_name: "Steam display",
    avatar_url: null,
    created_at: "2026-09-09 22:00:00.000000+00",
    updated_at: "2026-09-10 00:00:02.000000+00",
  };
}

function promotedMerge(): AccountMergeSourceRow {
  return {
    id: PROMOTED_MERGE,
    source_account_id: STEAM_ACCOUNT,
    target_account_id: STEAM_ACCOUNT,
    verified_steam_id: STEAM_ID,
    merge_mode: "promoted",
    created_at: "2026-09-10 00:00:20.000000+00",
    analytics_delivered_at: null,
  };
}

function deletedMerge(): AccountMergeSourceRow {
  return {
    id: DELETED_MERGE,
    source_account_id: DELETED_SOURCE,
    target_account_id: STEAM_ACCOUNT,
    verified_steam_id: STEAM_ID,
    merge_mode: "merged_existing",
    created_at: "2026-09-10 00:00:30.000000+00",
    analytics_delivered_at: "2026-09-10 00:01:00.000000+00",
  };
}

function tombstoneEvidence(): MergeSourceTombstoneEvidence {
  return {
    merge_id: DELETED_MERGE,
    source_account_id: DELETED_SOURCE,
    target_account_id: STEAM_ACCOUNT,
    verified_steam_id: STEAM_ID,
    merge_mode: "merged_existing",
    created_at: "2026-09-10 00:00:30.000000+00",
    source_deleted: true,
    provenance: "account_merge_source_deleted",
    created_at_meaning: "merge_observed_at",
  };
}

function fixture(): IdentityTransformInput {
  return {
    runIdentity: RUN,
    appAccounts: [
      account(STEAM_ACCOUNT, "steam", "2026-09-10 00:00:00.000001+00", "2026-09-10 00:00:00.000010+00"),
      account(MANUAL_WITHOUT_PROFILE, "manual", "2026-09-10 00:00:00.000000+00"),
      account(MANUAL_WITH_PROFILE, "manual", "2026-09-10 00:00:00.000002+00"),
    ],
    appUsers: [user(STEAM_ACCOUNT)],
    manualSteamProfiles: [manualProfile(MANUAL_WITH_PROFILE)],
    accountMerges: [promotedMerge()],
  };
}

function throwsIdentity(action: () => unknown, code: string, sentinel?: string): void {
  assert.throws(
    action,
    (error: unknown) => {
      assert.ok(error instanceof IdentityTransformError);
      assert.equal(error.code, code);
      if (sentinel) {
        assert.doesNotMatch(error.message, new RegExp(sentinel));
        assert.doesNotMatch(JSON.stringify(error), new RegExp(sentinel));
      }
      return true;
    },
  );
}

function withInput(input: IdentityTransformInput, patch: Partial<IdentityTransformInput>): IdentityTransformInput {
  return { ...input, ...patch };
}

test("account identity transform keeps manual roots and separates visit from login", () => {
  const result = transformIdentityBatch(fixture());
  assert.deepEqual(result.run_identity, { run_id: RUN.runId, snapshot_hash: RUN.snapshotHash });
  assert.equal(result.accounts.length, 3);
  assert.deepEqual(result.accounts.map((row) => [row.id, row.public_id]), [
    [1, MANUAL_WITHOUT_PROFILE],
    [2, STEAM_ACCOUNT],
    [3, MANUAL_WITH_PROFILE],
  ]);
  assert.equal(result.accounts[0].lifecycle_status, "active");
  assert.equal(result.accounts[0].last_login_at, null);
  assert.equal(result.accounts[1].last_seen_at?.sourceText, "2026-09-10 00:00:00.000010+00");
  assert.equal(result.accounts[1].last_login_at?.sourceText, "2026-09-10 00:00:00.000001+00");
  assert.notEqual(result.accounts[1].last_seen_at?.epochMicros, result.accounts[1].last_login_at?.epochMicros);
  assert.equal(result.accounts[0].library_revision, "0");
  assert.equal(result.accounts[0].state_revision, "0");
  assert.equal(result.steam_profiles.length, 2);
  const verified = result.steam_profiles.find((profile) => profile.source_kind === "app_users");
  const manual = result.steam_profiles.find((profile) => profile.source_kind === "manual_profile");
  assert.equal(verified?.verified, true);
  assert.equal(manual?.verified, false);
  assert.equal(verified?.steam_id, STEAM_ID);
  assert.equal(manual?.steam_id, STEAM_ID);
  assert.equal(result.account_map.length, 3);
  assert.equal(new Set(result.account_map.map((row) => row.legacy_id)).size, 3);
  assert.equal(new Set(result.account_map.map((row) => row.account_id)).size, 3);
  assert.deepEqual(new Set(result.account_map.map((row) => row.source_kind)), new Set(["app_accounts"]));
  assert.equal(result.merge_evidence[0].source_tombstone_present, false);
  assert.equal(JSON.stringify(result).includes("9007199254740993"), false);
});

test("shuffled source rows produce identical canonical identity output", () => {
  const input = fixture();
  const shuffled: IdentityTransformInput = {
    ...input,
    appAccounts: [...input.appAccounts].reverse(),
    appUsers: [...input.appUsers].reverse(),
    manualSteamProfiles: [...input.manualSteamProfiles].reverse(),
    accountMerges: [...(input.accountMerges ?? [])].reverse(),
  };
  assert.equal(canonicalIdentityResult(transformIdentityBatch(input)), canonicalIdentityResult(transformIdentityBatch(shuffled)));
});

test("source UUIDs survive both map directions and output is JSON-safe", () => {
  const result = transformIdentityBatch(fixture());
  for (const mapping of result.account_map) {
    const account = result.accounts.find((row) => row.id === mapping.account_id);
    assert.equal(account?.public_id, mapping.legacy_id);
  }
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.equal(JSON.parse(JSON.stringify(result)).accounts[1].public_id, STEAM_ACCOUNT);
});

test("missing manual profiles remain valid without a fabricated profile", () => {
  const result = transformIdentityBatch(fixture());
  const manualWithoutProfile = result.accounts.find((row) => row.public_id === MANUAL_WITHOUT_PROFILE)!;
  assert.equal(result.steam_profiles.some((row) => row.account_id === manualWithoutProfile.id), false);
});

test("promoted merge identity is validated against the verified source profile", () => {
  const result = transformIdentityBatch(fixture());
  assert.equal(result.merge_evidence[0].merge_mode, "promoted");
  assert.equal(result.merge_evidence[0].verified_steam_id_source, STEAM_ID);
  throwsIdentity(
    () => transformIdentityBatch(withInput(fixture(), { accountMerges: [{ ...promotedMerge(), verified_steam_id: "76561198000000002" }] })),
    "identity_merge_steam_conflict",
  );
});

test("deleted merge sources need explicit evidence and become deleted unverified tombstones", () => {
  const input = withInput(fixture(), { accountMerges: [deletedMerge()], mergeTombstones: [tombstoneEvidence()] });
  const result = transformIdentityBatch(input);
  const tombstone = result.accounts.find((row) => row.public_id === DELETED_SOURCE)!;
  assert.equal(tombstone.lifecycle_status, "deleted");
  assert.equal(tombstone.account_kind, "manual");
  assert.equal(tombstone.tombstone?.source_deleted, true);
  assert.equal(tombstone.tombstone?.verified, false);
  assert.equal(tombstone.tombstone?.created_at_meaning, "merge_observed_at");
  assert.equal(result.steam_profiles.some((row) => row.account_id === tombstone.id), false);
  const mapping = result.account_map.find((row) => row.legacy_id === DELETED_SOURCE)!;
  assert.equal(mapping.account_id, tombstone.id);
  assert.equal(mapping.source_kind, "unknown");
  assert.equal(result.merge_evidence[0].source_tombstone_present, true);
  assert.equal(result.merge_evidence[0].source_tombstone_account_id, tombstone.id);
  throwsIdentity(() => transformIdentityBatch(withInput(fixture(), { accountMerges: [deletedMerge()] })), "identity_tombstone_required");
});

test("a separately evidenced source creation instant is kept distinct from merge observation", () => {
  const evidence = {
    ...tombstoneEvidence(),
    created_at_meaning: "source_account_created_at" as const,
    created_at: "2026-09-10 00:00:30.000000+00",
    source_created_at: "2026-09-01 00:00:00.000001+00",
  };
  const result = transformIdentityBatch(withInput(fixture(), { accountMerges: [deletedMerge()], mergeTombstones: [evidence] }));
  const tombstone = result.accounts.find((row) => row.public_id === DELETED_SOURCE)!;
  assert.equal(tombstone.created_at.sourceText, "2026-09-01 00:00:00.000001+00");
  assert.equal(tombstone.tombstone?.created_at_meaning, "source_account_created_at");
});

test("tombstone evidence is matched, explicit and never accepted for a live source", () => {
  const input = withInput(fixture(), { accountMerges: [deletedMerge()], mergeTombstones: [tombstoneEvidence()] });
  throwsIdentity(
    () => transformIdentityBatch(withInput(input, { mergeTombstones: [{ ...tombstoneEvidence(), source_deleted: false }] })),
    "identity_tombstone_invalid",
  );
  throwsIdentity(
    () => transformIdentityBatch(withInput(input, { mergeTombstones: [{ ...tombstoneEvidence(), target_account_id: MANUAL_WITH_PROFILE }] })),
    "identity_tombstone_unproven",
  );
  throwsIdentity(
    () => transformIdentityBatch(withInput(fixture(), { mergeTombstones: [tombstoneEvidence()] })),
    "identity_tombstone_unproven",
  );
});

test("duplicate roots, unmatched profiles and duplicate profile kinds fail closed", () => {
  const input = fixture();
  throwsIdentity(() => transformIdentityBatch(withInput(input, { appAccounts: [...input.appAccounts, input.appAccounts[0]] })), "identity_duplicate_root");
  throwsIdentity(
    () => transformIdentityBatch(withInput(input, { appUsers: [...input.appUsers, user("10000000-0000-4000-8000-000000000099", "76561198000000002")] })),
    "identity_unmatched_profile",
  );
  throwsIdentity(
    () => transformIdentityBatch(withInput(input, { manualSteamProfiles: [...input.manualSteamProfiles, manualProfile(STEAM_ACCOUNT)] })),
    "identity_duplicate_profile",
  );
  throwsIdentity(
    () => transformIdentityBatch(withInput(input, { appUsers: [...input.appUsers, user(MANUAL_WITH_PROFILE, "76561198000000002")] })),
    "identity_duplicate_profile",
  );
  throwsIdentity(
    () => transformIdentityBatch(withInput(input, { appUsers: [...input.appUsers, user(MANUAL_WITHOUT_PROFILE, "76561198000000002")] })),
    "identity_impossible_account_kind",
  );
});

test("invalid kinds, missing verified profiles, IDs, timestamps and metadata are blockers", () => {
  const input = fixture();
  throwsIdentity(() => transformIdentityBatch(withInput(input, { appAccounts: [account(STEAM_ACCOUNT, "manual", "2026-09-10 00:00:00.000001+00")] })), "identity_impossible_account_kind");
  throwsIdentity(() => transformIdentityBatch(withInput(input, { appUsers: [] })), "identity_steam_profile_missing");
  throwsIdentity(() => transformIdentityBatch(withInput(input, { appAccounts: [{ ...input.appAccounts[0], id: "not-a-uuid" }] })), "identity_invalid_uuid");
  throwsIdentity(() => transformIdentityBatch(withInput(input, { appAccounts: [{ ...input.appAccounts[0], created_at: "not-a-time" }] })), "identity_invalid_timestamp");
  throwsIdentity(() => transformIdentityBatch(withInput(input, { appUsers: [{ ...input.appUsers[0], display_name: "x".repeat(81) }] })), "identity_target_metadata_invalid");
  throwsIdentity(() => transformIdentityBatch(withInput(input, { appUsers: [{ ...input.appUsers[0], display_name: "   " }] })), "identity_target_metadata_invalid");
  throwsIdentity(() => transformIdentityBatch(withInput(input, { appUsers: [{ ...input.appUsers[0], steam_id: "7656119800000000x" }] }),), "identity_invalid_steam_id");
});

test("verified collisions are rejected while manual shared IDs remain legal", () => {
  const input = fixture();
  const secondSteam = "10000000-0000-4000-8000-000000000004";
  const expanded: IdentityTransformInput = {
    ...input,
    appAccounts: [...input.appAccounts, account(secondSteam, "steam", "2026-09-10 00:00:00.000003+00")],
    appUsers: [...input.appUsers, user(secondSteam)],
  };
  throwsIdentity(() => transformIdentityBatch(expanded), "identity_verified_steam_collision");
  const result = transformIdentityBatch(input);
  assert.equal(result.steam_profiles.filter((row) => row.steam_id === STEAM_ID).length, 2);
  assert.equal(result.steam_profiles.filter((row) => row.steam_id === STEAM_ID && row.verified).length, 1);
});

test("nullable login is preserved when a source adapter supplies it", () => {
  const input = fixture();
  const result = transformIdentityBatch(withInput(input, { appUsers: [{ ...input.appUsers[0], last_login_at: null }] }));
  const accountRow = result.accounts.find((row) => row.public_id === STEAM_ACCOUNT)!;
  assert.equal(accountRow.last_login_at, null);
  assert.notEqual(accountRow.last_seen_at, null);
});

test("mixed run identity and account bound fail before target numbering", () => {
  const input = fixture();
  throwsIdentity(
    () => transformIdentityBatch(withInput(input, { appUsers: [{ ...input.appUsers[0], runId: "other-run" }] })),
    "identity_mixed_run_identity",
  );
  throwsIdentity(() => transformIdentityBatch(input, { maxAccounts: 2 }), "identity_account_count_limit");
  throwsIdentity(() => transformIdentityBatch(input, { maxAccounts: 0 }), "identity_account_count_limit");
});

test("required run identity fields reject absent and non-string values consistently", () => {
  // Keep the source union empty so each malformed run value reaches the
  // identity gate before any row validation can mask the regression.
  const input: IdentityTransformInput = {
    runIdentity: RUN,
    appAccounts: [],
    appUsers: [],
    manualSteamProfiles: [],
  };
  const malformedRunIdentities: unknown[] = [
    null,
    [],
    { snapshotHash: RUN.snapshotHash },
    { runId: null, snapshotHash: RUN.snapshotHash },
    { runId: 123, snapshotHash: RUN.snapshotHash },
    { runId: { value: RUN.runId }, snapshotHash: RUN.snapshotHash },
    { runId: RUN.runId },
    { runId: RUN.runId, snapshotHash: null },
    { runId: RUN.runId, snapshotHash: 123 },
    { runId: RUN.runId, snapshotHash: { value: RUN.snapshotHash } },
  ];
  const serializedErrors: string[] = [];
  for (const runIdentity of malformedRunIdentities) {
    assert.throws(
      () => transformIdentityBatch({ ...input, runIdentity } as unknown as IdentityTransformInput),
      (error: unknown) => {
        assert.ok(error instanceof IdentityTransformError);
        assert.equal(error.code, "identity_run_invalid");
        serializedErrors.push(JSON.stringify(error));
        return true;
      },
    );
  }
  assert.equal(new Set(serializedErrors).size, 1);
  assert.doesNotMatch(serializedErrors[0], /identity-test-run|snapshotHash|123|value/);
});
