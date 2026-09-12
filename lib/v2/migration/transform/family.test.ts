import assert from "node:assert/strict";
import test from "node:test";
import { parsePgTimestamptz, type PgTimestamp } from "./scalars.ts";
import { LibraryTransformError } from "./library-shared.ts";
import {
  canonicalFamilyResult,
  transformFamilyBatch,
  type FamilyMemberSourceRow,
  type FamilyTransformInput,
} from "./family.ts";
import type { FamilyAccessCandidate } from "./library.ts";
import type { AccountMapTargetRecord } from "./accounts.ts";

/**
 * Family expectations are written against the destination columns by hand.
 * The load-bearing rules are that a lender row is never synthesised to make an
 * access row fit, that lender playtime never appears anywhere in this domain,
 * and that candidacy is not access.
 */

const SNAPSHOT = "e".repeat(64);
const RUN = Object.freeze({ runId: "family-test-run", snapshotHash: SNAPSHOT });
const ACCOUNT_A = "20000000-0000-4000-8000-00000000000a";
const ACCOUNT_B = "20000000-0000-4000-8000-00000000000b";
const MEMBER_1 = "40000000-0000-4000-8000-000000000001";
const MEMBER_2 = "40000000-0000-4000-8000-000000000002";
const MEMBER_3 = "40000000-0000-4000-8000-000000000003";
const LENDER_LOW = "76561198000000007";
const LENDER_HIGH = "76561198000000042";
const ROW_1 = "30000000-0000-4000-8000-000000000001";

const ACCOUNT_MAP: readonly AccountMapTargetRecord[] = Object.freeze([
  { legacy_id: ACCOUNT_A, account_id: 1, source_kind: "app_accounts", source_snapshot_hash: SNAPSHOT },
  { legacy_id: ACCOUNT_B, account_id: 2, source_kind: "app_accounts", source_snapshot_hash: SNAPSHOT },
]);

function instant(text: string): PgTimestamp {
  const parsed = parsePgTimestamptz(text);
  assert.ok(parsed !== null);
  return parsed;
}

function member(overrides: Partial<FamilyMemberSourceRow> = {}): FamilyMemberSourceRow {
  return {
    id: MEMBER_1,
    user_id: ACCOUNT_A,
    steam_id: LENDER_HIGH,
    display_name: "Lender One",
    avatar_url: "https://cdn.example/a.png",
    profile_url: "https://steamcommunity.com/profiles/76561198000000042",
    candidate_appids: "{10,220}",
    library_seen: "2",
    games_imported: "0",
    last_synced_at: "2026-02-01 00:00:00+00",
    last_error: null,
    created_at: "2026-01-01 00:00:00+00",
    updated_at: "2026-01-02 00:00:00+00",
    ...overrides,
  };
}

function candidate(overrides: Partial<FamilyAccessCandidate> = {}): FamilyAccessCandidate {
  return {
    legacy_row_id: ROW_1,
    source_user_id: ACCOUNT_A,
    account_id: 1,
    game_id: 7,
    steam_app_id: "10",
    lender_steam_id: LENDER_HIGH,
    lender_steam_id_status: "source",
    lender_steam_id_raw: null,
    provenance: "verified",
    observed_at: instant("2026-02-03 04:05:06+00"),
    observed_at_status: "source",
    ownership: "Owned",
    ...overrides,
    source_snapshot_hash: overrides.source_snapshot_hash ?? SNAPSHOT,
  };
}

function input(
  members: readonly FamilyMemberSourceRow[],
  candidates: readonly FamilyAccessCandidate[] = [],
): FamilyTransformInput {
  return {
    runIdentity: RUN,
    accountMap: ACCOUNT_MAP,
    familyMembers: members,
    familyAccessCandidates: candidates,
  };
}

function conflictCount(
  result: { conflicts: readonly { conflict_class: string; conflict_count: number }[] },
  name: string,
): number {
  return result.conflicts
    .filter((entry) => entry.conflict_class === name)
    .reduce((total, entry) => total + entry.conflict_count, 0);
}

