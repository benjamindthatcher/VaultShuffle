import type { CatalogueGameFeaturesTargetRecord } from "./catalogue.ts";
import type { DurationEstimateTargetRecord } from "./duration-provider.ts";

/** Only aggregate disposal counts survive; obsolete provider payloads do not. */
export function isRetiredIgdbSource(source: unknown): boolean {
  return typeof source === "string" && /igdb/i.test(source);
}

/** The same acceptance rules used by the existing reviewed HLTB writeback. */
export function isEligibleHltbEstimate(estimate: DurationEstimateTargetRecord): boolean {
  if (estimate.provider !== "hltb" || estimate.match_status !== "matched" || estimate.provider_game_id === null
    || !/^[1-9][0-9]*$/.test(estimate.provider_game_id)) return false;
  const evidence = JSON.parse(estimate.evidence.text) as Record<string, unknown>;
  const steamIdentity = evidence.verification_method === "profile_steam_exact" && evidence.verification_tier === "steam_appid";
  const titleIdentity = ["safe_exact_title", "safe_exact_alias"].includes(String(evidence.verification_method))
    && ["exact_title", "mixed_script_title"].includes(String(evidence.verification_tier));
  if (evidence.identity_validated !== true || (!steamIdentity && !titleIdentity)) return false;
  const tiers = [estimate.main_story_minutes, estimate.main_extra_minutes, estimate.completionist_minutes];
  const present = tiers.filter((value): value is number => value !== null);
  if (present.length === 0 || present.some((value) => !Number.isInteger(value) || value < 1 || value > 120000)) return false;
  const [main, extras, completion] = tiers;
  if (main !== null && extras !== null && extras < main) return false;
  if (completion !== null && (extras ?? main) !== null && completion < (extras ?? main)!) return false;
  if (main !== null && completion !== null && completion >= main * 12) return false;
  if (["medium", "high"].includes(estimate.match_confidence ?? "")) return true;
  return estimate.match_confidence === "low" && steamIdentity && evidence.duration_basis === "completion_times"
    && Array.isArray(evidence.duration_issues) && evidence.duration_issues.length === 0
    && ((estimate.submission_count ?? 0) >= 2 || present.length >= 2);
}

/** No provider fallback. Independent manual/nonfinite decisions take precedence. */
export function projectHltbDuration(feature: CatalogueGameFeaturesTargetRecord, estimate?: DurationEstimateTargetRecord): CatalogueGameFeaturesTargetRecord {
  let result = feature;
  if (isRetiredIgdbSource(feature.popularity_source)) {
    result = { ...result, popularity_source: null, popularity_metric: null, popularity_rank: null,
      popularity_low: null, popularity_high: null, popularity_ccu: null, source_captured_on: null };
  }
  const retired = isRetiredIgdbSource(feature.duration_source);
  if (feature.duration_manual_override) {
    return Object.freeze(retired ? { ...result, duration_source: "manual", duration_source_game_id: null,
      duration_source_updated_at: null, duration_confidence_label: null } : result);
  }
  if (!retired && ["endless", "not-applicable"].includes(feature.duration_kind)) return Object.freeze(result);
  if (estimate && estimate.game_id === feature.game_id && isEligibleHltbEstimate(estimate)) {
    return Object.freeze({ ...result, main_duration_minutes: estimate.main_story_minutes,
      extras_duration_minutes: estimate.main_extra_minutes, completion_duration_minutes: estimate.completionist_minutes,
      duration_source: "hltb", duration_source_game_id: estimate.provider_game_id,
      duration_source_updated_at: estimate.provider_updated_at, duration_confidence_label: estimate.match_confidence as "low" | "medium" | "high",
      duration_status: "ready", duration_kind: "finite" });
  }
  return Object.freeze({ ...result, main_duration_minutes: null, extras_duration_minutes: null,
    completion_duration_minutes: null, duration_source: null, duration_source_game_id: null,
    duration_source_updated_at: null, duration_confidence_label: null, duration_kind: "unknown",
    duration_status: estimate ? "review_required" : "unknown" });
}
