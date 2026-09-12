import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExportError } from "../shared/redaction.ts";
import { loadExportPlanFromInventory, loadExportPlanFromInventoryFile } from "./plan.ts";

const INVENTORY = "database/v2/source-schema-inventory-20260909.json";
const PROJECT_REF = "pfvblcopcmairdfeqdep";

test("the captured source inventory builds a complete deterministic public plan", async () => {
  const plan = await loadExportPlanFromInventoryFile(INVENTORY, {
    schema: "public",
    expectedProjectRef: PROJECT_REF,
  });

  assert.equal(plan.relations.length, 44);
  assert.equal(plan.relations.reduce((count, relation) => count + relation.columns.length, 0), 486);
  assert.equal(plan.schemaContract?.relations.length, 44);
  assert.equal(
    plan.schemaContract?.relations.reduce((count, relation) => count + relation.columns.length, 0),
    486,
  );
  assert.deepEqual(
    plan.relations.map((relation) => relation.name),
    [...plan.relations].map((relation) => relation.name).sort(),
  );
  for (const relation of plan.relations) {
    assert.equal(relation.schema, "public");
    assert.ok(["r", "v", "m", "p"].includes(relation.kind));
    assert.deepEqual(
      relation.columns.map((column) => column.ordinal),
      [...relation.columns.map((column) => column.ordinal)].sort((a, b) => a - b),
    );
  }
});

test("the inventory plan can be explicitly narrowed without discovering schema", async () => {
  const plan = await loadExportPlanFromInventoryFile(INVENTORY, {
    schema: "public",
    expectedProjectRef: PROJECT_REF,
    include: ["user_games", "catalog_games"],
  });
  assert.deepEqual(
    plan.relations.map((relation) => relation.name),
    ["catalog_games", "user_games"],
  );
  // Narrowing controls files, not the schema drift boundary. Excluded
  // relations remain in the contract validated inside the snapshot.
  assert.equal(plan.schemaContract?.relations.length, 44);
  assert.equal(
    plan.schemaContract?.relations.reduce((count, relation) => count + relation.columns.length, 0),
    486,
  );
});

test("inventory identity and structural drift fail closed", async (t) => {
  await t.test("project mismatch", async () => {
    await assert.rejects(
      () =>
        loadExportPlanFromInventoryFile(INVENTORY, {
          schema: "public",
          expectedProjectRef: "some-other-project",
        }),
      (error: unknown) => error instanceof ExportError && error.code === "plan_project_mismatch",
    );
  });

  await t.test("duplicate relation and duplicate columns", () => {
    const base = {
      source_project_ref: PROJECT_REF,
      schemas: ["public"],
      public_tables: [
        {
          name: "one",
          kind: "r",
          columns: [
            { ordinal: 1, name: "id", type: "bigint" },
            { ordinal: 1, name: "title", type: "text" },
          ],
        },
      ],
    };
    assert.throws(
      () => loadExportPlanFromInventory(base, { schema: "public", expectedProjectRef: PROJECT_REF }),
      (error: unknown) => error instanceof ExportError && error.code === "plan_invalid",
    );
    assert.throws(
      () =>
        loadExportPlanFromInventory(
          {
            ...base,
            public_tables: [...base.public_tables, base.public_tables[0]],
          },
          { schema: "public", expectedProjectRef: PROJECT_REF },
        ),
      (error: unknown) => error instanceof ExportError && error.code === "plan_invalid",
    );
  });

  await t.test("malformed JSON file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vs-plan-"));
    try {
      const path = join(directory, "inventory.json");
      await writeFile(path, "{not json", { mode: 0o644 });
      await assert.rejects(
        () => loadExportPlanFromInventoryFile(path, { schema: "public", expectedProjectRef: PROJECT_REF }),
        (error: unknown) => error instanceof ExportError && error.code === "plan_inventory_unparseable",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
