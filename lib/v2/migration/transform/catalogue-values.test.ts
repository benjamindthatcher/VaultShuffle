import assert from "node:assert/strict";
import test from "node:test";
import {
  CatalogueValueError,
  encodeJsonStringArray,
  inspectJsonDocument,
  parsePgTextArray,
  pgBtrim,
  pgLength,
  utf8ByteLength,
} from "./catalogue-values.ts";

function valueFailure(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof CatalogueValueError, `expected CatalogueValueError, received ${String(error)}`);
    return error.valueCode;
  }
  assert.fail("expected a CatalogueValueError");
}

/* -------------------------------------------------------------------------
 * PostgreSQL array output text
 * ---------------------------------------------------------------------- */

test("reads the ordinary PostgreSQL array output forms", () => {
  assert.deepEqual(parsePgTextArray("{}")?.elements, []);
  assert.deepEqual(parsePgTextArray("{Action}")?.elements, ["Action"]);
  assert.deepEqual(parsePgTextArray("{Action,Indie,RPG}")?.elements, ["Action", "Indie", "RPG"]);
  assert.deepEqual(parsePgTextArray('{Action,"Free to Play"}')?.elements, ["Action", "Free to Play"]);
  assert.equal(parsePgTextArray(null), null);
});

test("preserves element order exactly", () => {
  const forward = parsePgTextArray("{Zeta,Alpha,Mu}");
  assert.deepEqual(forward?.elements, ["Zeta", "Alpha", "Mu"]);
});

test("distinguishes a SQL NULL element from the string NULL", () => {
  assert.deepEqual(parsePgTextArray("{NULL}")?.elements, [null]);
  assert.deepEqual(parsePgTextArray('{"NULL"}')?.elements, ["NULL"]);
  assert.deepEqual(parsePgTextArray('{Action,NULL,"NULL"}')?.elements, ["Action", null, "NULL"]);
});

test("distinguishes an empty-string element from an absent one", () => {
  assert.deepEqual(parsePgTextArray('{""}')?.elements, [""]);
  assert.deepEqual(parsePgTextArray('{"",Action}')?.elements, ["", "Action"]);
});

test("decodes the two escapes PostgreSQL's array writer emits", () => {
  assert.deepEqual(parsePgTextArray('{"a\\"b"}')?.elements, ['a"b']);
  assert.deepEqual(parsePgTextArray('{"a\\\\b"}')?.elements, ["a\\b"]);
  assert.deepEqual(parsePgTextArray('{"a,b","c}d","e{f"}')?.elements, ["a,b", "c}d", "e{f"]);
});

test("keeps the unmodified source cell alongside the elements", () => {
  const source = '{Action,"Free to Play"}';
  assert.equal(parsePgTextArray(source)?.sourceText, source);
});

test("refuses a multi-dimensional array rather than flattening it", () => {
  assert.equal(valueFailure(() => parsePgTextArray("{{a,b},{c,d}}")), "catalogue_value_array_shape_unsupported");
  assert.equal(valueFailure(() => parsePgTextArray("{a,{b}}")), "catalogue_value_array_shape_unsupported");
});

test("refuses an explicit lower-bound prefix rather than renumbering", () => {
  assert.equal(valueFailure(() => parsePgTextArray("[0:1]={a,b}")), "catalogue_value_array_shape_unsupported");
});

test("rejects malformed array text", () => {
  for (const text of ["", "{", "}", "abc", "{a", "a}", "{a,}", "{,a}", "{a,,b}", '{"a}', '{a"b}', "{a\\b}"]) {
    assert.equal(
      valueFailure(() => parsePgTextArray(text)),
      "catalogue_value_array_invalid",
      `expected ${JSON.stringify(text)} to be rejected`,
    );
  }
});

test("array bounds are enforced and never silently truncate", () => {
  assert.equal(valueFailure(() => parsePgTextArray("{a,b,c}", { maxElements: 2 })), "catalogue_value_array_too_large");
  assert.equal(valueFailure(() => parsePgTextArray("{aaaaaaaa}", { maxTextLength: 5 })), "catalogue_value_array_too_large");
  assert.equal(valueFailure(() => parsePgTextArray("{a}", { maxElements: -1 })), "catalogue_value_bounds_invalid");
  // `maxTextLength` follows PostgreSQL character semantics, so an astral
  // code point counts once even though JavaScript stores it in two code units.
  assert.deepEqual(parsePgTextArray(`{"${"\u{1F9EA}".repeat(3)}"}`, { maxTextLength: 8 })?.elements, ["\u{1F9EA}".repeat(3)]);
  assert.equal(valueFailure(() => parsePgTextArray(`{"${"\u{1F9EA}".repeat(6)}"}`, { maxTextLength: 8 })), "catalogue_value_array_too_large");
});

