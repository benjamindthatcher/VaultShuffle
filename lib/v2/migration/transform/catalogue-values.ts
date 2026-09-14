import { Buffer } from "node:buffer";
import { ExportError } from "../shared/redaction.ts";

/**
 * Exact readers for the two source representations `scalars.ts` does not yet
 * cover: PostgreSQL array output text and JSON/JSONB document text.
 *
 * Both are deliberately *readers*, not converters.  A JSONB cell arrives as
 * PostgreSQL's own canonical rendering of the stored value, so the faithful
 * transform is to keep that text and hand it back to a `::jsonb` cast: parsing
 * it into JavaScript values and re-serialising would put every number through
 * an IEEE double and lose the exactness the preservation contract requires.
 * A `text[]` cell genuinely has to be re-encoded as a JSON array, so that
 * conversion is explicit, element-order preserving and reversible.
 *
 * These belong in `transform/scalars.ts` next to the integer, decimal, civil
 * date and instant readers.  That file is owned by another worker in this
 * batch, so they are proposed for promotion rather than duplicated there.
 */

export type CatalogueValueErrorCode =
  | "catalogue_value_array_invalid"
  | "catalogue_value_array_shape_unsupported"
  | "catalogue_value_array_too_large"
  | "catalogue_value_json_invalid"
  | "catalogue_value_json_too_deep"
  | "catalogue_value_json_too_large"
  | "catalogue_value_bounds_invalid";

const CATALOGUE_VALUE_MESSAGES: Readonly<Record<CatalogueValueErrorCode, string>> = {
  catalogue_value_array_invalid: "The PostgreSQL array output text is malformed.",
  catalogue_value_array_shape_unsupported:
    "The PostgreSQL array is multi-dimensional or has a non-default lower bound; it is not flattened.",
  catalogue_value_array_too_large: "The PostgreSQL array exceeds the configured element or length bound.",
  catalogue_value_json_invalid: "The JSON document text is malformed.",
  catalogue_value_json_too_deep: "The JSON document exceeds the configured nesting bound.",
  catalogue_value_json_too_large: "The JSON document exceeds the configured size or value-count bound.",
  catalogue_value_bounds_invalid: "The configured value bounds are malformed.",
};

/** A redaction-safe failure. No source cell content reaches this error. */
export class CatalogueValueError extends ExportError {
  readonly valueCode: CatalogueValueErrorCode;

  constructor(code: CatalogueValueErrorCode, field?: string, offset?: number) {
    super(code, CATALOGUE_VALUE_MESSAGES[code], {
      field: field ?? null,
      // A byte offset locates a malformed cell without printing any of it.
      offset: offset === undefined ? null : offset,
    });
    this.name = "CatalogueValueError";
    this.valueCode = code;
  }
}

function fail(code: CatalogueValueErrorCode, field?: string, offset?: number): never {
  throw new CatalogueValueError(code, field, offset);
}

function safeField(field: string | undefined): string | undefined {
  return field && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(field) ? field : undefined;
}

/** PostgreSQL `length(text)` counts characters, not UTF-16 code units. */
export function pgLength(value: string): number {
  return Array.from(value).length;
}

/** PostgreSQL `btrim(text)` with its default single-space trim character. */
export function pgBtrim(value: string): string {
  return value.replace(/^ +| +$/g, "");
}

/** UTF-8 byte length, used as size evidence for the required SQL gates. */
export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export type PgTextArrayOptions = Readonly<{
  field?: string;
  /** Maximum element count. */
  maxElements?: number;
  /** Maximum characters in the array output text. */
  maxTextLength?: number;
}>;

export type PgTextArray = Readonly<{
  /** Element text exactly as PostgreSQL rendered it; `null` is a SQL NULL. */
  elements: readonly (string | null)[];
  /** The unmodified source cell. */
  sourceText: string;
}>;

const DEFAULT_ARRAY_MAX_ELEMENTS = 100_000;
const DEFAULT_ARRAY_MAX_TEXT_LENGTH = 1_000_000;