test("a lender row maps to every M1 and M3 family column", () => {
  const result = transformFamilyBatch(input([member()]));
  assert.deepEqual(
    result.family_members.map((entry) => ({
      ...entry,
      candidate_app_ids: [...entry.candidate_app_ids],
      checked_at: entry.checked_at?.canonicalUtc ?? null,
      last_synced_at: entry.last_synced_at?.canonicalUtc ?? null,
    })),
    [
      {
        id: 1,
        account_id: 1,
        steam_id: LENDER_HIGH,
        candidate_app_ids: [10, 220],
        candidate_count: 2,
        checked_at: "2026-02-01T00:00:00.000000Z",
        error_status: "ok",
        legacy_member_id: MEMBER_1,
        display_name: "Lender One",
        avatar_url: "https://cdn.example/a.png",
        profile_url: "https://steamcommunity.com/profiles/76561198000000042",
        legacy_library_seen: 2,
        legacy_games_imported: 0,
        last_synced_at: "2026-02-01T00:00:00.000000Z",
        last_error: null,
        cap_status: "within_cap",
        candidate_cap_status: "within_cap",
        candidate_jsonb_bytes_upper_bound: 56,
      },
    ],
  );
  assert.equal(result.legacy_family_member_evidence[0].created_at.canonicalUtc, "2026-01-01T00:00:00.000000Z");
  assert.equal(result.legacy_family_member_evidence[0].retention_class, "staging-30d-post-cutover");
});

test("member identities are assigned deterministically by account then Steam identity", () => {
  const result = transformFamilyBatch(
    input([
      member({ id: MEMBER_2, steam_id: LENDER_HIGH, candidate_appids: "{}", library_seen: "0" }),
      member({ id: MEMBER_1, steam_id: LENDER_LOW, candidate_appids: "{}", library_seen: "0" }),
      member({ id: MEMBER_3, user_id: ACCOUNT_B, steam_id: LENDER_LOW, candidate_appids: "{}", library_seen: "0" }),
    ]),
  );
  assert.deepEqual(
    result.family_members.map((entry) => [entry.id, entry.account_id, entry.steam_id]),
    [
      [1, 1, LENDER_LOW],
      [2, 1, LENDER_HIGH],
      [3, 2, LENDER_LOW],
    ],
  );
});

test("the four-value error status follows the sync evidence", () => {
  const ok = transformFamilyBatch(input([member({ last_error: null, last_synced_at: "2026-02-01 00:00:00+00" })]));
  assert.equal(ok.family_members[0].error_status, "ok");

  const unknown = transformFamilyBatch(input([member({ last_error: null, last_synced_at: null })]));
  assert.equal(unknown.family_members[0].error_status, "unknown");
  assert.equal(unknown.family_members[0].checked_at, null);

  const failed = transformFamilyBatch(input([member({ last_error: "steam returned 500" })]));
  assert.equal(failed.family_members[0].error_status, "error");
  assert.equal(failed.family_members[0].last_error, "steam returned 500");

  const refused = transformFamilyBatch(input([member({ last_error: "Profile is private" })]));
  assert.equal(refused.family_members[0].error_status, "private");

  const blank = transformFamilyBatch(input([member({ last_error: "   " })]));
  assert.equal(blank.family_members[0].error_status, "ok");
  assert.equal(blank.family_members[0].last_error, null);
});

test("an over-length sync error is preserved in staging rather than truncated", () => {
  const longError = `steam ${"x".repeat(2_100)}`;
  const result = transformFamilyBatch(input([member({ last_error: longError })]));
  assert.equal(result.family_members[0].last_error, null);
  assert.equal(result.family_members[0].error_status, "error");
  assert.equal(result.legacy_family_member_evidence[0].raw_last_error, longError);
  assert.equal(conflictCount(result, "family_last_error_over_length"), 1);
});

