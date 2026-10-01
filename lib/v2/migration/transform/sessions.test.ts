import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { transformIdentityBatch } from "./accounts.ts";
import {
  accountMapFromIdentityResult,
  LEGACY_MANUAL_COOKIE_PREFIX,
  LEGACY_MANUAL_SESSION_DAYS,
  LEGACY_PROFILE_SECURITY_INTENT_MINUTES,
  LEGACY_SESSION_COOKIE_NAME,
  LEGACY_VERIFIED_SESSION_DAYS,
  legacySessionKindFromCookie,
  transformSessions,
  type AccountMap,
  type LegacyManualSession,
  type LegacyVerifiedSession,
  type SessionTransformInput,
  type TransformRunIdentity,
  SessionTransformError,
} from "./sessions.ts";

const STEAM_ID = "11111111-1111-4111-8111-111111111111";
const MANUAL_ID = "22222222-2222-4222-8222-222222222222";
const DELETED_STEAM_ID = "44444444-4444-4444-8444-444444444444";
const VERIFIED_SESSION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VERIFIED_SESSION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MANUAL_SESSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DELETED_SOURCE_MERGE = "55555555-5555-4555-8555-555555555555";
const SNAPSHOT_HASH = "ab".repeat(32);

const RUN: TransformRunIdentity = Object.freeze({
  runId: "m3-e-test-run",
  snapshotHash: SNAPSHOT_HASH,
  observedAt: "2026-09-10 12:00:00.000001+00:00",
});

function accountMap(overrides: Partial<AccountMap["entries"][number]> = {}): AccountMap {
  return Object.freeze({
    run: RUN,
    entries: Object.freeze([
      {
        legacyId: STEAM_ID,
        accountId: 2,
        accountKind: "steam" as const,
        identityVerified: true,
        lifecycleStatus: "active" as const,
        ...overrides,
      },
      {
        legacyId: MANUAL_ID,
        accountId: 1,
        accountKind: "manual" as const,
        identityVerified: false,
        lifecycleStatus: "active" as const,
      },
    ]),
  });
}

const verifiedA: LegacyVerifiedSession = {
  id: VERIFIED_SESSION_A,
  userId: STEAM_ID,
  tokenHash: "aa".repeat(32),
  createdAt: "2026-09-10 10:00:00.123456+00:00",
  lastSeenAt: "2026-09-10 10:00:00.123457+00:00",
  expiresAt: "2026-09-11 10:00:00.123456+00:00",
};

const verifiedB: LegacyVerifiedSession = {
  id: VERIFIED_SESSION_B,
  userId: STEAM_ID,
  tokenHash: "bb".repeat(32),
  createdAt: "2026-09-10 11:00:00.000000+00:00",
  lastSeenAt: null,
  expiresAt: "2026-09-11 11:00:00.000000+00:00",
  revokedAt: "2026-09-10 11:00:00.000001+00:00",
};

const manual: LegacyManualSession = {
  id: MANUAL_SESSION,
  profileId: MANUAL_ID,
  tokenHash: "cc".repeat(32),
  createdAt: "2026-09-01 00:00:00.000000+00:00",
  lastSeenAt: "2026-09-09 00:00:00.000000+00:00",
  expiresAt: "2026-09-10 12:00:00.000001+00:00",
};

function baseInput(overrides: Partial<SessionTransformInput> = {}): SessionTransformInput {
  return {
    run: RUN,
    accountMap: accountMap(),
    verified: [verifiedA, verifiedB],
    manual: [manual],
    manualDisposition: "migrate-cookie",
    ...overrides,
  };
}

function identityTombstoneResult() {
  return transformIdentityBatch({
    runIdentity: { runId: RUN.runId, snapshotHash: RUN.snapshotHash },
    appAccounts: [
      {
        id: STEAM_ID,
        account_type: "steam",
        created_at: "2026-01-01 00:00:00.000000+00:00",
        updated_at: "2026-01-02 00:00:00.000000+00:00",
        last_visited_at: null,
      },
    ],
    appUsers: [
      {
        id: STEAM_ID,
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
        id: DELETED_SOURCE_MERGE,
        source_account_id: DELETED_STEAM_ID,
        target_account_id: STEAM_ID,
        verified_steam_id: "76561198000000001",
        merge_mode: "merged_existing",
        created_at: "2026-09-10 11:00:00.000000+00:00",
        analytics_delivered_at: null,
      },
    ],
    mergeTombstones: [
      {
        merge_id: DELETED_SOURCE_MERGE,
        source_account_id: DELETED_STEAM_ID,
        target_account_id: STEAM_ID,
        verified_steam_id: "76561198000000001",
        merge_mode: "merged_existing",
        created_at: "2026-09-10 11:00:00.000000+00:00",
        source_deleted: true,
        provenance: "account_merge_source_deleted",
        created_at_meaning: "merge_observed_at",
      },
    ],
  });
}

