import { Buffer } from "node:buffer";
import { parseCivilDate, parsePgDecimal, parsePgInteger, parsePgTimestamptz } from "../transform/scalars.ts";
import { loaderFailure } from "./errors.ts";

export type TargetScalarKind =
  | "text"
  | "integer"
  | "numeric"
  | "boolean"
  | "timestamptz"
  | "date"
  | "uuid"
  | "jsonb"
  | "bytea-hex";

export type TargetColumn = Readonly<{
  name: string;
  kind: TargetScalarKind;
  nullable: boolean;
}>;

export type TargetValue = string | number | bigint | boolean | Uint8Array | null | Readonly<Record<string, unknown>> | readonly unknown[];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]+$/;

function safeJson(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
    const parsed = JSON.parse(text) as unknown;
    text = JSON.stringify(parsed);
  } catch {
    throw loaderFailure("loader_copy_invalid", { field: "jsonb" });
  }
  if (text.includes("\u0000")) throw loaderFailure("loader_copy_invalid", { field: "jsonb" });
  return text;
}

function integer(value: TargetValue): string {
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string") {
    try {
      const parsed = parsePgInteger(value);
      if (parsed !== null) return parsed.toString(10);
    } catch {
      throw loaderFailure("loader_copy_invalid", { field: "integer" });
    }
  }
  throw loaderFailure("loader_copy_invalid", { field: "integer" });
}

function numeric(value: TargetValue): string {
  const text = typeof value === "string" ? value : typeof value === "bigint" ? value.toString(10) : null;
  if (text === null) throw loaderFailure("loader_copy_invalid", { field: "numeric" });
  try {
    const parsed = parsePgDecimal(text);
    if (parsed === null) throw loaderFailure("loader_copy_invalid", { field: "numeric" });
    return parsed.toCanonicalString();
  } catch (error) {
    throw error instanceof Error && error.name === "LoaderError"
      ? error
      : loaderFailure("loader_copy_invalid", { field: "numeric" });
  }
}

function timestamp(value: TargetValue): string {
  if (typeof value === "object" && value !== null && "canonicalUtc" in value) {
    const canonical = (value as { canonicalUtc?: unknown }).canonicalUtc;
    if (typeof canonical === "string" && parsePgTimestamptz(canonical) !== null) return canonical;
  }
  if (typeof value === "string") {
    try {
      const parsed = parsePgTimestamptz(value);
      if (parsed !== null) return parsed.canonicalUtc;
    } catch {
      throw loaderFailure("loader_copy_invalid", { field: "timestamptz" });
    }
  }
  throw loaderFailure("loader_copy_invalid", { field: "timestamptz" });
}

function date(value: TargetValue): string {
  const text =
    typeof value === "object" && value !== null && "sourceText" in value
      ? (value as { sourceText?: unknown }).sourceText
      : value;
  if (typeof text === "string") {
    try {
      const parsed = parseCivilDate(text);
      if (parsed !== null) return parsed.toIsoString();
    } catch {
      throw loaderFailure("loader_copy_invalid", { field: "date" });
    }
  }
  throw loaderFailure("loader_copy_invalid", { field: "date" });
}

export function targetCell(column: TargetColumn, value: TargetValue): string | null {
  if (value === null) {
    if (!column.nullable) throw loaderFailure("loader_copy_invalid", { field: column.name });
    return null;
  }
  switch (column.kind) {
    case "text":
      if (typeof value !== "string" || value.includes("\0")) throw loaderFailure("loader_copy_invalid", { field: column.name });
      return value;
    case "integer":
      return integer(value);
    case "numeric":
      return numeric(value);
    case "boolean":
      if (typeof value !== "boolean") throw loaderFailure("loader_copy_invalid", { field: column.name });
      return value ? "t" : "f";
    case "timestamptz":
      return timestamp(value);
    case "date":
      return date(value);
    case "uuid":
      if (typeof value !== "string" || !UUID.test(value)) throw loaderFailure("loader_copy_invalid", { field: column.name });
      return value.toLowerCase();
    case "jsonb":
      return safeJson(value);
    case "bytea-hex": {
      const text = value instanceof Uint8Array ? Buffer.from(value).toString("hex") : typeof value === "string" ? value : "";
      if (text.length === 0 || text.length % 2 !== 0 || !HEX.test(text)) throw loaderFailure("loader_copy_invalid", { field: column.name });
      return `\\x${text}`;
    }
  }
}

export function encodeCopyCell(value: string | null): string {
  if (value === null) return "\\N";
  if (value.includes("\0")) throw loaderFailure("loader_copy_invalid", { field: "copy_nul" });
  // `/\b/` is a word BOUNDARY in JavaScript, not a backspace: escaping with it
  // inserted a literal "\b" between every word and non-word character. The
  // character class is the actual backspace.
  return value.replace(/\\/g, "\\\\").replace(/[\b]/g, "\\b").replace(/\f/g, "\\f").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t").replace(/\v/g, "\\v");
}

export function encodeCopyRow(values: readonly (string | null)[]): string {
  return `${values.map(encodeCopyCell).join("\t")}\n`;
}