test("over-length lender display text is never truncated", () => {
  const result = transformFamilyBatch(input([member({ display_name: "n".repeat(201) })]));
  assert.equal(result.family_members[0].display_name, null);
  assert.equal(result.legacy_family_member_evidence[0].evidence.raw_display_name, "n".repeat(201));
  assert.equal(conflictCount(result, "family_member_text_over_length"), 1);

  const empty = transformFamilyBatch(input([member({ display_name: "   " })]));
  assert.equal(empty.family_members[0].display_name, null);
  assert.equal(conflictCount(empty, "family_member_text_empty"), 1);
});

test("URL whitespace is preserved and over-length profile text remains bounded evidence", () => {
  const whitespace = transformFamilyBatch(input([member({ avatar_url: "   " })]));
  assert.equal(whitespace.family_members[0].avatar_url, "   ");
  assert.equal(conflictCount(whitespace, "family_member_text_empty"), 0);

  const longUrl = `https://example.test/${"u".repeat(2_050)}`;
  const result = transformFamilyBatch(input([member({ profile_url: longUrl })]));
  assert.equal(result.family_members[0].profile_url, null);
  assert.equal(result.legacy_family_member_evidence[0].evidence.raw_profile_url, longUrl);
  assert.equal(conflictCount(result, "family_member_text_over_length"), 1);
});

test("malformed PostgreSQL arrays are refused rather than repaired", () => {
  const malformed = [
    "1,2",
    "{1,2",
    "{1,,2}",
    "{,1}",
    "{1,}",
    "{{1}}",
    "{NULL}",
    "{null}",
    '{"1}',
    "{abc}",
    "{ 1 }",
    "",
  ];
  for (const text of malformed) {
    assert.throws(
      () => transformFamilyBatch(input([member({ candidate_appids: text, library_seen: "0" })])),
      (error: unknown) =>
        error instanceof LibraryTransformError &&
        (error.libraryCode === "library_invalid_array" || error.libraryCode === "library_invalid_integer"),
      `expected ${JSON.stringify(text)} to be refused`,
    );
  }
});

test("well-formed arrays parse exactly, including quoted elements and the empty array", () => {
  const empty = transformFamilyBatch(input([member({ candidate_appids: "{}", library_seen: "0" })]));
  assert.deepEqual(empty.family_members[0].candidate_app_ids, []);
  assert.equal(empty.family_members[0].candidate_count, 0);

  const quoted = transformFamilyBatch(
    input([member({ candidate_appids: '{"10",220,4294967295}', library_seen: "3" })]),
  );
  assert.deepEqual(quoted.family_members[0].candidate_app_ids, [10, 220, 4294967295]);
});

test("an out-of-range candidate AppID is refused instead of being dropped", () => {
  assert.throws(
    () => transformFamilyBatch(input([member({ candidate_appids: "{4294967296}", library_seen: "1" })])),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_invalid_integer",
  );
});

test("an over-cap candidate array is reported whole, never truncated", () => {
  const appIds = Array.from({ length: 10_001 }, (_value, index) => index + 1);
  const result = transformFamilyBatch(
    input([member({ candidate_appids: `{${appIds.join(",")}}`, library_seen: "10001" })]),
  );
  assert.equal(result.family_members[0].candidate_app_ids.length, 10_001);
  assert.equal(result.family_members[0].candidate_cap_status, "over_cap");
  assert.equal(conflictCount(result, "family_candidate_array_over_cap"), 1);
});

test("library_seen is preserved verbatim and never clamped into candidate_count", () => {
  const result = transformFamilyBatch(input([member({ candidate_appids: "{10}", library_seen: "5000" })]));
  assert.equal(result.family_members[0].candidate_count, 1);
  assert.equal(result.family_members[0].legacy_library_seen, 5000);
  assert.equal(conflictCount(result, "family_library_seen_vs_candidates"), 1);
});

