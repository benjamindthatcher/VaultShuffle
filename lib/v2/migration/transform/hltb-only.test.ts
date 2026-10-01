import assert from "node:assert/strict";
import test from "node:test";
import { isEligibleHltbEstimate, projectHltbDuration } from "./hltb-only.ts";
import { transformDurationEstimates, type DurationEstimateSourceRow } from "./duration-provider.ts";
import { buildGameMap } from "./games.ts";
import type { CatalogueGameFeaturesTargetRecord } from "./catalogue.ts";

const run = { runId: "hltb-only-test", snapshotHash: "a".repeat(64) };
const map = buildGameMap({ runIdentity: run, catalogueGames: [{ steam_appid: "440" }] }).map;
function estimate(overrides: Partial<DurationEstimateSourceRow> = {}) {
  return transformDurationEstimates({ runIdentity: run, gameMap: map, rows: [{
    steam_app_id: "440", provider: "hltb", provider_game_id: "123", main_story_minutes: "600",
    main_extra_minutes: "900", completionist_minutes: "1200", submission_count: "50",
    match_status: "matched", match_confidence: "high", provider_updated_at: "2026-09-01 01:02:03.123456+00",
    checked_at: "2026-09-01 01:02:04+00", next_refresh_at: null, last_error_code: null,
    created_at: "2026-09-01 01:02:03+00", updated_at: "2026-09-01 01:02:04+00",
    evidence: '{"identity_validated":true,"verification_method":"profile_steam_exact","verification_tier":"steam_appid","duration_basis":"completion_times","duration_issues":[]}',
    ...overrides,
  }] }).duration_estimates[0];
}
function feature(overrides: Partial<CatalogueGameFeaturesTargetRecord> = {}): CatalogueGameFeaturesTargetRecord {
  return { game_id: estimate().game_id!, main_duration_minutes: 123, extras_duration_minutes: 456,
    completion_duration_minutes: 789, duration_source: "igdb-parent", duration_source_game_id: "321",
    duration_source_updated_at: null, duration_confidence_label: "high", duration_status: "ready",
    duration_kind: "finite", duration_manual_override: false, popularity_source: "steamspy", popularity_rank: "12",
    ...overrides } as CatalogueGameFeaturesTargetRecord;
}
test("valid HLTB replaces IGDB minutes and identity without timezone shifts", () => {
  const value = projectHltbDuration(feature(), estimate());
  assert.deepEqual([value.main_duration_minutes, value.extras_duration_minutes, value.completion_duration_minutes], [600,900,1200]);
  assert.equal(value.duration_source, "hltb");
  assert.equal(value.duration_source_game_id, "123");
  assert.equal(value.duration_source_updated_at?.canonicalUtc, "2026-09-01T01:02:03.123456Z");
  assert.equal(value.duration_status, "ready");
  assert.equal(value.popularity_rank, "12");
});
test("IGDB-only values become unknown without fallback or retained popularity", () => {
  const value = projectHltbDuration(feature({ popularity_source: "igdb", popularity_rank: "12" }));
  assert.equal(value.main_duration_minutes, null);
  assert.equal(value.duration_source_game_id, null);
  assert.equal(value.duration_source, null);
  assert.equal(value.duration_kind, "unknown");
  assert.equal(value.duration_status, "unknown");
  assert.equal(value.popularity_source, null);
  assert.equal(value.popularity_rank, null);
});
test("human overrides keep their exact values and classification, strip obsolete IGDB identity", () => {
  const value = projectHltbDuration(feature({ duration_manual_override: true, duration_kind: "endless" }), estimate());
  assert.deepEqual([value.main_duration_minutes,value.extras_duration_minutes,value.completion_duration_minutes], [123,456,789]);
  assert.equal(value.duration_manual_override, true);
  assert.equal(value.duration_kind, "endless");
  assert.equal(value.duration_source, "manual");
  assert.equal(value.duration_source_game_id, null);
});
test("independent nonfinite decisions survive; an IGDB-derived nonfinite projection does not", () => {
  for (const kind of ["endless","not-applicable"] as const) {
    const value = projectHltbDuration(feature({ duration_source: "manual_classification", duration_kind: kind }), estimate());
    assert.equal(value.duration_kind, kind);
    assert.equal(projectHltbDuration(feature({ duration_kind: kind })).duration_kind, "unknown");
  }
});
test("weak identity, rejected matches, missing IDs and incoherent durations never project ready", () => {
  for (const overrides of [
    { evidence: '{}' }, { evidence: '{"identity_validated":"true"}' }, { provider_game_id: null },
    { match_status: "needs_review" as const }, { main_story_minutes: "0" },
    { main_extra_minutes: "500" }, { completionist_minutes: "800" },
    { completionist_minutes: "7200" }, { main_story_minutes: "120001" },
    { main_story_minutes: null, main_extra_minutes: null, completionist_minutes: null },
  ]) {
    const e = estimate(overrides);
    assert.equal(isEligibleHltbEstimate(e), false, JSON.stringify(overrides));
    const value = projectHltbDuration(feature(), e);
    assert.equal(value.duration_kind, "unknown");
    assert.equal(value.duration_status, "review_required");
    assert.equal(value.main_duration_minutes, null);
  }
});
test("low-confidence requires exact Steam identity, clean issues and enough duration evidence", () => {
  assert.equal(isEligibleHltbEstimate(estimate({ match_confidence: "low", submission_count: "1" })), true);
  const thin = { match_confidence: "low" as const, submission_count: "1", main_extra_minutes: null, completionist_minutes: null };
  assert.equal(isEligibleHltbEstimate(estimate(thin)), false);
  assert.equal(isEligibleHltbEstimate(estimate({ ...thin, submission_count: "2" })), true);
  assert.equal(isEligibleHltbEstimate(estimate({ match_confidence: "low", evidence: '{"identity_validated":true,"verification_method":"safe_exact_title","verification_tier":"exact_title"}' })), false);
  assert.equal(isEligibleHltbEstimate(estimate({ match_confidence: "low", evidence: '{"identity_validated":true,"verification_method":"profile_steam_exact","verification_tier":"steam_appid","duration_basis":"completion_times","duration_issues":["mismatch"]}' })), false);
});
test("reviewed exact titles/aliases work at medium confidence; an unrelated game cannot be used", () => {
  for (const method of ["safe_exact_title","safe_exact_alias"]) {
    assert.equal(isEligibleHltbEstimate(estimate({ match_confidence: "medium", evidence: JSON.stringify({ identity_validated: true, verification_method: method, verification_tier: "mixed_script_title" }) })), true);
  }
  assert.equal(projectHltbDuration(feature({ game_id: 99999 }), estimate()).duration_source, null);
});
