import assert from "node:assert/strict";
import test from "node:test";
import { ExportError } from "../shared/redaction.ts";
import {
  assertSchemaContract,
  type ExportSchemaContract,
} from "./snapshot.ts";
import type { QueryResult, WireConnection } from "./wire.ts";

const CONTRACT: ExportSchemaContract = {
  schema: "public",
  relations: [
    {
      schema: "public",
      name: "excluded_table",
      kind: "r",
      rls: true,
      columns: [
        { ordinal: 1, name: "id", type: "bigint", nullable: false },
        { ordinal: 2, name: "memo", type: "text", nullable: true },
      ],
      constraints: [
        { name: "excluded_table_pkey", type: "p", definition: "PRIMARY KEY (id)" },
      ],
    },
    {
      schema: "public",
      name: "selected_view",
      kind: "v",
      rls: false,
      columns: [{ ordinal: 1, name: "id", type: "bigint", nullable: false }],
      constraints: [],
    },
  ],
};

type CatalogState = {
  relations: ReadonlyArray<ReadonlyArray<string>>;
  columns: ReadonlyArray<ReadonlyArray<string>>;
  constraints: ReadonlyArray<ReadonlyArray<string>>;
};

function result(rows: ReadonlyArray<ReadonlyArray<string>>): QueryResult {
  return { fields: [], rows, commandTag: "SELECT" };
}

function connectionFor(state: CatalogState, queries: string[]): WireConnection {
  return {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("c.relname, c.relkind, c.relrowsecurity")) return result(state.relations);
      if (sql.includes("c.relname, a.attnum::text")) return result(state.columns);
      if (sql.includes("c.relname, con.conname")) return result(state.constraints);
      throw new Error(`unexpected catalog query: ${sql}`);
    },
  } as unknown as WireConnection;
}

function matchingCatalog(): CatalogState {
  return {
    // The first relation is deliberately named as an excluded relation. A
    // narrowed output plan still has to carry and validate it.
    relations: [
      ["excluded_table", "r", "true"],
      ["selected_view", "v", "false"],
    ],
    columns: [
      ["excluded_table", "1", "id", "bigint", "false"],
      ["excluded_table", "2", "memo", "text", "true"],
      ["selected_view", "1", "id", "bigint", "false"],
    ],
    constraints: [["excluded_table", "excluded_table_pkey", "p", "PRIMARY KEY (id)"]],
  };
}

test("complete schema contracts validate every relation, column and constraint", async () => {
  const queries: string[] = [];
  await assertSchemaContract(connectionFor(matchingCatalog(), queries), CONTRACT);
  assert.equal(queries.length, 3);
});

test("schema contract rejects relation scope and relation metadata drift", async (t) => {
  await t.test("added relation", async () => {
    const state = matchingCatalog();
    state.relations = [...state.relations, ["new_source_table", "r", "false"]];
    const queries: string[] = [];
    await assert.rejects(
      () => assertSchemaContract(connectionFor(state, queries), CONTRACT),
      (error: unknown) => error instanceof ExportError && error.code === "schema_relation_added",
    );
    assert.equal(queries.length, 1, "scope drift must fail before column reads");
  });

  await t.test("missing relation", async () => {
    const state = matchingCatalog();
    state.relations = [["selected_view", "v", "false"]];
    const queries: string[] = [];
    await assert.rejects(
      () => assertSchemaContract(connectionFor(state, queries), CONTRACT),
      (error: unknown) => error instanceof ExportError && error.code === "schema_relation_missing",
    );
    assert.equal(queries.length, 1, "scope drift must fail before column reads");
  });

  await t.test("kind or row security drift", async () => {
    const state = matchingCatalog();
    state.relations = [
      ["excluded_table", "v", "false"],
      ["selected_view", "v", "false"],
    ];
    const queries: string[] = [];
    await assert.rejects(
      () => assertSchemaContract(connectionFor(state, queries), CONTRACT),
      (error: unknown) => error instanceof ExportError && error.code === "schema_relation_drift",
    );
    assert.equal(queries.length, 1);
  });
});

test("schema contract rejects nullability and constraint drift", async (t) => {
  await t.test("nullability drift", async () => {
    const state = matchingCatalog();
    state.columns = state.columns.map((row) =>
      row[0] === "excluded_table" && row[2] === "memo" ? [...row.slice(0, 4), "false"] : row,
    );
    const queries: string[] = [];
    await assert.rejects(
      () => assertSchemaContract(connectionFor(state, queries), CONTRACT),
      (error: unknown) => error instanceof ExportError && error.code === "schema_column_drift",
    );
    assert.equal(queries.length, 2, "column drift must fail before constraint reads");
  });

  await t.test("constraint definition drift", async () => {
    const state = matchingCatalog();
    state.constraints = [["excluded_table", "excluded_table_pkey", "p", "PRIMARY KEY (memo)"]];
    const queries: string[] = [];
    await assert.rejects(
      () => assertSchemaContract(connectionFor(state, queries), CONTRACT),
      (error: unknown) => error instanceof ExportError && error.code === "schema_constraint_drift",
    );
    assert.equal(queries.length, 3);
  });
});