/**
 * Read one PostgreSQL one-dimensional array output cell exactly.
 *
 * `{Action,"Free to Play",NULL,""}` yields
 * `["Action", "Free to Play", null, ""]`.  An unquoted `NULL` is a SQL NULL
 * and a quoted `"NULL"` is the four-character string, which is the one
 * distinction a naive split on commas destroys.
 *
 * A multi-dimensional array or an explicit lower-bound prefix is refused
 * rather than flattened: flattening is a shape coercion, and the source column
 * this reads (`catalog_games.genres` / `categories`) has no defensible
 * flattened meaning.
 */
export function parsePgTextArray(
  value: string | null,
  options: PgTextArrayOptions = {},
): PgTextArray | null {
  const field = safeField(options.field);
  const maxElements = options.maxElements ?? DEFAULT_ARRAY_MAX_ELEMENTS;
  const maxTextLength = options.maxTextLength ?? DEFAULT_ARRAY_MAX_TEXT_LENGTH;
  if (
    !Number.isSafeInteger(maxElements) ||
    maxElements < 0 ||
    !Number.isSafeInteger(maxTextLength) ||
    maxTextLength < 2
  ) {
    fail("catalogue_value_bounds_invalid", field);
  }
  if (value === null) return null;
  if (typeof value !== "string") fail("catalogue_value_array_invalid", field);
  // `maxTextLength` is a character bound, matching PostgreSQL `length(text)`;
  // JavaScript's `string.length` counts UTF-16 code units and would reject a
  // valid astral-code-point value twice as early.
  if (pgLength(value) > maxTextLength) fail("catalogue_value_array_too_large", field);

  // `[1:3]={...}` announces a non-default lower bound.  It is a real shape,
  // and dropping the prefix would silently renumber the elements.
  if (value.startsWith("[")) fail("catalogue_value_array_shape_unsupported", field, 0);
  if (value.length < 2 || value[0] !== "{" || value[value.length - 1] !== "}") {
    fail("catalogue_value_array_invalid", field, 0);
  }

  const elements: (string | null)[] = [];
  const body = value.slice(1, -1);
  if (body.length === 0) {
    return Object.freeze({ elements: Object.freeze([]), sourceText: value });
  }

  let index = 0;
  for (;;) {
    if (elements.length >= maxElements) fail("catalogue_value_array_too_large", field, index + 1);
    let element: string | null;
    if (body[index] === '"') {
      index += 1;
      let text = "";
      for (;;) {
        if (index >= body.length) fail("catalogue_value_array_invalid", field, index + 1);
        const char = body[index];
        if (char === "\\") {
          if (index + 1 >= body.length) fail("catalogue_value_array_invalid", field, index + 1);
          // PostgreSQL's array writer escapes only `"` and `\`; everything
          // else after a backslash is that literal character.
          text += body[index + 1];
          index += 2;
          continue;
        }
        if (char === '"') {
          index += 1;
          break;
        }
        text += char;
        index += 1;
      }
      element = text;
    } else {
      const start = index;
      while (index < body.length && body[index] !== ",") {
        const char = body[index];
        if (char === "{" || char === "}") {
          fail("catalogue_value_array_shape_unsupported", field, index + 1);
        }
        if (char === '"' || char === "\\") fail("catalogue_value_array_invalid", field, index + 1);
        index += 1;
      }
      const raw = body.slice(start, index);
      // PostgreSQL strips unquoted leading/trailing whitespace on input; its
      // own writer never emits it, so the trim is a no-op on real output and a
      // safety net on hand-written input.
      const trimmed = raw.replace(/^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g, "");
      if (trimmed.length === 0) fail("catalogue_value_array_invalid", field, start + 1);
      element = trimmed.toUpperCase() === "NULL" ? null : trimmed;
    }
    elements.push(element);
    if (index >= body.length) break;
    if (body[index] !== ",") fail("catalogue_value_array_invalid", field, index + 1);
    index += 1;
    if (index >= body.length) fail("catalogue_value_array_invalid", field, index + 1);
  }

  return Object.freeze({ elements: Object.freeze(elements), sourceText: value });
}