function thrownCode(run: () => unknown): string {
  try {
    run();
    assert.fail("expected a stable transform error");
  } catch (error) {
    assert.ok(error instanceof SessionTransformError);
    return error.sessionCode;
  }
}

function canonical(result: ReturnType<typeof transformSessions>): string {
  return JSON.stringify({
    run: result.run,
    sessions: result.sessions.map((row) => ({
      targetId: row.targetId.toString(),
      accountId: row.accountId,
      kind: row.sessionKind,
      digest: [...row.tokenDigest],
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      sourceId: row.sourceId,
      sourceOwnerId: row.sourceOwnerId,
      sourceTable: row.sourceTable,
    })),
    maps: result.maps.map((row) => ({
      legacyId: row.legacyId,
      accountId: row.accountId,
      targetId: row.targetId.toString(),
      sourceKind: row.sourceKind,
      disposition: row.disposition,
    })),
    counts: result.counts,
  });
}

test("verified and manual sessions retain exact digest/times with their source kinds", () => {
  const result = transformSessions(baseInput());
  assert.deepEqual(result.run, {
    runId: RUN.runId,
    snapshotHash: SNAPSHOT_HASH,
    observedAt: "2026-09-10T12:00:00.000001Z",
  });
  assert.equal(result.sessions.length, 3);
  assert.equal(result.counts.verifiedMigrated, 2);
  assert.equal(result.counts.manualMigrated, 1);

  const first = result.sessions.find((row) => row.sourceId === VERIFIED_SESSION_A)!;
  assert.equal(first.targetId, BigInt(1));
  assert.equal(first.sessionKind, "verified_steam");
  assert.deepEqual(first.tokenDigest, new Uint8Array(32).fill(0xaa));
  assert.equal(first.createdAt, verifiedA.createdAt);
  assert.equal(first.lastSeenAt, verifiedA.lastSeenAt);
  assert.equal(first.revokedAt, null);
  assert.deepEqual(first.sourceSnapshotHash, new Uint8Array(32).fill(0xab));

  const second = result.sessions.find((row) => row.sourceId === VERIFIED_SESSION_B)!;
  assert.equal(second.targetId, BigInt(2));
  assert.equal(second.revokedAt, verifiedB.revokedAt);
  assert.equal(second.lastSeenAt, null);

  const manualRecord = result.sessions.find((row) => row.sourceId === MANUAL_SESSION)!;
  assert.equal(manualRecord.targetId, BigInt(3));
  assert.equal(manualRecord.sessionKind, "manual");
  assert.equal(manualRecord.sourceTable, "manual_profile_sessions");
  assert.equal(manualRecord.sourceOwnerId, MANUAL_ID);
  assert.deepEqual(manualRecord.tokenDigest, new Uint8Array(32).fill(0xcc));
  assert.equal(manualRecord.createdAt, manual.createdAt);
  assert.equal(manualRecord.lastSeenAt, manual.lastSeenAt);
  assert.equal(manualRecord.expiresAt, manual.expiresAt);
  assert.equal(result.maps.find((row) => row.sourceKind === "manual")?.targetId, BigInt(3));
});

