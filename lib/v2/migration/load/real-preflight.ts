import { createHash } from "node:crypto";
import { chmod, lstat, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_SOURCE_RELATIONS, ALL_TARGET_RELATIONS, assembleAllDomains } from "./all-domains.ts";
import { OrderedChecksum } from "./canonical.ts";
import { stageVerifiedRun } from "./staging.ts";
import { inspectRun, type ReaderExpectations } from "../read/reader.ts";
import { parsePgTimestamptz, timestampFromEpochMicros } from "../transform/scalars.ts";
import { createPrivateDirectory, readPrivateFile, writePrivateFile } from "../shared/private-fs.ts";
import { describeFailure, ExportError } from "../shared/redaction.ts";

const PROJECT_REF = "pfvblcopcmairdfeqdep";
const DATABASE = "postgres";
const INVENTORY_PATH = "database/v2/source-schema-inventory-20260909.json";
const REPORT_NAME = "real-preflight-report.json";
const THIRTY_DAYS_MICROS = BigInt(30) * BigInt(86_400) * BigInt(1_000_000);

type SourceRecord = Readonly<Record<string, string | null>>;
type Inventory = Readonly<{
  source_project_ref: string;
  database: string;
  public_tables: readonly Readonly<{ name: string; columns: readonly Readonly<{ name: string; ordinal: number }>[] }>[];
}>;

export type RealPreflightOptions = Readonly<{
  runDirectory: string;
  workDirectory: string;
  viewSidecarPath: string;
  inventoryPath?: string;
  expectedProjectRef?: string;
  expectedDatabase?: string;
}>;

export type RealPreflightReport = Readonly<Record<string, unknown>>;

export function fingerprintTransformBatches(
  batches: readonly Readonly<{ relation: string; rows: readonly unknown[] }>[],
): string {
  const checksum = new OrderedChecksum();
  for (const batch of batches) {
    checksum.update({ relation: batch.relation, rows: batch.rows.length });
    for (const row of batch.rows) checksum.update(row);
  }
  return checksum.finish().sha256;
}

function error(code: string, message: string): ExportError {
  return new ExportError(code, message);
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseJson(text: string, code: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    const record = object(parsed);
    if (!record) throw new Error("shape");
    return record;
  } catch {
    throw error(code, "A preflight input is not a valid JSON object.");
  }
}

function readInventory(value: unknown, expectedProjectRef: string, expectedDatabase: string): Inventory {
  const root = object(value);
  if (!root || root.source_project_ref !== expectedProjectRef || root.database !== expectedDatabase || !Array.isArray(root.public_tables)) {
    throw error("preflight_inventory_invalid", "The source inventory identity is not the approved real source.");
  }
  const tables = root.public_tables as unknown[];
  if (tables.length !== 44) throw error("preflight_inventory_invalid", "The source inventory must contain 44 public relations.");
  let columns = 0;
  const names = new Set<string>();
  for (const raw of tables) {
    const table = object(raw);
    if (!table || typeof table.name !== "string" || !Array.isArray(table.columns) || names.has(table.name)) {
      throw error("preflight_inventory_invalid", "The source inventory relation set is invalid.");
    }
    names.add(table.name);
    columns += table.columns.length;
  }
  if (columns !== 486 || ALL_SOURCE_RELATIONS.some((name) => !names.has(name))) {
    throw error("preflight_inventory_invalid", "The source inventory must match the frozen 44-relation, 486-column contract.");
  }
  return root as Inventory;
}

function expectations(inventory: Inventory, user: string, projectRef: string, database: string): ReaderExpectations {
  return Object.freeze({
    source: Object.freeze({ kind: "real-source" as const, projectRef, database, user }),
    relations: Object.freeze(inventory.public_tables.map((table) => Object.freeze({
      schema: "public",
      name: table.name,
      columns: Object.freeze([...table.columns].sort((a, b) => a.ordinal - b.ordinal).map((column) => column.name)),
    }))),
  });
}

function records(columns: readonly string[], rows: readonly (readonly (string | null)[])[]): readonly SourceRecord[] {
  return rows.map((row) => Object.freeze(Object.fromEntries(columns.map((column, index) => [column, row[index] ?? null]))));
}