/**
 * Encode array elements as a JSON array, preserving element order.
 *
 * This is the one deliberate re-encoding in the catalogue disposition:
 * `catalog_games.genres` and `categories` are `text[]` and their destinations
 * are `jsonb` arrays.  Only strings and SQL NULLs occur, so the encoding is
 * exact and reversible; no number ever passes through a double.
 */
export function encodeJsonStringArray(elements: readonly (string | null)[]): string {
  return JSON.stringify(elements.map((element) => (element === null ? null : element)));
}

export type JsonDocumentOptions = Readonly<{
  field?: string;
  maxDepth?: number;
  maxValues?: number;
  maxTextLength?: number;
}>;

export type JsonTopLevelType = "array" | "object" | "string" | "number" | "boolean" | "null";

export type JsonDocument = Readonly<{
  topLevelType: JsonTopLevelType;
  /** The unmodified source cell; this is what the loader casts to jsonb. */
  sourceText: string;
  /** Element count for an array, member count for an object, else 0. */
  topLevelCount: number;
  maxDepth: number;
  valueCount: number;
  utf8Bytes: number;
}>;

const DEFAULT_JSON_MAX_DEPTH = 256;
const DEFAULT_JSON_MAX_VALUES = 250_000;
const DEFAULT_JSON_MAX_TEXT_LENGTH = 8 * 1024 * 1024;

const JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const JSON_SHORT_ESCAPES = '"\\/bfnrt';

/**
 * Validate a JSON document without materialising it.
 *
 * The scanner never converts a number token.  A JSONB numeric is a PostgreSQL
 * `numeric`, and `JSON.parse` would round it to an IEEE double on the way in
 * and print a different value on the way out, so the document text is carried
 * through unchanged and only inspected.  Recursion is bounded by `maxDepth`
 * (256 by default), which is two orders of magnitude below the interpreter's
 * own stack limit, so a deep document fails with a stable code rather than a
 * RangeError.
 */