test("manual profile cookies retain their full-cookie HMAC and kind across migration", () => {
  // Independent compatibility evidence from lib/auth.ts. The prefix is part
  // of the cookie value fed to HMAC; it is not stripped before hashing.
  const secret = "synthetic-session-secret-for-tests";
  const manualCookie = `${LEGACY_MANUAL_COOKIE_PREFIX}synthetic-browser-token`;
  const expectedDigest = createHmac("sha256", secret).update(manualCookie).digest("hex");
  const row: LegacyManualSession = { ...manual, tokenHash: expectedDigest };
  const result = transformSessions(baseInput({ manual: [row], manualDisposition: "migrate-cookie" }));
  const migrated = result.sessions.find((session) => session.sourceId === MANUAL_SESSION)!;

  assert.equal(LEGACY_SESSION_COOKIE_NAME, "vault_session");
  assert.equal(legacySessionKindFromCookie(manualCookie), "manual");
  assert.equal(legacySessionKindFromCookie("steam-cookie-token"), "verified_steam");
  assert.equal(LEGACY_MANUAL_SESSION_DAYS, 365);
  assert.equal(LEGACY_VERIFIED_SESSION_DAYS, 30);
  assert.equal(LEGACY_PROFILE_SECURITY_INTENT_MINUTES, 10);
  assert.equal(migrated.sessionKind, "manual");
  assert.equal(migrated.sourceTable, "manual_profile_sessions");
  assert.equal(migrated.sourceOwnerId, MANUAL_ID);
  assert.deepEqual(migrated.tokenDigest, Uint8Array.from(Buffer.from(expectedDigest, "hex")));
  assert.equal(result.maps.find((mapping) => mapping.legacyId === MANUAL_SESSION)?.targetId, migrated.targetId);
  assert.equal(result.counts.manualMigrated, 1);

  const verifiedCookie = "steam-cookie-token";
  const verifiedDigest = createHmac("sha256", secret).update(verifiedCookie).digest("hex");
  const verifiedResult = transformSessions(
    baseInput({
      verified: [{ ...verifiedA, tokenHash: verifiedDigest }],
      manual: [],
    }),
  );
  assert.deepEqual(
    verifiedResult.sessions[0].tokenDigest,
    Uint8Array.from(Buffer.from(verifiedDigest, "hex")),
  );
  assert.equal(verifiedResult.sessions[0].sessionKind, "verified_steam");
});

test("the retired expiry disposition is rejected and security intents stay outside session migration", () => {
  // `manual_profile_security_intents` is a separate short-lived OpenID flow
  // record. It is not a source session and cannot retire a returning cookie.
  assert.equal(
    thrownCode(() =>
      transformSessions(
        baseInput({ manualDisposition: "expire-at-cutover" as "migrate-cookie" }),
      ),
    ),
    "session_manual_disposition_required",
  );
});

test("target numbering is stable under permutations of the explicit source union", () => {
  const forward = transformSessions(baseInput());
  const shuffled = transformSessions(
    baseInput({
      verified: [verifiedB, verifiedA],
      manual: [manual],
    }),
  );
  assert.equal(canonical(forward), canonical(shuffled));
  assert.equal(forward.maps[0].sourceKind, "verified_steam");
  assert.equal(forward.maps[0].targetId, BigInt(1));
  assert.equal(forward.maps[2].sourceKind, "manual");
  assert.equal(forward.maps[2].targetId, BigInt(3));
});

test("decoded digest collisions include case variants and never expose either private value", () => {
  const privateSentinel = "private-session-digest-sentinel";
  const error = (() => {
    try {
      transformSessions(
        baseInput({
          verified: [{ ...verifiedA, tokenHash: privateSentinel }],
          manual: [{ ...manual, tokenHash: "AA".repeat(32) }],
        }),
      );
      assert.fail("expected malformed digest");
    } catch (caught) {
      return caught;
    }
  })();
  assert.ok(error instanceof SessionTransformError);
  assert.equal(error.sessionCode, "session_digest_invalid");
  assert.equal(JSON.stringify(error).includes(privateSentinel), false);

  const collision = (() => {
    try {
      transformSessions(
        baseInput({
          verified: [verifiedA],
          manual: [{ ...manual, tokenHash: "AA".repeat(32) }],
        }),
      );
      assert.fail("expected decoded digest collision");
    } catch (caught) {
      return caught;
    }
  })();
  assert.ok(collision instanceof SessionTransformError);
  assert.equal(collision.sessionCode, "session_digest_collision");
  assert.equal(JSON.stringify(collision).includes("AA".repeat(32)), false);
});

