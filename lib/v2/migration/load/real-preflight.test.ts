import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  computeOperationalDiagnostics,
  computeP05Diagnostics,
  computePurgeCompletionDiagnostics,
  computeCatalogueSightingDiagnostics,
  fingerprintTransformBatches,
} from "./real-preflight.ts";
import { stageVerifiedRun } from "./staging.ts";
import type { VerifiedRun } from "../read/reader.ts";

test("P05 reproduces the actual positive legacy JavaScript rounding path and splits access source", () => {
  const result = computeP05Diagnostics([
    { access_source: "owned", observed_playtime_minutes: "1", hours_played: "0" },
    { access_source: "owned", observed_playtime_minutes: "3", hours_played: "0.1" },
    { access_source: "family", observed_playtime_minutes: null, hours_played: "0" },
  ], [{ hours_at_pin: "0.15" }], [{ hours_played: "0.15", estimate_minutes: null, price_cents: "0" }]);
  assert.deepEqual(result.user_games_by_access_source.map((entry) => ({ access_source: entry.access_source, rows_total: entry.rows_total, mismatches: entry.hours_not_reproducible_by_legacy_js })), [
    { access_source: "family", rows_total: 1, mismatches: 0 },
    { access_source: "owned", rows_total: 2, mismatches: 0 },
  ]);
  assert.equal(result.pins.conversion_loses_precision, 0);
  assert.equal(result.completion_events.hours_not_whole_minutes, 0);
  assert.equal(result.user_games_by_access_source.find((entry) => entry.access_source === "owned")?.exact_minutes_sum, "4");
  assert.equal(result.user_games_by_access_source.find((entry) => entry.access_source === "owned")?.legacy_js_rounded_hours_tenths_sum, "1");
});

test("purge completion diagnostic reports missing active events without exposing identities", () => {
  const result = computePurgeCompletionDiagnostics(
    [{ action: "complete", user_id: "account-a", game_id: "game-a" }, { action: "keep", user_id: "account-b", game_id: "game-gone" }],
    [{ user_id: "account-a", game_id: "game-a", undone_at: null }],
    [{ id: "game-a" }],
  );
  assert.deepEqual(result.by_action, [
    { action: "complete", review_rows: 1, reviews_whose_library_row_is_gone: 0, completions_with_no_matching_event: 0, accounts: 1 },
    { action: "keep", review_rows: 1, reviews_whose_library_row_is_gone: 1, completions_with_no_matching_event: 0, accounts: 1 },
  ]);
  assert.deepEqual(result.complete_without_active_event, { reviews: 0, with_any_matching_event: 0, with_undone_only_events: 0, with_no_event_ever: 0,
    current_library_status: { completed: 0, other: 0, missing: 0 } });
  assert.equal(JSON.stringify(result).includes("account-a"), false);
});

test("operational diagnostics count in-flight imports and leave cooldown expiry unresolved", () => {
  const result = computeOperationalDiagnostics({
    steam_import_jobs: [{ status: "importing" }, { status: "complete" }],
    api_rate_limits: [{ window_started_at: "2026-09-13 00:00:00+00" }],
  });
  assert.equal(result.imports.in_flight, 1);
  assert.equal(result.cooldowns.rows, 1);
  assert.equal(result.cooldowns.unexpired, null);
});

test("catalogue sighting diagnostics classify duplicate fact disagreements without AppIDs", () => {
  const result = computeCatalogueSightingDiagnostics(
    [{ steam_appid: "1", import_sighting_count: "2", first_seen_at: "2026-01-01 00:00:00+00", last_seen_at: "2026-01-02 00:00:00+00" }],
    [{ steam_appid: "1", import_count: "3", first_seen_at: "2026-01-01T00:00:00Z", last_seen_at: "2026-01-02 00:00:00+00" }],
  );
  assert.equal(result.conflicting_overlaps, 1);
  assert.equal(result.import_count_mismatches, 1);
  assert.equal(result.first_seen_mismatches, 0);
  assert.equal(JSON.stringify(result).includes("steam_appid"), false);
});

test("private staging accepts an explicitly configured bound above the 256 MiB default", async () => {
  const parent = await mkdtemp(join(tmpdir(), "vs-real-preflight-limit-"));
  await chmod(parent, 0o700);
  const sha = "a".repeat(64);
  const run = Object.freeze({
    runDirectory: join(parent, "source"),
    manifest: {} as VerifiedRun["manifest"],
    relations: Object.freeze([{ schema: "public", name: "wide_view", columns: Object.freeze([]), rows: 0, bytes: 0, sha256: sha }]),
    streamRelationRows: async () => ({ relation: "public.wide_view", rows: 0, bytes: 0, sha256: sha }),
  }) satisfies VerifiedRun;
  try {
    const staged = await stageVerifiedRun(run, ["public.wide_view"], join(parent, "stage"), { maxBytesPerRelation: 512 * 1024 * 1024 });
    assert.equal(staged.totalRows, 0);
    staged.destroy();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("transform fingerprint streams framed batches deterministically", () => {
  const batches = [
    { relation: "app.accounts", rows: [{ id: 1 }, { id: 2 }] },
    { relation: "catalog.games", rows: [{ id: 3 }] },
  ];
  assert.equal(fingerprintTransformBatches(batches), fingerprintTransformBatches(batches));
  assert.notEqual(
    fingerprintTransformBatches(batches),
    fingerprintTransformBatches([{ ...batches[0], rows: [{ id: 1 }, { id: 4 }] }, batches[1]]),
  );
  assert.notEqual(fingerprintTransformBatches(batches), fingerprintTransformBatches([...batches].reverse()));
});
