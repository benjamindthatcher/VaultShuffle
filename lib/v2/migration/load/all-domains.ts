import { transformIdentityBatch } from "../transform/accounts.ts";
import { accountMapFromIdentityResult, transformSessions } from "../transform/sessions.ts";
import { transformCapabilities } from "../transform/capabilities.ts";
import { buildGameMap } from "../transform/games.ts";
import { transformCatalogue } from "../transform/catalogue.ts";
import { transformLibraryBatch } from "../transform/library.ts";
import { transformLegacyGameState } from "../transform/library-state.ts";
import { transformFamilyBatch } from "../transform/family.ts";
import { transformHistoryBatch } from "../transform/history.ts";
import { transformCollections } from "../transform/collections.ts";
import { transformCommitments } from "../transform/commitments.ts";
import { transformDraws } from "../transform/draws.ts";
import { transformRecoConfigBatch } from "../transform/reco-config.ts";
import { transformSupportOpsBatch } from "../transform/support-ops.ts";
import { transformLegacyOperationsBatch } from "../transform/legacy-operations.ts";
import {
  transformDurationAliases, transformDurationEstimates, transformDurationImportRuns,
  transformDurationJobArchive, transformDurationReviews,
} from "../transform/duration-provider.ts";
import {
  transformGameQuarantine, transformGuestCataloguePool, transformIngestQueueArchive, transformSeedRuns,
} from "../transform/catalogue-provenance.ts";
import type { LoadBatch } from "./contract.ts";
import type { TargetValue } from "./copy.ts";
import type { TransformOutcome } from "./pipeline.ts";
import { loaderFailure } from "./errors.ts";
import { asRecords, type StagedRun } from "./staging.ts";

/** The immutable public export inventory: every relation must be staged once. */
export const ALL_SOURCE_RELATIONS = Object.freeze([
  "account_merges", "algorithm_weights", "api_rate_limits", "app_accounts", "app_settings", "app_users",
  "catalog_duration_import_runs", "catalog_duration_review_queue", "catalog_duration_reviews", "catalog_game_quarantine",
  "catalog_game_sightings", "catalog_games", "catalog_ingest_queue", "catalog_seed_runs", "collection_games",
  "collections", "completion_events", "contact_messages", "feedback_submissions", "game_duration_aliases",
  "game_duration_estimates", "game_duration_jobs", "game_preference_globals", "genre_preference_globals",
  "guest_catalogue_pool", "manual_profile_security_intents", "manual_profile_sessions", "manual_steam_profiles",
  "metadata_worker_runs", "purge_reviews", "sessions", "steam_import_jobs", "user_family_members", "user_game_pins",
  "user_game_snoozes", "user_game_state", "user_games", "user_games_with_catalog", "user_genre_preferences",
  "user_playtime_snapshots", "user_vault_state", "vault_draw_events", "vault_draws", "vault_events",
] as const);
export type AllSourceRelation = (typeof ALL_SOURCE_RELATIONS)[number];

export type SourceAccounting = Readonly<{ relation: string; sourceRows: number; loadedRows: number; archivedRows: number; conflictRows: number; disposition: "transform" | "rebuild" }>;
export type TargetContractAddition = Readonly<{ relation: string; reason: string }>;
export type AllDomainsEvidence = Readonly<{
  observedAt: string;
  catalogueOfferPolicy?: unknown;
  gameStubs?: readonly object[];
  warmStart: unknown;
  operatorConfig: unknown;
  cutover?: unknown;
  mergeTombstones?: readonly object[];
  targetRelations?: readonly string[];
}>;
export type AllDomainsResult = TransformOutcome & Readonly<{
  sourceAccounting: readonly SourceAccounting[];
  targetContractAdditions: readonly TargetContractAddition[];
  gameMap: unknown;
  accountMap: unknown;
}>;

function sourceName(relation: string): string {
  return relation.startsWith("public.") ? relation.slice("public.".length) : relation;
}

function cellRows(staged: StagedRun, relation: AllSourceRelation): readonly Readonly<Record<string, string | null>>[] {
  const found = staged.relations.find((entry) => sourceName(entry.relation) === relation);
  if (!found) throw loaderFailure("loader_source_coverage", { relation });
  return asRecords(found);
}

function sourceRunRows(rows: readonly Readonly<Record<string, string | null>>[]): readonly object[] {
  return rows as readonly object[];
}