test("the five-member cap is a precheck that reports rather than drops a lender", () => {
  const members = Array.from({ length: 6 }, (_value, index) =>
    member({
      id: `40000000-0000-4000-8000-00000000001${index}`,
      steam_id: `7656119800000010${index}`,
      candidate_appids: "{}",
      library_seen: "0",
    }),
  );
  const result = transformFamilyBatch(input(members));
  assert.equal(result.family_members.length, 6);
  assert.deepEqual(
    result.family_members.map((entry) => entry.cap_status),
    ["within_cap", "within_cap", "within_cap", "within_cap", "within_cap", "over_cap"],
  );
  assert.equal(conflictCount(result, "family_member_cap_exceeded"), 1);
});

test("resolved access carries a member key and no playtime of any kind", () => {
  const result = transformFamilyBatch(input([member()], [candidate()]));
  assert.deepEqual(
    result.family_game_access.map((entry) => ({ ...entry, observed_at: entry.observed_at?.canonicalUtc ?? null })),
    [
      {
        account_id: 1,
        member_id: 1,
        game_id: 7,
        observed_at: "2026-02-03T04:05:06.000000Z",
        observed_at_status: "source",
        provenance: "verified",
      },
    ],
  );
  assert.equal(result.family_access_orphans.length, 0);
  const serialized = JSON.stringify(result.family_game_access);
  assert.equal(/minute/i.test(serialized), false);
  assert.equal(/playtime/i.test(serialized), false);
});

test("access naming an absent lender becomes orphan evidence that confers nothing", () => {
  const result = transformFamilyBatch(input([member({ steam_id: LENDER_LOW })], [candidate()]));
  assert.equal(result.family_game_access.length, 0);
  assert.deepEqual(
    result.family_access_orphans.map((entry) => ({ ...entry, observed_at: entry.observed_at?.canonicalUtc ?? null })),
    [
      {
        account_id: 1,
        game_id: 7,
        steam_app_id: "10",
        lender_steam_id: LENDER_HIGH,
        observed_at: "2026-02-03T04:05:06.000000Z",
        disposition: "quarantine",
        confers_access: false,
        source_snapshot_hash: SNAPSHOT,
      },
    ],
  );
  assert.deepEqual(result.legacy_family_access_orphans[0].source_member_id, null);
  assert.equal(result.legacy_family_access_orphans[0].source_user_id, ACCOUNT_A);
  assert.equal(conflictCount(result, "family_access_orphan_lender_absent"), 1);
  // No member row was invented to satisfy the composite foreign key.
  assert.equal(result.family_members.length, 1);
  assert.equal(result.family_members[0].steam_id, LENDER_LOW);
});

test("a malformed lender identity keeps its raw text in staging evidence only", () => {
  const result = transformFamilyBatch(
    input(
      [member()],
      [candidate({ lender_steam_id: null, lender_steam_id_status: "malformed", lender_steam_id_raw: "bogus" })],
    ),
  );
  assert.equal(result.family_access_orphans[0].lender_steam_id, null);
  assert.equal(result.legacy_family_access_orphans[0].evidence.lender_steam_id_raw, "bogus");
});

test("simultaneous lenders are preserved and candidacy never becomes access", () => {
  const result = transformFamilyBatch(
    input([
      member({ id: MEMBER_1, steam_id: LENDER_LOW, candidate_appids: "{10,220}", library_seen: "2" }),
      member({ id: MEMBER_2, steam_id: LENDER_HIGH, candidate_appids: "{10,220}", library_seen: "2" }),
    ]),
  );
  assert.equal(result.family_members.length, 2);
  assert.deepEqual(result.family_members.map((entry) => entry.candidate_app_ids), [
    [10, 220],
    [10, 220],
  ]);
  // Both lenders list AppID 10, and neither produced an access row.
  assert.equal(result.family_game_access.length, 0);
});

test("a recomputed access count that disagrees with games_imported is reported", () => {
  const result = transformFamilyBatch(input([member({ games_imported: "9" })], [candidate()]));
  assert.equal(conflictCount(result, "family_games_imported_not_recomputable"), 1);
  assert.equal(result.family_members[0].legacy_games_imported, 9);
});