test("an array failure carries no cell content", () => {
  try {
    parsePgTextArray("{Secret Game Title", { field: "catalog_games.genres" });
    assert.fail("expected a CatalogueValueError");
  } catch (error) {
    assert.ok(error instanceof CatalogueValueError);
    const serialized = JSON.stringify(error.toJSON());
    assert.ok(!serialized.includes("Secret"), serialized);
    assert.equal(error.details.field, "catalog_games.genres");
  }
});

test("encodes elements as a JSON array with NULL preserved", () => {
  assert.equal(encodeJsonStringArray(["Action", "Free to Play"]), '["Action","Free to Play"]');
  assert.equal(encodeJsonStringArray([]), "[]");
  assert.equal(encodeJsonStringArray([null]), "[null]");
  assert.equal(encodeJsonStringArray(["NULL"]), '["NULL"]');
  assert.equal(encodeJsonStringArray(['a"b', "c\\d"]), '["a\\"b","c\\\\d"]');
});

test("the array to JSON encoding round-trips through a JSON reader", () => {
  const parsed = parsePgTextArray('{Action,"Free to Play",NULL,""}');
  const encoded = encodeJsonStringArray(parsed?.elements ?? []);
  assert.deepEqual(JSON.parse(encoded), ["Action", "Free to Play", null, ""]);
  const inspected = inspectJsonDocument(encoded);
  assert.equal(inspected?.topLevelType, "array");
  assert.equal(inspected?.topLevelCount, 4);
});

/* -------------------------------------------------------------------------
 * JSON documents
 * ---------------------------------------------------------------------- */

test("reports the top-level type of every JSON shape", () => {
  assert.equal(inspectJsonDocument("[]")?.topLevelType, "array");
  assert.equal(inspectJsonDocument("{}")?.topLevelType, "object");
  assert.equal(inspectJsonDocument('"text"')?.topLevelType, "string");
  assert.equal(inspectJsonDocument("12")?.topLevelType, "number");
  assert.equal(inspectJsonDocument("true")?.topLevelType, "boolean");
  assert.equal(inspectJsonDocument("false")?.topLevelType, "boolean");
  assert.equal(inspectJsonDocument("null")?.topLevelType, "null");
  assert.equal(inspectJsonDocument(null), null);
});

test("counts top-level members and reports observed depth", () => {
  const tags = inspectJsonDocument('[{"tag":"Action","weight":8123},{"tag":"Indie","weight":4}]');
  assert.equal(tags?.topLevelType, "array");
  assert.equal(tags?.topLevelCount, 2);
  assert.equal(tags?.maxDepth, 2);
  assert.equal(tags?.valueCount, 7);

  const nested = inspectJsonDocument('{"a":{"b":{"c":[1,2]}}}');
  assert.equal(nested?.maxDepth, 4);
  assert.equal(nested?.topLevelCount, 1);
});

test("keeps the exact document text rather than reserialising it", () => {
  // 10^30 and a 20-significant-digit weight are exact in PostgreSQL numeric
  // and lossy through an IEEE double.  The reader must return them unchanged.
  const source = '[{"tag":"Exact","weight":12345678901234567890},{"tag":"Big","weight":1e30}]';
  const document = inspectJsonDocument(source);
  assert.equal(document?.sourceText, source);
  assert.ok(document!.sourceText.includes("12345678901234567890"));
  assert.notEqual(JSON.stringify(JSON.parse(source)), source, "JSON.parse must be shown to be lossy here");
});

test("reports UTF-8 byte length as size evidence, not UTF-16 length", () => {
  // [ " é é " ]  =  1 + 1 + 2 + 2 + 1 + 1 bytes, against 6 UTF-16 units.
  const document = inspectJsonDocument('["éé"]');
  assert.equal(document?.sourceText.length, 6);
  assert.equal(document?.utf8Bytes, 8);
  assert.equal(utf8ByteLength("é"), 2);
});

test("accepts the JSON escape forms and rejects the impossible ones", () => {
  assert.equal(inspectJsonDocument('["a\\"b"]')?.topLevelCount, 1);
  assert.equal(inspectJsonDocument('["\\u0041"]')?.topLevelCount, 1);
  assert.equal(inspectJsonDocument('["\\ud834\\udd1e"]')?.topLevelCount, 1);
  assert.equal(inspectJsonDocument('["\\n\\t\\r\\b\\f\\/\\\\"]')?.topLevelCount, 1);
  // PostgreSQL cannot store a NUL code point in text, so its jsonb input
  // rejects that escape; accepting it would build an unloadable document.
  assert.equal(valueFailure(() => inspectJsonDocument('["\\u0000"]')), "catalogue_value_json_invalid");
  assert.equal(valueFailure(() => inspectJsonDocument('["\\ud800"]')), "catalogue_value_json_invalid");
  assert.equal(valueFailure(() => inspectJsonDocument('["\\udc00"]')), "catalogue_value_json_invalid");
  assert.equal(valueFailure(() => inspectJsonDocument('["\\ud800\\u0041"]')), "catalogue_value_json_invalid");
  assert.equal(valueFailure(() => inspectJsonDocument('["\\u00zz"]')), "catalogue_value_json_invalid");
  assert.equal(valueFailure(() => inspectJsonDocument('["\\x41"]')), "catalogue_value_json_invalid");
  assert.equal(valueFailure(() => inspectJsonDocument('["rawcontrol"]')), "catalogue_value_json_invalid");
});

