import { ExportError } from "../shared/redaction.ts";
import { readFile } from "node:fs/promises";
import { quoteLiteral, type WireConnection } from "./wire.ts";
import type {
  ExpectedConstraint,
  ExpectedRelation,
  ExportPlan,
  PlannedColumn,
  PlannedRelation,
} from "./snapshot.ts";

/**
 * An export plan is the list of relations to stream, in a fixed order, with the
 * exact columns each is expected to have.
 *
 * It is an input, not something the exporter discovers. Discovering the schema
 * at export time would make schema drift invisible: a column added since the
 * disposition manifest was written would simply appear in the output, and the
 * loader would meet a column nobody has dispositioned.
 */

const INVENTORY_RELATION_KINDS = new Set(["r", "v", "m", "p"]);

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ExportError("plan_invalid", `${where} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function inventoryName(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ExportError("plan_invalid", `${where} must be a non-empty string.`);
  }
  // The SQL builder quotes names again, but rejecting here makes a malformed
  // inventory fail before it can become an ambiguous plan or error message.
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value) || value.length > 63) {
    throw new ExportError("plan_invalid", `${where} is not a valid PostgreSQL identifier.`);
  }
  return value;
}

/**
 * Build a plan from the captured schema inventory
 * (`database/v2/source-schema-inventory-20260909.json`).
 *
 * That file is owned by the schema and manifest work; this reads it and never
 * writes it. `expectedProjectRef` is required so a plan captured from one
 * project cannot be used against another.
 */
export function loadExportPlanFromInventory(
  document: unknown,
  options: { schema: string; expectedProjectRef: string; include?: readonly string[] },
): ExportPlan {
  const root = record(document, "Schema inventory");
  if (root.source_project_ref !== options.expectedProjectRef) {
    throw new ExportError(
      "plan_project_mismatch",
      "The schema inventory was captured from a different project than the one being exported.",
      { expected: options.expectedProjectRef, actual: String(root.source_project_ref ?? "missing") },
    );
  }
  const tables = root.public_tables;
  if (!Array.isArray(tables) || tables.length === 0) {
    throw new ExportError("plan_invalid", "Schema inventory lists no relations.");
  }

  const schema = inventoryName(options.schema, "Export schema");
  if (Array.isArray(root.schemas) && !root.schemas.includes(schema)) {
    throw new ExportError(
      "plan_schema_missing",
      `Schema inventory does not list the requested schema ${JSON.stringify(schema)}.`,
      { schema },
    );
  }

  const includeValues = options.include ? [...options.include] : null;
  if (includeValues?.some((name) => typeof name !== "string" || name.length === 0)) {
    throw new ExportError("plan_invalid", "Requested relation names must be non-empty strings.");
  }
  const include = includeValues ? new Set(includeValues.map((name) => inventoryName(name, "Requested relation"))) : null;
  if (include && include.size !== includeValues?.length) {
    throw new ExportError("plan_invalid", "A requested relation appears more than once.");
  }

  const relations: PlannedRelation[] = [];
  const expected: ExpectedRelation[] = [];
  const relationNames = new Set<string>();
  for (const rawEntry of tables) {
    const entry = record(rawEntry, "Schema inventory relation");
    const relationName = inventoryName(entry.name, "Schema inventory relation name");
    if (typeof entry.kind !== "string" || !INVENTORY_RELATION_KINDS.has(entry.kind)) {
      throw new ExportError("plan_invalid", "Schema inventory has a malformed relation entry.");
    }
    if (typeof entry.rls !== "boolean") {
      throw new ExportError(
        "plan_invalid",
        `Schema inventory relation ${relationName} does not record row-level security.`,
        { relation: relationName },
      );
    }
    if (!Array.isArray(entry.columns) || entry.columns.length === 0) {
      throw new ExportError(
        "plan_invalid",
        `Schema inventory relation ${relationName} has no columns.`,
        { relation: relationName },
      );
    }
    if (relationNames.has(relationName)) {
      throw new ExportError("plan_invalid", `Schema inventory repeats relation ${relationName}.`);
    }
    relationNames.add(relationName);

    const columns: Array<PlannedColumn & { nullable: boolean }> = [];
    const columnNames = new Set<string>();
    for (let index = 0; index < entry.columns.length; index += 1) {
      const column = record(entry.columns[index], `Schema inventory column on ${relationName}`);
      const ordinal = column.ordinal;
      const name = inventoryName(column.name, `Schema inventory column name on ${relationName}`);
      const type = column.type;
      if (
        typeof ordinal !== "number" ||
        !Number.isSafeInteger(ordinal) ||
        (index > 0 && ordinal <= columns[index - 1].ordinal) ||
        typeof type !== "string" ||
        type.length === 0
      ) {
        throw new ExportError(
          "plan_invalid",
          `Schema inventory has an invalid ordinal or type for ${relationName}.${name}.`,
          { relation: relationName, column: name },
        );
      }
      // Nullability is part of the contract the loader is written against, so a
      // relation that does not record it cannot produce a contract that means
      // anything. It is required, not defaulted.
      if (typeof column.nullable !== "boolean") {
        throw new ExportError(
          "plan_invalid",
          `Schema inventory does not record nullability for ${relationName}.${name}.`,
          { relation: relationName, column: name },
        );
      }
      if (columnNames.has(name)) {
        throw new ExportError("plan_invalid", `Schema inventory repeats column ${relationName}.${name}.`);
      }
      columnNames.add(name);
      columns.push({ ordinal, name, type, nullable: column.nullable });
    }

    expected.push({
      schema,
      name: relationName,
      kind: entry.kind,
      rls: entry.rls,
      columns,
      constraints: inventoryConstraints(entry.constraints, relationName, entry.kind),
    });

    if (include && !include.has(relationName)) continue;
    relations.push({ schema, name: relationName, kind: entry.kind, columns });
  }

  if (include) {
    for (const name of includeValues ?? []) {
      if (!relationNames.has(name)) {
        throw new ExportError("plan_relation_missing", `Requested relation ${name} is not in the inventory.`);
      }
    }
  }

  // A fixed, content-independent order. The manifest, the digests and the load
  // sequence all reference it.
  relations.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  expected.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // The contract always covers every inventoried relation, including the ones
  // `include` left out of the output. Narrowing what is exported must not
  // narrow what has to still match the schema the manifest was written against.
  return { relations, schemaContract: { schema, relations: expected } };
}

/**
 * Constraints exactly as the inventory captured them.
 *
 * They are compared against `pg_get_constraintdef(oid, true)` at export time, so
 * they are ordered here the way the catalog query orders them - by constraint
 * name within the relation - rather than in the order the capture happened to
 * write them.
 */
function inventoryConstraints(value: unknown, relationName: string, kind: string): ExpectedConstraint[] {
  // The capture records `null` for a view or materialized view, which cannot
  // carry a table constraint. That is the inventory's representation and this
  // reader follows it rather than inventing a second one; a base or partitioned
  // table must still carry an array, even an empty one.
  if (value === null || value === undefined) {
    if (kind === "v" || kind === "m") return [];
    throw new ExportError(
      "plan_invalid",
      `Schema inventory relation ${relationName} does not record its constraints.`,
      { relation: relationName, kind },
    );
  }
  if (!Array.isArray(value)) {
    throw new ExportError(
      "plan_invalid",
      `Schema inventory relation ${relationName} does not record its constraints.`,
      { relation: relationName, kind },
    );
  }
  const constraints: ExpectedConstraint[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const entry = record(raw, `Schema inventory constraint on ${relationName}`);
    const name = entry.name;
    const type = entry.type;
    const definition = entry.definition;
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      typeof type !== "string" ||
      type.length !== 1 ||
      typeof definition !== "string" ||
      definition.length === 0
    ) {
      throw new ExportError(
        "plan_invalid",
        `Schema inventory has a malformed constraint on ${relationName}.`,
        { relation: relationName },
      );
    }
    if (seen.has(name)) {
      throw new ExportError(
        "plan_invalid",
        `Schema inventory repeats constraint ${name} on ${relationName}.`,
        { relation: relationName, constraint: name },
      );
    }
    seen.add(name);
    constraints.push({ name, type, definition });
  }
  constraints.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return constraints;
}

/** Read and validate the metadata-only inventory used by a real export plan. */
export async function loadExportPlanFromInventoryFile(
  path: string,
  options: { schema: string; expectedProjectRef: string; include?: readonly string[] },
): Promise<ExportPlan> {
  let text: string;
  try {
    text = await readFile(path, { encoding: "utf8" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    throw new ExportError("plan_inventory_unreadable", `Cannot read the schema inventory (${code}).`, {
      errno: code,
    });
  }
  try {
    return loadExportPlanFromInventory(JSON.parse(text), options);
  } catch (error) {
    if (error instanceof ExportError) throw error;
    throw new ExportError("plan_inventory_unparseable", "Schema inventory is not valid JSON.");
  }
}

/**
 * Build a plan by reading the live catalog.
 *
 * This is for a synthetic fixture, where the fixture *is* the schema of record.
 * It is deliberately not what a production export uses, for the reason in the
 * comment at the top of this file.
 */
export async function describePlanFromServer(
  connection: WireConnection,
  options: { schema: string; relations: readonly string[] },
): Promise<ExportPlan> {
  const relations: PlannedRelation[] = [];
  for (const name of [...options.relations].sort()) {
    const result = await connection.query(
      "SELECT a.attnum::text, a.attname, format_type(a.atttypid, a.atttypmod), c.relkind " +
        "FROM pg_catalog.pg_attribute a " +
        "JOIN pg_catalog.pg_class c ON c.oid = a.attrelid " +
        "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
        `WHERE n.nspname = ${quoteLiteral(options.schema)} AND c.relname = ${quoteLiteral(name)} ` +
        "AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum",
    );
    if (result.rows.length === 0) {
      throw new ExportError("plan_relation_missing", `Relation ${options.schema}.${name} does not exist.`);
    }
    relations.push({
      schema: options.schema,
      name,
      kind: result.rows[0][3] ?? "",
      columns: result.rows.map((row) => ({
        ordinal: Number.parseInt(row[0] ?? "0", 10),
        name: row[1] ?? "",
        type: row[2] ?? "",
      })),
    });
  }
  return { relations };
}