test("output is identical under permuted input order", () => {
  const members = [
    member({ id: MEMBER_2, steam_id: LENDER_HIGH }),
    member({ id: MEMBER_1, steam_id: LENDER_LOW, candidate_appids: "{10}", library_seen: "1" }),
    member({ id: MEMBER_3, user_id: ACCOUNT_B, steam_id: LENDER_LOW, candidate_appids: "{}", library_seen: "0" }),
  ];
  const candidates = [
    candidate({ steam_app_id: "220", game_id: 8 }),
    candidate({ steam_app_id: "10", game_id: 7, lender_steam_id: LENDER_LOW }),
  ];
  const forward = canonicalFamilyResult(transformFamilyBatch(input(members, candidates)));
  const reversed = canonicalFamilyResult(
    transformFamilyBatch(input([...members].reverse(), [...candidates].reverse())),
  );
  assert.equal(forward, reversed);
});

test("duplicate members, foreign runs and malformed Steam identities fail explicitly", () => {
  assert.throws(
    () => transformFamilyBatch(input([member(), member({ steam_id: LENDER_LOW })])),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_duplicate_identity",
  );
  assert.throws(
    () => transformFamilyBatch(input([member(), member({ id: MEMBER_2 })])),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_duplicate_identity",
  );
  assert.throws(
    () => transformFamilyBatch(input([member({ run_id: "other" })])),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_mixed_run_identity",
  );
  assert.throws(
    () => transformFamilyBatch(input([member({ steam_id: "12345" })])),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_invalid_integer",
  );
});

test("the library access hand-off rejects foreign identity, run and timestamp records", () => {
  assert.throws(
    () => transformFamilyBatch(input([member()], [candidate({ source_snapshot_hash: "a".repeat(64) })])),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_mixed_run_identity",
  );
  assert.throws(
    () => transformFamilyBatch(input([member()], [candidate({ source_user_id: ACCOUNT_B })])),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_input_invalid",
  );
  assert.throws(
    () =>
      transformFamilyBatch(
        input([member()], [candidate({ observed_at: null, observed_at_status: "source" })]),
      ),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_input_invalid",
  );
});

test("failures carry no lender identity or display text", () => {
  try {
    transformFamilyBatch(input([member({ steam_id: LENDER_HIGH, candidate_appids: "{{1}}" })]));
    assert.fail("expected a library transform failure");
  } catch (error) {
    assert.ok(error instanceof LibraryTransformError);
    const serialized = JSON.stringify(error.toJSON());
    assert.equal(serialized.includes(LENDER_HIGH), false);
    assert.equal(serialized.includes("Lender One"), false);
    assert.equal(serialized.includes(MEMBER_1), false);
  }
});

test("the display-name bound is the target's trimmed length and the stored text stays verbatim", () => {
  // app.family_members.display_name checks length(btrim(display_name))
  // between 1 and 200, so 200 characters inside spaces is a value it accepts.
  const padded = `  ${"n".repeat(200)} `;
  const accepted = transformFamilyBatch(input([member({ display_name: padded })]));
  assert.equal(accepted.family_members[0].display_name, padded);
  assert.equal(conflictCount(accepted, "family_member_text_over_length"), 0);

  const overLength = transformFamilyBatch(input([member({ display_name: `  ${"n".repeat(201)} ` })]));
  assert.equal(overLength.family_members[0].display_name, null);
  assert.equal(conflictCount(overLength, "family_member_text_over_length"), 1);
});

test("bounded evidence is measured in encoded bytes, not characters", () => {
  // Every character here is three UTF-8 bytes, so 20000 source characters are
  // 60000 bytes and cannot reach a pg_column_size(evidence) <= 32768 column.
  const multibyte = "あ".repeat(20_000);
  assert.throws(
    () => transformFamilyBatch(input([member({ display_name: multibyte })])),
    (error: unknown) =>
      error instanceof LibraryTransformError &&
      error.libraryCode === "library_unrepresentable_value" &&
      error.diagnostics[0].relation === "user_family_members" &&
      error.diagnostics[0].field === "evidence",
  );

  const ascii = "n".repeat(10_000);
  const accepted = transformFamilyBatch(input([member({ display_name: ascii })]));
  assert.equal(accepted.legacy_family_member_evidence[0].evidence.raw_display_name, ascii);
});

