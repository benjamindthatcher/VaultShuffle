import { createHash } from "node:crypto";
import { loaderFailure } from "./errors.ts";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const QUALIFIED = /^[A-Za-z_][A-Za-z0-9_$]{0,62}\.[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertIdentifier(value: string, field = "identifier"): string {
  if (!IDENTIFIER.test(value)) throw loaderFailure("loader_contract_invalid", { field });
  return value;
}

export function assertQualifiedRelation(value: string, field = "relation"): string {
  if (!QUALIFIED.test(value)) throw loaderFailure("loader_contract_invalid", { field });
  return value;
}

export function assertSha256(value: string, field = "fingerprint"): string {
  if (!SHA256.test(value)) throw loaderFailure("loader_contract_invalid", { field });
  return value;
}

export function assertUuid(value: string, field = "run_id"): string {
  if (!UUID.test(value)) throw loaderFailure("loader_contract_invalid", { field });
  return value.toLowerCase();
}

export function quoteIdentifier(value: string): string {
  return `"${assertIdentifier(value).replace(/"/g, '""')}"`;
}

export function quoteRelation(value: string): string {
  const [schema, relation] = assertQualifiedRelation(value).split(".");
  return `${quoteIdentifier(schema)}.${quoteIdentifier(relation)}`;
}

function normalize(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw loaderFailure("loader_contract_invalid", { field: "canonical_number" });
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, seen));
  if (typeof value !== "object") throw loaderFailure("loader_contract_invalid", { field: "canonical_value" });
  if (seen.has(value)) throw loaderFailure("loader_contract_invalid", { field: "canonical_cycle" });
  seen.add(value);
  try {
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const member = record[key];
      if (typeof member === "function" || member === undefined) continue;
      output[key] = normalize(member, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, new Set()));
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalSha256(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

export class OrderedChecksum {
  readonly #hash = createHash("sha256");
  #count = 0;
  #finished: Readonly<{ rows: number; sha256: string }> | null = null;

  update(value: unknown): void {
    if (this.#finished !== null) throw loaderFailure("loader_contract_invalid", { field: "checksum_finished" });
    const bytes = Buffer.from(canonicalJson(value), "utf8");
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    this.#hash.update(length);
    this.#hash.update(bytes);
    this.#count += 1;
  }

  /** Idempotent: a digest is a value, and reading it twice is not a mutation. */
  finish(): Readonly<{ rows: number; sha256: string }> {
    this.#finished ??= Object.freeze({ rows: this.#count, sha256: this.#hash.digest("hex") });
    return this.#finished;
  }
}