export function inspectJsonDocument(
  value: string | null,
  options: JsonDocumentOptions = {},
): JsonDocument | null {
  const field = safeField(options.field);
  const maxDepth = options.maxDepth ?? DEFAULT_JSON_MAX_DEPTH;
  const maxValues = options.maxValues ?? DEFAULT_JSON_MAX_VALUES;
  const maxTextLength = options.maxTextLength ?? DEFAULT_JSON_MAX_TEXT_LENGTH;
  if (
    !Number.isSafeInteger(maxDepth) ||
    maxDepth < 1 ||
    maxDepth > 1024 ||
    !Number.isSafeInteger(maxValues) ||
    maxValues < 1 ||
    !Number.isSafeInteger(maxTextLength) ||
    maxTextLength < 1
  ) {
    fail("catalogue_value_bounds_invalid", field);
  }
  if (value === null) return null;
  if (typeof value !== "string") fail("catalogue_value_json_invalid", field);
  // Keep the configurable bound in PostgreSQL characters.  The separate
  // `utf8Bytes` result is the evidence used for the server-side
  // `pg_column_size` gate.
  if (pgLength(value) > maxTextLength) fail("catalogue_value_json_too_large", field);

  const text = value;
  let index = 0;
  let depth = 0;
  let observedDepth = 0;
  let valueCount = 0;

  const invalid = (): never => fail("catalogue_value_json_invalid", field, index + 1);

  const skipWhitespace = (): void => {
    while (index < text.length && JSON_WHITESPACE.has(text[index])) index += 1;
  };

  const countValue = (): void => {
    valueCount += 1;
    if (valueCount > maxValues) fail("catalogue_value_json_too_large", field, index + 1);
  };

  const enter = (): void => {
    depth += 1;
    if (depth > maxDepth) fail("catalogue_value_json_too_deep", field, index + 1);
    if (depth > observedDepth) observedDepth = depth;
  };

  const isDigit = (char: string | undefined): boolean => char !== undefined && char >= "0" && char <= "9";

  const readString = (): void => {
    if (text[index] !== '"') invalid();
    index += 1;
    for (;;) {
      if (index >= text.length) invalid();
      const char = text[index];
      if (char === '"') {
        index += 1;
        return;
      }
      if (char === "\\") {
        index += 1;
        if (index >= text.length) invalid();
        const escape = text[index];
        if (escape === "u") {
          const hex = text.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) invalid();
          // PostgreSQL cannot store a NUL code point in a text datum, so its
          // jsonb input rejects that escape.  Accepting it here would build a
          // document the target cast refuses at load time.
          if (hex === "0000") invalid();
          const codePoint = Number.parseInt(hex, 16);
          if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
            // PostgreSQL's jsonb input requires a high surrogate to be
            // followed immediately by a low surrogate.  Treating each
            // `\\uXXXX` independently would accept a document the target
            // rejects and would make a later load failure look like a
            // successful transform.
            const lowStart = index + 5;
            if (text.slice(lowStart, lowStart + 2) !== "\\u") invalid();
            const lowHex = text.slice(lowStart + 2, lowStart + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(lowHex)) invalid();
            const lowCodePoint = Number.parseInt(lowHex, 16);
            if (lowCodePoint < 0xdc00 || lowCodePoint > 0xdfff) invalid();
            index += 11;
            continue;
          }
          if (codePoint >= 0xdc00 && codePoint <= 0xdfff) invalid();
          index += 5;
          continue;
        }
        if (!JSON_SHORT_ESCAPES.includes(escape)) invalid();
        index += 1;
        continue;
      }
      const codePoint = text.charCodeAt(index);
      if (codePoint < 0x20) invalid();
      // Raw supplementary characters arrive as a valid UTF-16 pair in the
      // JavaScript string. Reject an isolated surrogate so the accepted text
      // has the same Unicode validity PostgreSQL's UTF-8 text/jsonb input
      // requires.
      if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
        const lowCodePoint = text.charCodeAt(index + 1);
        if (lowCodePoint < 0xdc00 || lowCodePoint > 0xdfff) invalid();
        index += 2;
        continue;
      }
      if (codePoint >= 0xdc00 && codePoint <= 0xdfff) invalid();
      index += 1;
    }
  };

  const readNumber = (): void => {
    if (text[index] === "-") index += 1;
    if (text[index] === "0") {
      index += 1;
    } else if (isDigit(text[index])) {
      while (isDigit(text[index])) index += 1;
    } else {
      invalid();
    }
    if (text[index] === ".") {
      index += 1;
      if (!isDigit(text[index])) invalid();
      while (isDigit(text[index])) index += 1;
    }
    if (text[index] === "e" || text[index] === "E") {
      index += 1;
      if (text[index] === "+" || text[index] === "-") index += 1;
      if (!isDigit(text[index])) invalid();
      while (isDigit(text[index])) index += 1;
    }
  };

  const readLiteral = (literal: string): void => {
    if (text.slice(index, index + literal.length) !== literal) invalid();
    index += literal.length;
  };

  const readArray = (): number => {
    enter();
    if (text[index] !== "[") invalid();
    index += 1;
    skipWhitespace();
    let count = 0;
    if (text[index] === "]") {
      index += 1;
      depth -= 1;
      return 0;
    }
    for (;;) {
      readValue();
      count += 1;
      skipWhitespace();
      if (text[index] === ",") {
        index += 1;
        skipWhitespace();
        continue;
      }
      if (text[index] === "]") {
        index += 1;
        depth -= 1;
        return count;
      }
      invalid();
    }
  };

  const readObject = (): number => {
    enter();
    if (text[index] !== "{") invalid();
    index += 1;
    skipWhitespace();
    let count = 0;
    if (text[index] === "}") {
      index += 1;
      depth -= 1;
      return 0;
    }
    for (;;) {
      skipWhitespace();
      readString();
      skipWhitespace();
      if (text[index] !== ":") invalid();
      index += 1;
      readValue();
      count += 1;
      skipWhitespace();
      if (text[index] === ",") {
        index += 1;
        continue;
      }
      if (text[index] === "}") {
        index += 1;
        depth -= 1;
        return count;
      }
      invalid();
    }
  };

  function readValue(): void {
    countValue();
    skipWhitespace();
    const char = text[index];
    if (char === undefined) invalid();
    if (char === "{") {
      readObject();
      return;
    }
    if (char === "[") {
      readArray();
      return;
    }
    if (char === '"') {
      readString();
      return;
    }
    if (char === "-" || isDigit(char)) {
      readNumber();
      return;
    }
    if (char === "t") {
      readLiteral("true");
      return;
    }
    if (char === "f") {
      readLiteral("false");
      return;
    }
    if (char === "n") {
      readLiteral("null");
      return;
    }
    invalid();
  }

  skipWhitespace();
  const firstChar = text[index];
  if (firstChar === undefined) fail("catalogue_value_json_invalid", field, 1);
  let topLevelType: JsonTopLevelType;
  let topLevelCount = 0;
  if (firstChar === "{") {
    topLevelType = "object";
    countValue();
    topLevelCount = readObject();
  } else if (firstChar === "[") {
    topLevelType = "array";
    countValue();
    topLevelCount = readArray();
  } else {
    topLevelType =
      firstChar === '"'
        ? "string"
        : firstChar === "-" || isDigit(firstChar)
          ? "number"
          : firstChar === "t" || firstChar === "f"
            ? "boolean"
            : firstChar === "n"
              ? "null"
              : (invalid() as never);
    readValue();
  }

  skipWhitespace();
  if (index !== text.length) invalid();

  return Object.freeze({
    topLevelType,
    sourceText: text,
    topLevelCount,
    maxDepth: observedDepth,
    valueCount,
    utf8Bytes: utf8ByteLength(text),
  });
}