test("source UUID collisions, missing owners and kind/verification/lifecycle confusion fail closed", () => {
  assert.equal(
    thrownCode(
      () =>
        transformSessions(
          baseInput({
            verified: [verifiedA],
            manual: [{ ...manual, id: VERIFIED_SESSION_A.toUpperCase() }],
          }),
        ),
    ),
    "session_source_id_collision",
  );
  assert.equal(
    thrownCode(() => transformSessions(baseInput({ verified: [{ ...verifiedA, userId: DELETED_STEAM_ID }] }))),
    "session_owner_missing",
  );
  assert.equal(
    thrownCode(() => transformSessions(baseInput({ verified: [{ ...verifiedA, userId: MANUAL_ID }] }))),
    "session_owner_kind",
  );
  assert.equal(
    thrownCode(() => transformSessions(baseInput({ manual: [{ ...manual, profileId: STEAM_ID }] }))),
    "session_owner_kind",
  );
  assert.equal(
    thrownCode(() =>
      transformSessions(
        baseInput({
          accountMap: Object.freeze({
            run: RUN,
            entries: Object.freeze([
              {
                legacyId: STEAM_ID,
                accountId: 2,
                accountKind: "steam" as const,
                identityVerified: true,
                lifecycleStatus: "active" as const,
              },
              {
                legacyId: MANUAL_ID,
                accountId: 1,
                accountKind: "manual" as const,
                identityVerified: true,
                lifecycleStatus: "active" as const,
              },
            ]),
          }),
          verified: [],
          manual: [manual],
        }),
      ),
    ),
    "session_owner_verification",
  );
  assert.equal(
    thrownCode(() =>
      transformSessions(
        baseInput({
          accountMap: accountMap({ identityVerified: false }),
          verified: [verifiedA],
          manual: [],
        }),
      ),
    ),
    "session_owner_verification",
  );
  assert.equal(
    thrownCode(() =>
      transformSessions(
        baseInput({
          accountMap: Object.freeze({
            run: RUN,
            entries: Object.freeze([
              {
                legacyId: STEAM_ID,
                accountId: 2,
                accountKind: "steam" as const,
                identityVerified: true,
                lifecycleStatus: "deleted" as const,
              },
              {
                legacyId: MANUAL_ID,
                accountId: 1,
                accountKind: "manual" as const,
                identityVerified: false,
                lifecycleStatus: "active" as const,
              },
            ]),
          }),
          verified: [verifiedA],
          manual: [],
        }),
      ),
    ),
    "session_owner_lifecycle",
  );
  assert.equal(
    thrownCode(() =>
      transformSessions(
        baseInput({
          accountMap: Object.freeze({
            run: RUN,
            entries: Object.freeze([
              {
                legacyId: STEAM_ID,
                accountId: 2,
                accountKind: "steam" as const,
                identityVerified: true,
                lifecycleStatus: "active" as const,
              },
              {
                legacyId: MANUAL_ID,
                accountId: 1,
                accountKind: "manual" as const,
                identityVerified: false,
                lifecycleStatus: "deleted" as const,
              },
            ]),
          }),
          verified: [],
          manual: [manual],
        }),
      ),
    ),
    "session_owner_lifecycle",
  );
});

test("expiry/revocation constraints reject repairable-looking source values", () => {
  assert.equal(
    thrownCode(() =>
      transformSessions(
        baseInput({
          verified: [{ ...verifiedA, expiresAt: verifiedA.createdAt }],
          manual: [],
        }),
      ),
    ),
    "session_expiry_order",
  );
  assert.equal(
    thrownCode(() =>
      transformSessions(
        baseInput({
          verified: [{ ...verifiedA, revokedAt: "2026-09-10 09:59:59.999999+00:00" }],
          manual: [],
        }),
      ),
    ),
    "session_revocation_order",
  );
  assert.equal(
    thrownCode(() => transformSessions(baseInput({ manualDisposition: "" as "migrate-cookie" }))),
    "session_manual_disposition_required",
  );
  assert.equal(
    thrownCode(() => transformSessions(baseInput({ manual: [{ ...manual, lastSeenAt: null }] }))),
    "session_manual_last_seen_missing",
  );
});

test("same-run checks and bounded input reject mixed or oversized batches", () => {
  const differentRun: TransformRunIdentity = {
    ...RUN,
    runId: "different-run",
  };
  assert.equal(
    thrownCode(() =>
      transformSessions(
        baseInput({
          accountMap: Object.freeze({ run: differentRun, entries: accountMap().entries }),
        }),
      ),
    ),
    "session_run_mismatch",
  );
  assert.equal(
    thrownCode(() => transformSessions(baseInput({ limits: { maxSessions: 1 } }))),
    "session_input_bound_exceeded",
  );
});

test("malformed account-map containers fail with a stable map error", () => {
  for (const malformed of [null, undefined, []]) {
    assert.equal(
      thrownCode(() =>
        transformSessions(
          baseInput({ accountMap: malformed as unknown as AccountMap }),
        ),
      ),
      "session_account_map_invalid",
    );
  }
});