test("a malformed lender identity too large for the orphan payload fails closed", () => {
  const multibyte = "あ".repeat(20_000);
  assert.throws(
    () =>
      transformFamilyBatch(
        input([], [candidate({ lender_steam_id: null, lender_steam_id_status: "malformed", lender_steam_id_raw: multibyte })]),
      ),
    (error: unknown) =>
      error instanceof LibraryTransformError &&
      error.libraryCode === "library_unrepresentable_value" &&
      error.diagnostics[0].relation === "user_games" &&
      error.diagnostics[0].field === "evidence",
  );

  const ascii = "not-a-steam-id-".repeat(500);
  const accepted = transformFamilyBatch(
    input([], [candidate({ lender_steam_id: null, lender_steam_id_status: "malformed", lender_steam_id_raw: ascii })]),
  );
  assert.equal(accepted.legacy_family_access_orphans[0].evidence.lender_steam_id_raw, ascii);
  assert.equal(accepted.family_access_orphans[0].lender_steam_id, null);
  assert.equal(accepted.family_access_orphans[0].confers_access, false);
  assert.equal(accepted.family_game_access.length, 0);
});

test("the same lender AppID in two accounts produces two independent member keys", () => {
  const result = transformFamilyBatch(
    input(
      [
        member({ id: MEMBER_1, user_id: ACCOUNT_A, steam_id: LENDER_HIGH, candidate_appids: "{10}", library_seen: "1" }),
        member({ id: MEMBER_2, user_id: ACCOUNT_B, steam_id: LENDER_HIGH, candidate_appids: "{10}", library_seen: "1" }),
      ],
      [
        candidate({ account_id: 1, source_user_id: ACCOUNT_A, game_id: 7, steam_app_id: "10" }),
        candidate({
          legacy_row_id: "30000000-0000-4000-8000-000000000002",
          account_id: 2,
          source_user_id: ACCOUNT_B,
          game_id: 7,
          steam_app_id: "10",
        }),
      ],
    ),
  );
  assert.deepEqual(
    result.family_game_access.map((entry) => [entry.account_id, entry.member_id, entry.game_id]),
    [
      [1, 1, 7],
      [2, 2, 7],
    ],
  );
  assert.equal(new Set(result.family_members.map((entry) => entry.id)).size, 2);
  assert.equal(result.family_access_orphans.length, 0);
});

test("a sixth lender keeps its row, its identity and its access while the cap is reported", () => {
  const steamIds = [
    "76561198000000001",
    "76561198000000002",
    "76561198000000003",
    "76561198000000004",
    "76561198000000005",
    "76561198000000006",
  ];
  const members = steamIds.map((steamId, index) =>
    member({
      id: `40000000-0000-4000-8000-00000000000${index + 1}`,
      steam_id: steamId,
      candidate_appids: "{10}",
      library_seen: "1",
    }),
  );
  const result = transformFamilyBatch(
    input(members, [candidate({ lender_steam_id: steamIds[5], game_id: 7, steam_app_id: "10" })]),
  );
  assert.equal(result.family_members.length, 6);
  assert.deepEqual(
    result.family_members.map((entry) => entry.cap_status),
    ["within_cap", "within_cap", "within_cap", "within_cap", "within_cap", "over_cap"],
  );
  assert.equal(conflictCount(result, "family_member_cap_exceeded"), 1);
  // The over-cap lender still resolves its access; nothing is dropped.
  assert.deepEqual(result.family_game_access, [
    {
      account_id: 1,
      member_id: 6,
      game_id: 7,
      observed_at: result.family_game_access[0].observed_at,
      observed_at_status: "source",
      provenance: "verified",
    },
  ]);
});