function bucket(accessSource: string | null): "owned" | "family" | "null" | "other" {
  return accessSource === "owned" || accessSource === "family" ? accessSource : accessSource === null ? "null" : "other";
}

export function computeP05Diagnostics(userGames: readonly SourceRecord[], pins: readonly SourceRecord[], completions: readonly SourceRecord[]) {
  const byAccess = new Map<string, Record<string, number | string>>();
  for (const name of ["family", "null", "other", "owned"]) {
    byAccess.set(name, { access_source: name, rows_total: 0, minutes_null: 0, minutes_present: 0,
      hours_not_reproducible_by_legacy_js: 0, hours_without_minutes: 0, zero_hours_unknown_minutes: 0,
      observed_zero_minutes: 0, boundary_minute_rows: 0, max_integer_minute_rows: 0, exact_minutes_sum: "0",
      legacy_js_rounded_hours_tenths_sum: "0" });
  }
  for (const row of userGames) {
    const target = byAccess.get(bucket(row.access_source))!;
    target.rows_total = Number(target.rows_total) + 1;
    const minutesText = row.observed_playtime_minutes;
    const hours = Number(row.hours_played);
    if (minutesText === null) {
      target.minutes_null = Number(target.minutes_null) + 1;
      if (hours > 0) target.hours_without_minutes = Number(target.hours_without_minutes) + 1;
      if (hours === 0) target.zero_hours_unknown_minutes = Number(target.zero_hours_unknown_minutes) + 1;
      continue;
    }
    const minutes = Number(minutesText);
    target.minutes_present = Number(target.minutes_present) + 1;
    target.exact_minutes_sum = (BigInt(String(target.exact_minutes_sum)) + BigInt(minutesText)).toString();
    const legacyRoundedTenths = Math.round(((minutes ?? 0) / 60) * 10);
    target.legacy_js_rounded_hours_tenths_sum =
      (BigInt(String(target.legacy_js_rounded_hours_tenths_sum)) + BigInt(legacyRoundedTenths)).toString();
    const legacyRoundedHours = legacyRoundedTenths / 10;
    if (hours !== legacyRoundedHours) target.hours_not_reproducible_by_legacy_js = Number(target.hours_not_reproducible_by_legacy_js) + 1;
    if (minutes === 0) target.observed_zero_minutes = Number(target.observed_zero_minutes) + 1;
    if ([0, 1, 3, 6, 59, 60, 61].includes(minutes)) target.boundary_minute_rows = Number(target.boundary_minute_rows) + 1;
    if (minutes >= 2_147_483_647) target.max_integer_minute_rows = Number(target.max_integer_minute_rows) + 1;
  }
  const pin = { rows: pins.length, baseline_null: 0, non_finite: 0, negative: 0, conversion_loses_precision: 0 };
  for (const row of pins) {
    if (row.hours_at_pin === null) pin.baseline_null += 1;
    else if (["NaN", "Infinity", "-Infinity"].includes(row.hours_at_pin)) pin.non_finite += 1;
    else {
      const value = Number(row.hours_at_pin);
      if (value < 0) pin.negative += 1;
      if (value * 60 !== Math.round(value * 60)) pin.conversion_loses_precision += 1;
    }
  }
  const completion = { rows: completions.length, hours_null: 0, estimate_minutes_null: 0, price_cents_null: 0, hours_not_whole_minutes: 0, non_finite_hours: 0 };
  for (const row of completions) {
    if (row.hours_played === null) completion.hours_null += 1;
    else if (["NaN", "Infinity", "-Infinity"].includes(row.hours_played)) completion.non_finite_hours += 1;
    else if (Number(row.hours_played) * 60 !== Math.round(Number(row.hours_played) * 60)) completion.hours_not_whole_minutes += 1;
    if (row.estimate_minutes === null) completion.estimate_minutes_null += 1;
    if (row.price_cents === null) completion.price_cents_null += 1;
  }
  return Object.freeze({ user_games_by_access_source: Object.freeze([...byAccess.values()].filter((entry) => entry.rows_total !== 0)), pins: Object.freeze(pin), completion_events: Object.freeze(completion) });
}