test("identity result adapter preserves account kind, verified profile provenance and lifecycle", () => {
  const result = accountMapFromIdentityResult(
    {
      run_identity: { run_id: RUN.runId, snapshot_hash: RUN.snapshotHash },
      accounts: [
        { id: 1, public_id: MANUAL_ID, account_kind: "manual", lifecycle_status: "active" },
        { id: 2, public_id: STEAM_ID, account_kind: "steam", lifecycle_status: "active" },
      ],
      steam_profiles: [{ account_id: 2, verified: true }],
      account_map: [
        { legacy_id: MANUAL_ID, account_id: 1, source_kind: "app_accounts", source_snapshot_hash: RUN.snapshotHash },
        { legacy_id: STEAM_ID, account_id: 2, source_kind: "app_accounts", source_snapshot_hash: RUN.snapshotHash },
      ],
    },
    RUN.observedAt,
  );
  const steam = result.entries.find((entry) => entry.legacyId === STEAM_ID)!;
  const manualEntry = result.entries.find((entry) => entry.legacyId === MANUAL_ID)!;
  assert.equal(steam.identityVerified, true);
  assert.equal(steam.accountKind, "steam");
  assert.equal(manualEntry.identityVerified, false);
  assert.equal(manualEntry.accountKind, "manual");
  assert.equal(result.run.snapshotHash, RUN.snapshotHash);
});

test("identity transform output feeds the session map and preserves both cookie owners", () => {
  const identityResult = transformIdentityBatch({
    runIdentity: { runId: RUN.runId, snapshotHash: RUN.snapshotHash },
    appAccounts: [
      {
        id: MANUAL_ID,
        account_type: "manual",
        created_at: "2026-01-01 00:00:00.000000+00:00",
        updated_at: "2026-01-02 00:00:00.000000+00:00",
        last_visited_at: null,
      },
      {
        id: STEAM_ID,
        account_type: "steam",
        created_at: "2026-01-01 00:00:00.000000+00:00",
        updated_at: "2026-01-02 00:00:00.000000+00:00",
        last_visited_at: null,
      },
    ],
    appUsers: [
      {
        id: STEAM_ID,
        steam_id: "76561198000000001",
        display_name: "Steam account",
        avatar_url: null,
        created_at: "2026-01-01 00:00:00.000000+00:00",
        updated_at: "2026-01-02 00:00:00.000000+00:00",
        last_login_at: null,
      },
    ],
    manualSteamProfiles: [],
  });
  const map = accountMapFromIdentityResult(identityResult, RUN.observedAt);
  const result = transformSessions(baseInput({ accountMap: map }));
  assert.deepEqual(
    result.sessions.map((session) => [session.sessionKind, session.accountId, session.sourceOwnerId]),
    [
      ["verified_steam", identityResult.accounts.find((account) => account.public_id === STEAM_ID)!.id, STEAM_ID],
      ["verified_steam", identityResult.accounts.find((account) => account.public_id === STEAM_ID)!.id, STEAM_ID],
      ["manual", identityResult.accounts.find((account) => account.public_id === MANUAL_ID)!.id, MANUAL_ID],
    ],
  );
});

test("identity tombstones join without sessions, while deleted-source sessions fail lifecycle", () => {
  const identityResult = identityTombstoneResult();
  const map = accountMapFromIdentityResult(identityResult, RUN.observedAt);
  const tombstone = map.entries.find((entry) => entry.legacyId === DELETED_STEAM_ID)!;
  assert.equal(tombstone.accountKind, "manual");
  assert.equal(tombstone.identityVerified, false);
  assert.equal(tombstone.lifecycleStatus, "deleted");
  assert.deepEqual(tombstone.tombstone, {
    mergeId: DELETED_SOURCE_MERGE,
    sourceDeleted: true,
    verified: false,
    createdAtMeaning: "merge_observed_at",
  });

  const noSessions = transformSessions(
    baseInput({ accountMap: map, verified: [], manual: [] }),
  );
  assert.equal(noSessions.sessions.length, 0);
  assert.equal(noSessions.maps.length, 0);

  assert.equal(
    thrownCode(() =>
      transformSessions(
        baseInput({
          accountMap: map,
          verified: [],
          manual: [{ ...manual, profileId: DELETED_STEAM_ID }],
        }),
      ),
    ),
    "session_owner_lifecycle",
  );

  const activeUnknown = {
    ...identityResult,
    account_map: identityResult.account_map.map((mapping) =>
      mapping.legacy_id === STEAM_ID ? { ...mapping, source_kind: "unknown" as const } : mapping,
    ),
  };
  assert.equal(
    thrownCode(() => accountMapFromIdentityResult(activeUnknown, RUN.observedAt)),
    "session_account_map_invalid",
  );
});