/** Convert transform records to loader values without reserialising private JSON. */
function value(value: unknown): TargetValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean" || value instanceof Uint8Array) return value;
  if (typeof value === "object" && value !== null && "text" in value && typeof (value as { text?: unknown }).text === "string") return (value as { text: string }).text;
  return value as TargetValue;
}
function batch(relation: string, rows: readonly unknown[]): LoadBatch {
  return Object.freeze({ relation, rows: Object.freeze(rows.map((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) throw loaderFailure("loader_contract_invalid", { field: "transform_row" });
    return Object.freeze(Object.fromEntries(Object.entries(row).map(([key, entry]) => [key, value(entry)])));
  })) });
}
function collectBatches(result: Record<string, unknown>, mapping: Readonly<Record<string, string>>, into: LoadBatch[]): void {
  for (const [key, relation] of Object.entries(mapping)) {
    const rows = result[key];
    if (Array.isArray(rows)) into.push(batch(relation, rows));
  }
}

/** A transform may contribute evidence to the same target relation as another
 * transform.  The loader contract accepts one batch per relation, so preserve
 * each transform's already-deterministic row order while coalescing them. */
function mergeBatches(batches: readonly LoadBatch[]): readonly LoadBatch[] {
  const rowsByRelation = new Map<string, LoadBatch["rows"][number][]>();
  for (const entry of batches) {
    const rows = rowsByRelation.get(entry.relation);
    if (rows) rows.push(...entry.rows);
    else rowsByRelation.set(entry.relation, [...entry.rows]);
  }
  return Object.freeze([...rowsByRelation.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relation, rows]) => Object.freeze({ relation, rows: Object.freeze(rows) })));
}

/** Keep private withheld streams out of batches, but make each one a durable
 * pre-commit exception.  This is exported for a direct adverse gate test. */
export function aggregateDomainGateCounts(input: Readonly<{
  recencyExceptions: number;
  completionOrderingExceptions: number;
  drawUnresolvedReferences: number;
  supportWithheld: number;
  recoWithheldCounters: number;
  recoWithheldSettings: number;
}>): Readonly<Record<string, number>> {
  return Object.freeze({
    recency_exceptions: input.recencyExceptions,
    completion_ordering_exceptions: input.completionOrderingExceptions,
    draw_unresolved_references: input.drawUnresolvedReferences,
    support_withheld: input.supportWithheld,
    reco_withheld_counters: input.recoWithheldCounters,
    settings_withheld: input.recoWithheldSettings,
  });
}

/**
 * Assemble every frozen transform from one sealed staged run.  It deliberately
 * has no target access: exceptions, withheld records and target-contract gaps
 * are returned to the pipeline pre-commit gate instead of being written.
 */