test("rejects malformed JSON documents", () => {
  for (const text of [
    "",
    "  ",
    "{",
    "}",
    "[",
    "]",
    "[1,]",
    "[,1]",
    "{'a':1}",
    '{"a"}',
    '{"a":}',
    '{"a":1,}',
    '{a:1}',
    "[1 2]",
    "[1] [2]",
    "[1]x",
    "01",
    "1.",
    ".5",
    "1e",
    "1e+",
    "+1",
    "tru",
    "NULL",
    "undefined",
    "Infinity",
    "NaN",
  ]) {
    assert.equal(
      valueFailure(() => inspectJsonDocument(text)),
      "catalogue_value_json_invalid",
      `expected ${JSON.stringify(text)} to be rejected`,
    );
  }
});

test("accepts the number forms JSON allows", () => {
  for (const text of ["0", "-0", "12", "-12", "1.5", "-1.5", "1e5", "1E5", "1e+5", "1e-5", "1.5e-5", "0.0"]) {
    assert.equal(inspectJsonDocument(text)?.topLevelType, "number", `expected ${text} to be accepted`);
  }
});

test("whitespace between tokens is accepted and the text is unchanged", () => {
  const source = ' [ 1 , { "a" : [ ] } ] ';
  const document = inspectJsonDocument(source);
  assert.equal(document?.topLevelType, "array");
  assert.equal(document?.topLevelCount, 2);
  assert.equal(document?.sourceText, source);
});

test("JSON bounds are enforced with distinct codes", () => {
  const deep = `${"[".repeat(20)}1${"]".repeat(20)}`;
  assert.equal(valueFailure(() => inspectJsonDocument(deep, { maxDepth: 5 })), "catalogue_value_json_too_deep");
  assert.equal(valueFailure(() => inspectJsonDocument("[1,2,3,4]", { maxValues: 3 })), "catalogue_value_json_too_large");
  assert.equal(valueFailure(() => inspectJsonDocument("[1,2,3,4]", { maxTextLength: 4 })), "catalogue_value_json_too_large");
  assert.equal(valueFailure(() => inspectJsonDocument("[]", { maxDepth: 0 })), "catalogue_value_bounds_invalid");
  assert.equal(inspectJsonDocument(`{"${"\u{1F9EA}".repeat(3)}":1}`, { maxTextLength: 10 })?.topLevelCount, 1);
  assert.equal(valueFailure(() => inspectJsonDocument(`{"${"\u{1F9EA}".repeat(6)}":1}`, { maxTextLength: 10 })), "catalogue_value_json_too_large");
});

test("a deep document fails with a stable code rather than a RangeError", () => {
  const deep = `${"[".repeat(2000)}1${"]".repeat(2000)}`;
  assert.equal(valueFailure(() => inspectJsonDocument(deep)), "catalogue_value_json_too_deep");
});

test("a JSON failure carries no document content", () => {
  try {
    inspectJsonDocument('{"secret":"do-not-print"', { field: "catalog_games.tags" });
    assert.fail("expected a CatalogueValueError");
  } catch (error) {
    assert.ok(error instanceof CatalogueValueError);
    const serialized = JSON.stringify(error.toJSON());
    assert.ok(!serialized.includes("do-not-print"), serialized);
    assert.ok(!serialized.includes("secret"), serialized);
  }
});

/* -------------------------------------------------------------------------
 * PostgreSQL text helpers
 * ---------------------------------------------------------------------- */

test("pgLength counts characters the way PostgreSQL length() does", () => {
  assert.equal(pgLength("abc"), 3);
  // One astral code point is one character to PostgreSQL and two UTF-16 units
  // to JavaScript; the bound checks must use the former.
  assert.equal("\u{1F600}".length, 2);
  assert.equal(pgLength("\u{1F600}"), 1);
});

test("pgBtrim trims spaces only, like PostgreSQL's default", () => {
  assert.equal(pgBtrim("  a  "), "a");
  assert.equal(pgBtrim("\ta\t"), "\ta\t");
  assert.equal(pgBtrim("   "), "");
});