export function computePurgeCompletionDiagnostics(purge: readonly SourceRecord[], completions: readonly SourceRecord[], userGames: readonly SourceRecord[]) {
  const active = new Set(completions.filter((row) => row.undone_at === null).map((row) => `${row.user_id}\0${row.game_id}`));
  const any = new Set(completions.map((row) => `${row.user_id}\0${row.game_id}`));
  const library = new Set(userGames.map((row) => row.id));
  const libraryStatus = new Map(userGames.map((row) => [row.id, row.status]));
  const result = new Map<string, { action: string; review_rows: number; reviews_whose_library_row_is_gone: number; completions_with_no_matching_event: number }>();
  const accounts = new Map<string, Set<string | null>>();
  for (const row of purge) {
    const action = row.action === "keep" || row.action === "pin" || row.action === "sleep" || row.action === "complete" ? row.action : row.action === null ? "null" : "other";
    const entry = result.get(action) ?? { action, review_rows: 0, reviews_whose_library_row_is_gone: 0, completions_with_no_matching_event: 0 };
    entry.review_rows += 1;
    if (!library.has(row.game_id)) entry.reviews_whose_library_row_is_gone += 1;
    if (action === "complete" && !active.has(`${row.user_id}\0${row.game_id}`)) entry.completions_with_no_matching_event += 1;
    result.set(action, entry);
    const actionAccounts = accounts.get(action) ?? new Set<string | null>();
    actionAccounts.add(row.user_id);
    accounts.set(action, actionAccounts);
  }
  const missingActive = purge.filter((row) => row.action === "complete" && !active.has(`${row.user_id}\0${row.game_id}`));
  const missingActiveDetail = {
    reviews: missingActive.length,
    with_any_matching_event: missingActive.filter((row) => any.has(`${row.user_id}\0${row.game_id}`)).length,
    with_undone_only_events: missingActive.filter((row) => any.has(`${row.user_id}\0${row.game_id}`) && !active.has(`${row.user_id}\0${row.game_id}`)).length,
    with_no_event_ever: missingActive.filter((row) => !any.has(`${row.user_id}\0${row.game_id}`)).length,
    current_library_status: Object.freeze({
      completed: missingActive.filter((row) => libraryStatus.get(row.game_id) === "Completed").length,
      other: missingActive.filter((row) => libraryStatus.has(row.game_id) && libraryStatus.get(row.game_id) !== "Completed").length,
      missing: missingActive.filter((row) => !libraryStatus.has(row.game_id)).length,
    }),
  };
  return Object.freeze({
    by_action: Object.freeze([...result.values()].map((entry) => Object.freeze({ ...entry, accounts: accounts.get(entry.action)?.size ?? 0 })).sort((a, b) => a.action.localeCompare(b.action))),
    complete_without_active_event: Object.freeze(missingActiveDetail),
  });
}

export function computeOperationalDiagnostics(rows: Readonly<Record<string, readonly SourceRecord[]>>) {
  const imports = rows.steam_import_jobs ?? [];
  const rateLimits = rows.api_rate_limits ?? [];
  return Object.freeze({
    imports: Object.freeze({ rows: imports.length, in_flight: imports.filter((row) => row.status === "importing").length }),
    cooldowns: Object.freeze({ rows: rateLimits.length, unexpired: null, reason: "source window duration varies by caller and is absent from the snapshot" }),
  });
}