export function assembleAllDomains(staged: StagedRun, runIdentity: Readonly<{ runId: string; snapshotHash: string }>, evidence: AllDomainsEvidence): AllDomainsResult {
  if (!staged || typeof staged !== "object") throw loaderFailure("loader_contract_invalid", { field: "staged" });
  const stagedNames = new Set(staged.relations.map((entry) => sourceName(entry.relation)));
  if (stagedNames.size !== staged.relations.length || staged.relations.some((entry) => !ALL_SOURCE_RELATIONS.includes(sourceName(entry.relation) as AllSourceRelation))) {
    throw loaderFailure("loader_source_coverage", { field: "unexpected_or_duplicate_relation" });
  }
  for (const relation of ALL_SOURCE_RELATIONS) if (!stagedNames.has(relation)) throw loaderFailure("loader_source_coverage", { relation });
  const rows = Object.fromEntries(ALL_SOURCE_RELATIONS.map((relation) => [relation, sourceRunRows(cellRows(staged, relation))])) as Record<AllSourceRelation, readonly object[]>;

  // Identity is first and complete; all dependent transforms consume this map.
  const identity = transformIdentityBatch({ runIdentity, appAccounts: rows.app_accounts as never, appUsers: rows.app_users as never, manualSteamProfiles: rows.manual_steam_profiles as never, accountMerges: rows.account_merges as never, mergeTombstones: evidence.mergeTombstones as never });
  const accountMap = accountMapFromIdentityResult(identity, evidence.observedAt);

  // The AppID union is built once from every staged relation that exposes a
  // reviewed AppID spelling. Missing catalogue identities remain an explicit
  // game-map/stub decision; no title or provenance is invented here.
  const references: object[] = [];
  for (const relation of ALL_SOURCE_RELATIONS) for (const row of rows[relation]) {
    const record = row as Record<string, string | null>;
    for (const field of ["steam_appid", "steam_app_id", "catalog_steam_appid"]) {
      if (record[field] !== undefined) references.push({ relation, field, steam_appid: record[field] });
    }
  }
  const gameBuild = buildGameMap({ runIdentity, catalogueGames: rows.catalog_games as never, references: references as never, stubs: evidence.gameStubs as never });
  const gameMap = gameBuild.map;

  const sessions = transformSessions({ run: { ...runIdentity, observedAt: evidence.observedAt }, accountMap, verified: rows.sessions as never, manual: rows.manual_profile_sessions as never, manualDisposition: "migrate-cookie" });
  const capabilities = transformCapabilities({ run: { ...runIdentity, observedAt: evidence.observedAt }, accountMap, accountRows: rows.app_accounts as never, profileRows: rows.app_users as never });
  const catalogue = transformCatalogue({ runIdentity, gameMap, rows: rows.catalog_games as never, sightings: rows.catalog_game_sightings as never, stubs: gameBuild.stubs, offerPolicy: evidence.catalogueOfferPolicy as never });
  const library = transformLibraryBatch({ runIdentity, accountMap: identity.account_map, gameMap, userGames: rows.user_games as never });
  const legacyState = transformLegacyGameState({ runIdentity, accountMap: identity.account_map, userGameState: rows.user_game_state as never, authoritativeFacts: library.authoritative_facts });
  const family = transformFamilyBatch({ runIdentity, accountMap: identity.account_map, familyMembers: rows.user_family_members as never, familyAccessCandidates: library.family_access_candidates });
  const history = transformHistoryBatch({ runIdentity, accountMap: identity.account_map, gameMap, libraryRowMap: library.library_row_map, playtimeSnapshots: rows.user_playtime_snapshots as never, completionEvents: rows.completion_events as never, purgeReviews: rows.purge_reviews as never });
  const collections = transformCollections({ runIdentity, accountMap: identity.account_map, libraryRowMap: library.library_row_map, collections: rows.collections as never, collectionGames: rows.collection_games as never });
  const commitments = transformCommitments({ runIdentity, accountMap: identity.account_map, libraryRowMap: library.library_row_map, pins: rows.user_game_pins as never, snoozes: rows.user_game_snoozes as never, vaultState: rows.user_vault_state as never });
  const draws = transformDraws({ runIdentity, accountMap: identity.account_map, gameMap, libraryRowMap: library.library_row_map, collectionMap: collections.collection_map, draws: rows.vault_draws as never, drawEvents: rows.vault_draw_events as never, vaultEvents: rows.vault_events as never });
  const reco = transformRecoConfigBatch({ runIdentity, accountMap: identity.account_map, gameMap, warmStart: evidence.warmStart as never, operatorConfig: evidence.operatorConfig as never, userGenrePreferences: rows.user_genre_preferences, genrePreferenceGlobals: rows.genre_preference_globals, gamePreferenceGlobals: rows.game_preference_globals, algorithmWeights: rows.algorithm_weights, appSettings: rows.app_settings });
  const support = transformSupportOpsBatch({ runIdentity, accountMap: identity.account_map, contactMessages: rows.contact_messages, feedbackSubmissions: rows.feedback_submissions });
  const operations = transformLegacyOperationsBatch({ runIdentity, accountMap: identity.account_map, workerRuns: rows.metadata_worker_runs, importJobs: rows.steam_import_jobs, rateLimits: rows.api_rate_limits, accountMerges: rows.account_merges, securityIntents: rows.manual_profile_security_intents, cutover: evidence.cutover as never, mergeTombstones: evidence.mergeTombstones as never });
  const durationEstimates = transformDurationEstimates({ runIdentity, gameMap, rows: rows.game_duration_estimates as never });
  const durationAliases = transformDurationAliases({ runIdentity, gameMap, rows: rows.game_duration_aliases as never });
  const durationReviews = transformDurationReviews({ runIdentity, gameMap, accountMap: identity.account_map, rows: rows.catalog_duration_reviews as never });
  const durationImports = transformDurationImportRuns({ runIdentity, rows: rows.catalog_duration_import_runs as never });
  const durationJobs = transformDurationJobArchive({ runIdentity, gameMap, rows: rows.game_duration_jobs as never });
  const quarantine = transformGameQuarantine({ runIdentity, gameMap, rows: rows.catalog_game_quarantine as never });
  const ingest = transformIngestQueueArchive({ runIdentity, gameMap, rows: rows.catalog_ingest_queue as never });
  const seedRuns = transformSeedRuns({ runIdentity, rows: rows.catalog_seed_runs as never });
  const guestPool = transformGuestCataloguePool({ runIdentity, gameMap, rows: rows.guest_catalogue_pool as never });

  const batches: LoadBatch[] = [];
  collectBatches(identity as never, { accounts: "app.accounts", steam_profiles: "app.steam_profiles", account_map: "migration.account_map" }, batches);
  collectBatches(sessions as never, { sessions: "app.sessions", maps: "migration.session_map" }, batches);
  collectBatches(capabilities as never, { capabilities: "app.account_capabilities", evidence: "app.account_capability_evidence" }, batches);
  collectBatches(catalogue as never, { games: "catalog.games", game_metadata: "catalog.game_metadata", game_features: "catalog.game_features", game_sightings: "catalog.game_sightings", offers: "catalog.offers", offer_prices: "catalog.offer_prices", review_decisions: "catalog.review_decisions", provider_state: "catalog.provider_state" }, batches);
  collectBatches(library as never, { library_games: "app.library_games", game_state: "app.game_state", game_activity: "app.game_activity", retired_library_games: "app.retired_library_games", library_row_map: "migration.library_row_map", library_legacy_measurements: "app.library_legacy_measurements", legacy_library_evidence: "migration.legacy_library_evidence" }, batches);
  collectBatches(legacyState as never, { legacy_user_game_state_audit: "migration.legacy_user_game_state_audit", game_state_legacy_measurements: "app.game_state_legacy_measurements" }, batches);
  collectBatches(family as never, { family_members: "app.family_members", legacy_family_member_evidence: "migration.legacy_family_member_evidence", family_game_access: "app.family_game_access", family_access_orphans: "app.family_access_orphans", legacy_family_access_orphans: "migration.legacy_family_access_orphans" }, batches);
  collectBatches(history as never, { playtime_daily: "app.playtime_daily", completion_events: "app.completion_events", unknown_completion_history: "app.unknown_completion_history", completion_event_registry: "app.completion_event_registry", purge_review_history: "app.purge_review_history", legacy_purge_review_archive: "migration.legacy_purge_review_archive" }, batches);
  collectBatches(collections as never, { collections: "app.collections", collection_map: "migration.collection_map", collection_games: "app.collection_games", membership_evidence: "migration.legacy_collection_membership_evidence" }, batches);
  collectBatches(commitments as never, { pins: "app.pins", snoozes: "app.snoozes", vault_state: "app.vault_state" }, batches);
  collectBatches(draws as never, { draws: "app.vault_draws", draw_events: "app.vault_draw_events", vault_events: "app.vault_events" }, batches);
  collectBatches(reco as never, { user_genre_preferences: "reco.user_genre_preferences", genre_preference_globals: "reco.genre_preference_globals", game_preference_globals: "reco.game_preference_globals", operator_weight_versions: "reco.operator_weight_versions", account_preferences: "app.account_preferences", legacy_account_preferences_evidence: "migration.legacy_account_preferences_evidence" }, batches);
  batches.push(batch("reco.warm_start_snapshots", [reco.warm_start_snapshot]));
  collectBatches(support as never, { retention_policy_decisions: "support.retention_policy_decisions", contact_messages: "support.contact_messages", feedback_submissions: "support.feedback_submissions" }, batches);
  collectBatches(operations as never, { legacy_worker_runs: "ops.legacy_worker_runs", import_freeze_report: "migration.legacy_import_freeze_report", abuse_cooldowns: "ops.abuse_cooldowns", account_merges: "ops.account_merges", account_aliases: "ops.account_aliases", legacy_account_merge_audit: "migration.legacy_account_merge_audit", legacy_auth_intent_audit: "migration.legacy_auth_intent_audit" }, batches);
  collectBatches(durationEstimates as never, { duration_estimates: "catalog.duration_estimates" }, batches);
  collectBatches(durationAliases as never, { duration_aliases: "catalog.duration_aliases" }, batches);
  collectBatches(durationReviews as never, { review_decisions: "catalog.review_decisions" }, batches);
  collectBatches(durationImports as never, { duration_imports: "catalog.duration_imports" }, batches);
  collectBatches(durationJobs as never, { archive: "migration.legacy_duration_job_archive", provider_state: "catalog.provider_state", terminal_rejections: "catalog.appid_terminal_rejections" }, batches);
  collectBatches(quarantine as never, { review_decisions: "catalog.review_decisions" }, batches);
  collectBatches(ingest as never, { archive: "migration.legacy_ingest_queue_archive", provider_state: "catalog.provider_state", terminal_rejections: "catalog.appid_terminal_rejections" }, batches);
  collectBatches(seedRuns as never, { seed_runs: "catalog.seed_runs" }, batches);

  const exceptionCounts = aggregateDomainGateCounts({
    recencyExceptions: library.recency_exceptions.length,
    completionOrderingExceptions: history.completion_ordering_exceptions.length,
    drawUnresolvedReferences: draws.unresolved_references.length,
    supportWithheld: support.withheld.length,
    recoWithheldCounters: reco.withheld_counters.length,
    recoWithheldSettings: reco.withheld_settings.length,
  });
  const blockers = [...reco.blockers, ...support.blockers, ...operations.blockers];
  const conflicts = [...library.conflicts, ...legacyState.conflicts, ...family.conflicts, ...history.conflicts, ...collections.conflicts, ...commitments.conflicts, ...draws.conflicts];
  const unresolvedConflicts = conflicts.reduce(
    (total, conflict) => total + (conflict.details.status === "unresolved" ? conflict.conflict_count : 0),
    0,
  );
  const merged = mergeBatches(batches);
  const additions = merged.map((entry) => entry.relation).filter((relation) => !(evidence.targetRelations ?? []).includes(relation)).map((relation) => Object.freeze({ relation, reason: "transform emits target-shaped rows but the supplied target contract has no relation spec" }));
  const withheldSupport = new Map<string, number>();
  for (const row of support.withheld) withheldSupport.set(row.source_relation, (withheldSupport.get(row.source_relation) ?? 0) + 1);
  const rebuildRelations = new Set<AllSourceRelation>(["catalog_duration_review_queue", "guest_catalogue_pool", "user_games_with_catalog"]);
  const archiveRelations = new Set<AllSourceRelation>(["catalog_ingest_queue", "game_duration_jobs"]);
  const conflictByRelation = new Map<string, number>();
  for (const conflict of conflicts) {
    if (conflict.details.status !== "unresolved") continue;
    conflictByRelation.set(conflict.source_relation, (conflictByRelation.get(conflict.source_relation) ?? 0) + conflict.conflict_count);
  }
  const accounting = ALL_SOURCE_RELATIONS.map((relation) => {
    const stagedRelation = staged.relations.find((entry) => sourceName(entry.relation) === relation);
    if (!stagedRelation) throw loaderFailure("loader_source_coverage", { relation });
    const sourceRows = stagedRelation.rowCount;
    const disposition = rebuildRelations.has(relation) ? "rebuild" as const : "transform" as const;
    const withheld =
      (withheldSupport.get(relation) ?? 0) +
      (relation === "app_settings" ? reco.withheld_settings.length : 0) +
      ((relation === "user_genre_preferences" || relation === "genre_preference_globals" || relation === "game_preference_globals" || relation === "algorithm_weights")
        ? reco.withheld_counters.filter((row) => row.source_relation === relation).length
        : 0);
    return Object.freeze({
      relation: stagedRelation.relation,
      sourceRows,
      loadedRows: disposition === "transform" && !archiveRelations.has(relation) ? sourceRows - withheld : 0,
      archivedRows: archiveRelations.has(relation) ? sourceRows : 0,
      conflictRows: (conflictByRelation.get(relation) ?? 0) + withheld,
      disposition,
    });
  });
  void guestPool;
  return Object.freeze({ batches: merged, exceptionCounts, unresolvedConflicts, blockers: blockers.length, sourceAccounting: Object.freeze(accounting), targetContractAdditions: Object.freeze(additions), gameMap, accountMap });
}