/**
 * Convert the legacy JSON object tag map to the target's ordered weighted-tag
 * array without passing numeric tokens through JavaScript numbers. The source
 * is jsonb, so object member order is not a fact; sorting decoded tag strings
 * gives the array a deterministic order while preserving every key and exact
 * numeric value.
 */
export function encodeJsonNumericObjectAsWeightedArray(value: string, options: JsonDocumentOptions = {}): string {
  const document = inspectJsonDocument(value, options);
  if (!document || document.topLevelType !== "object") fail("catalogue_value_json_invalid", safeField(options.field));
  let index = 0;
  const whitespace = (): void => { while (index < value.length && JSON_WHITESPACE.has(value[index])) index += 1; };
  const stringToken = (): string => {
    const start = index;
    if (value[index] !== '"') fail("catalogue_value_json_invalid", safeField(options.field), index + 1);
    index += 1;
    let escaped = false;
    while (index < value.length) {
      const char = value[index];
      index += 1;
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === '"') return value.slice(start, index);
    }
    fail("catalogue_value_json_invalid", safeField(options.field), index + 1);
  };
  const numberToken = (): string => {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(value.slice(index));
    if (!match) fail("catalogue_value_json_invalid", safeField(options.field), index + 1);
    index += match[0].length;
    return match[0];
  };
  const entries: { tag: string; weight: string }[] = [];
  const seen = new Set<string>();
  whitespace();
  index += 1; // inspectJsonDocument already proved the opening object token.
  whitespace();
  if (value[index] === "}") return "[]";
  for (;;) {
    const encodedTag = stringToken();
    const tag = JSON.parse(encodedTag) as string;
    if (seen.has(tag)) fail("catalogue_value_json_invalid", safeField(options.field), index + 1);
    seen.add(tag);
    whitespace();
    if (value[index] !== ":") fail("catalogue_value_json_invalid", safeField(options.field), index + 1);
    index += 1;
    whitespace();
    const weight = numberToken();
    entries.push({ tag, weight });
    whitespace();
    if (value[index] === "}") break;
    if (value[index] !== ",") fail("catalogue_value_json_invalid", safeField(options.field), index + 1);
    index += 1;
    whitespace();
  }
  entries.sort((left, right) => left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0);
  return `[${entries.map((entry) => `{"tag":${JSON.stringify(entry.tag)},"weight":${entry.weight}}`).join(",")}]`;
}