export function computeCatalogueSightingDiagnostics(catalogue: readonly SourceRecord[], sightings: readonly SourceRecord[]) {
  const dedicated = new Map(sightings.map((row) => [row.steam_appid, row]));
  const catalogueIds = new Set(catalogue.map((row) => row.steam_appid));
  const counts = { catalogue_rows: catalogue.length, dedicated_rows: sightings.length, overlaps: 0, catalogue_only: 0,
    dedicated_only: 0, conflicting_overlaps: 0, import_count_mismatches: 0, first_seen_mismatches: 0, last_seen_mismatches: 0 };
  for (const row of catalogue) {
    const other = dedicated.get(row.steam_appid);
    if (!other) { counts.catalogue_only += 1; continue; }
    counts.overlaps += 1;
    const importMismatch = row.import_sighting_count !== other.import_count;
    const first = parsePgTimestamptz(row.first_seen_at, { field: "catalogue_sighting.first_seen_at" });
    const otherFirst = parsePgTimestamptz(other.first_seen_at, { field: "catalogue_sighting.first_seen_at" });
    const last = parsePgTimestamptz(row.last_seen_at, { field: "catalogue_sighting.last_seen_at" });
    const otherLast = parsePgTimestamptz(other.last_seen_at, { field: "catalogue_sighting.last_seen_at" });
    const firstMismatch = first?.epochMicros !== otherFirst?.epochMicros;
    const lastMismatch = last?.epochMicros !== otherLast?.epochMicros;
    if (importMismatch) counts.import_count_mismatches += 1;
    if (firstMismatch) counts.first_seen_mismatches += 1;
    if (lastMismatch) counts.last_seen_mismatches += 1;
    if (importMismatch || firstMismatch || lastMismatch) counts.conflicting_overlaps += 1;
  }
  counts.dedicated_only = sightings.filter((row) => !catalogueIds.has(row.steam_appid)).length;
  return Object.freeze(counts);
}

async function assertNewPrivateWorkDirectory(path: string): Promise<void> {
  if (!isAbsolute(path)) throw error("preflight_path_invalid", "The preflight work directory must be absolute.");
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) {
    throw error("preflight_private_parent", "The preflight work directory parent must be an owner-only directory.");
  }
  await createPrivateDirectory(path);
}

async function manifestIdentity(runDirectory: string): Promise<{ user: string; sha256: string }> {
  const manifestText = await readPrivateFile(join(runDirectory, "manifest.json"), "completed export manifest");
  const digestText = await readPrivateFile(join(runDirectory, "manifest.sha256"), "completed export manifest digest");
  const manifest = parseJson(manifestText, "preflight_manifest_invalid");
  const source = object(manifest.source);
  const match = /^([0-9a-f]{64})  manifest\.json\n?$/.exec(digestText);
  const actual = createHash("sha256").update(manifestText, "utf8").digest("hex");
  if (!source || typeof source.user !== "string" || !match || match[1] !== actual) {
    throw error("preflight_manifest_invalid", "The completed export manifest identity or digest is invalid.");
  }
  return { user: source.user, sha256: actual };
}

async function verifyViewSidecar(path: string, runId: string, observedAt: string, manifestSha256: string) {
  if (!isAbsolute(path) || basename(path).endsWith(".partial")) {
    throw error("preflight_view_sidecar_invalid", "The supplementary view sidecar path is invalid.");
  }
  const sidecar = parseJson(await readPrivateFile(path, "same-snapshot view sidecar"), "preflight_view_sidecar_invalid");
  const snapshot = object(sidecar.snapshot);
  const sidecarObservedAt = typeof sidecar.observed_at === "string" ? sidecar.observed_at : snapshot?.transaction_start_utc;
  if (sidecar.run_id !== runId || sidecar.manifest_sha256 !== manifestSha256 || sidecarObservedAt !== observedAt || !Array.isArray(sidecar.views)) {
    throw error("preflight_view_sidecar_mismatch", "The supplementary view sidecar is not bound to this completed snapshot.");
  }
  const names: string[] = [];
  for (const raw of sidecar.views) {
    const view = object(raw);
    if (!view || typeof view.schema !== "string" || typeof view.name !== "string" || typeof view.definition !== "string") {
      throw error("preflight_view_sidecar_invalid", "The supplementary view sidecar has an invalid view entry.");
    }
    names.push(`${view.schema}.${view.name}`);
  }
  if (!names.includes("public.user_games_with_catalog") || new Set(names).size !== names.length) {
    throw error("preflight_view_sidecar_invalid", "The supplementary view sidecar is missing the required public view definition.");
  }
  return Object.freeze({ verified: true, views: Object.freeze(names.sort()) });
}

export async function runRealSnapshotPreflight(options: RealPreflightOptions): Promise<{ reportPath: string; report: RealPreflightReport }> {
  if (basename(options.runDirectory).endsWith(".partial")) throw error("preflight_incomplete_refused", "A partial export cannot be preflighted.");
  const runDirectory = resolve(options.runDirectory);
  const workDirectory = resolve(options.workDirectory);
  const inventoryPath = resolve(options.inventoryPath ?? INVENTORY_PATH);
  const expectedProjectRef = options.expectedProjectRef ?? PROJECT_REF;
  const expectedDatabase = options.expectedDatabase ?? DATABASE;
  await assertNewPrivateWorkDirectory(workDirectory);
  const reportPath = join(workDirectory, REPORT_NAME);
  let staged: Awaited<ReturnType<typeof stageVerifiedRun>> | null = null;
  try {
    const inventory = readInventory(JSON.parse(await readFile(inventoryPath, "utf8")), expectedProjectRef, expectedDatabase);
    const identity = await manifestIdentity(runDirectory);
    const verified = await inspectRun(runDirectory, expectations(inventory, identity.user, expectedProjectRef, expectedDatabase));
    if (verified.manifest.totals.relations !== 44 || verified.manifest.relations.reduce((sum, relation) => sum + relation.columns.length, 0) !== 486) {
      throw error("preflight_manifest_coverage", "The completed export does not contain the frozen 44-relation, 486-column contract.");
    }
    staged = await stageVerifiedRun(
      verified,
      ALL_SOURCE_RELATIONS.map((name) => `public.${name}`),
      join(workDirectory, "stage"),
      { maxBytesPerRelation: 1024 * 1024 * 1024 },
    );
    const sourceRows: Record<string, readonly SourceRecord[]> = {};
    for (const relation of staged.relations) {
      const name = relation.relation.slice("public.".length);
      if (name === "user_games_with_catalog" || name === "catalog_duration_review_queue") continue;
      sourceRows[name] = records(relation.columns, relation.readRows());
    }

    const observedAt = verified.manifest.snapshot.transaction_start_utc;
    const viewSidecar = await verifyViewSidecar(options.viewSidecarPath, verified.manifest.run_id, observedAt, identity.sha256);
    const parsedObserved = parsePgTimestamptz(observedAt, { field: "preflight_observed_at" });
    if (!parsedObserved) throw error("preflight_manifest_invalid", "The snapshot watermark is absent.");
    const retentionUntil = timestampFromEpochMicros(parsedObserved.epochMicros + THIRTY_DAYS_MICROS, { field: "preflight_retention_until" }).canonicalUtc;
    const evidence = Object.freeze({
      observedAt,
      catalogueOfferPolicy: Object.freeze({ provider: "legacy_catalog_games", retentionUntil }),
      warmStart: Object.freeze({ snapshot_key: `legacy-import-${verified.manifest.run_id}`, snapshot_version: "1", frozen_at: observedAt,
        source_project_ref: expectedProjectRef, source_captured_at: observedAt, source_manifest_hash: identity.sha256 }),
      operatorConfig: Object.freeze({ config_version: `legacy-import-${verified.manifest.run_id}`, effective_at: observedAt }),
      cutover: Object.freeze({ observed_at: observedAt, algorithm_version: "legacy-fixed-window" }),
      targetRelations: ALL_TARGET_RELATIONS,
    });

    let transform: Record<string, unknown>;
    try {
      const outcome = assembleAllDomains(staged, { runId: verified.manifest.run_id, snapshotHash: identity.sha256 }, evidence);
      transform = {
        completed: true,
        target_batches: outcome.batches.map((entry) => Object.freeze({ relation: entry.relation, rows: entry.rows.length })),
        exception_counts: outcome.exceptionCounts,
        unresolved_conflicts: outcome.unresolvedConflicts,
        unresolved_conflict_summary: outcome.unresolvedConflictSummary,
        blockers: outcome.blockers,
        blocker_summary: outcome.blockerSummary,
        target_contract_additions: outcome.targetContractAdditions.map((entry) => entry.relation),
        source_accounting: outcome.sourceAccounting,
        transform_fingerprint: fingerprintTransformBatches(outcome.batches),
      };
    } catch (caught) {
      const failure = describeFailure(caught);
      const safeDetails = caught instanceof ExportError
        ? Object.fromEntries(Object.entries(caught.details).filter(([key]) => ["relation", "field", "count"].includes(key)))
        : {};
      transform = { completed: false, error_counts: { [failure.code]: 1 }, error_diagnostics: [Object.freeze({ code: failure.code, ...safeDetails })] };
    }

    const report = Object.freeze({
      report_version: 1,
      evidence_kind: "real-source-offline-preflight",
      target_writes: 0,
      publishable: false,
      observed_at: observedAt,
      reader: Object.freeze({ complete: true, relations_verified: verified.relations.length, columns_verified: 486,
        rows_verified: verified.manifest.totals.rows, file_hashes_verified: verified.relations.length }),
      source_coverage: staged.relations.map((relation) => Object.freeze({ relation: relation.relation, rows: relation.rowCount })),
      source_diagnostics: Object.freeze({
        p05: computeP05Diagnostics(sourceRows.user_games, sourceRows.user_game_pins, sourceRows.completion_events),
        purge_completion: computePurgeCompletionDiagnostics(sourceRows.purge_reviews, sourceRows.completion_events, sourceRows.user_games),
        operations: computeOperationalDiagnostics(sourceRows),
        catalogue_sightings: computeCatalogueSightingDiagnostics(sourceRows.catalog_games, sourceRows.catalog_game_sightings),
      }),
      supplementary_views: viewSidecar,
      rehearsal_evidence: Object.freeze({ warm_start: "coordinator-supplied run-linked version 1", operator_config: "coordinator-supplied run-linked import version",
        catalogue_offer: "legacy_catalog_games; snapshot plus 30 days", cooldown: "observation and legacy algorithm supplied; window duration absent" }),
      unresolved_policy_gaps: Object.freeze([
        "cooldown_window_duration",
        "family_access_measurement_destination",
        "final_freeze_import_population",
        "legacy_compatibility_settings_destination",
        "reco_total_hours_precision_migration_unapplied",
        "support_retention",
      ]),
      transform: Object.freeze(transform),
    });
    await writePrivateFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    await chmod(reportPath, 0o600);
    return { reportPath, report };
  } catch (caught) {
    const failure = describeFailure(caught);
    const report = Object.freeze({ report_version: 1, evidence_kind: "real-source-offline-preflight", target_writes: 0, publishable: false,
      reader: Object.freeze({ complete: false }), error_counts: Object.freeze({ [failure.code]: 1 }) });
    await writePrivateFile(reportPath, `${JSON.stringify(report, null, 2)}\n`).catch(() => {});
    throw caught;
  } finally {
    staged?.destroy();
  }
}

function parseArgs(args: readonly string[]): RealPreflightOptions {
  let runDirectory: string | undefined;
  let workDirectory: string | undefined;
  let viewSidecarPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag === "--run-directory" || flag === "--work-directory" || flag === "--view-sidecar") && value && !value.startsWith("--")) {
      if (flag === "--run-directory") runDirectory = value;
      else if (flag === "--work-directory") workDirectory = value;
      else viewSidecarPath = value;
      index += 1;
    } else throw error("preflight_argument_invalid", "Use --run-directory and --work-directory with absolute paths.");
  }
  if (!runDirectory || !workDirectory || !viewSidecarPath) throw error("preflight_argument_invalid", "--run-directory, --work-directory and --view-sidecar are required.");
  return { runDirectory, workDirectory, viewSidecarPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runRealSnapshotPreflight(parseArgs(process.argv.slice(2))).then(
    ({ report }) => process.stdout.write(`preflight=complete transform=${object(report.transform)?.completed === true ? "complete" : "blocked"} target_writes=0 report=private\n`),
    (caught) => { const failure = describeFailure(caught); process.stderr.write(`preflight=failed code=${failure.code}\n`); process.exitCode = 1; },
  );
}
