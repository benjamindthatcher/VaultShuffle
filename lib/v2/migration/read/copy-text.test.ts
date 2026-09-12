import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import {
  COPY_DECODER_DEFAULT_LIMITS,
  CopyTextDecoder,
  decodeCopyText,
  type CopyRow,
} from "./copy-text.ts";
import { ExportError } from "../shared/redaction.ts";

async function expectCode(run: () => Promise<unknown> | unknown, code: string): Promise<ExportError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof ExportError, `expected ExportError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  throw new assert.AssertionError({ message: `expected ${code}, but nothing was thrown` });
}

async function decodeBytes(bytes: Uint8Array, expectedColumns: number, chunkSize = 3): Promise<CopyRow[]> {
  const rows: CopyRow[] = [];
  const decoder = new CopyTextDecoder(expectedColumns);
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    await decoder.push(bytes.subarray(offset, offset + chunkSize), (row) => {
      rows.push(row);
    });
  }
  await decoder.finish((row) => {
    rows.push(row);
  });
  return rows;
}

test("COPY text keeps escapes, UTF-8 and exact strings across arbitrary byte boundaries", async () => {
  const wire = "1\tline\\nnext\\tcolumn\\\\slash\\r\\b\\f\\v\né\t東京\\\\N\n";
  const rows = await decodeBytes(Buffer.from(wire, "utf8"), 2, 1);
  assert.deepEqual(rows, [
    ["1", "line\nnext\tcolumn\\slash\r\b\f\v"],
    ["é", "東京\\N"],
  ]);
});

test("NULL, empty string and a literal backslash-N remain distinct", async () => {
  const rows = await decodeBytes(Buffer.from("\\N\t\t\\\\N\n", "utf8"), 3, 2);
  assert.deepEqual(rows, [[null, "", "\\N"]]);
});

test("large integers, decimals, UTC instants and civil dates are never coerced", async () => {
  const values = [
    "9223372036854775807",
    "1234567890123456789012345678.0123456789",
    "2026-03-29 00:59:59.123456+00",
    "2026-03-29",
  ];
  const rows = await decodeBytes(Buffer.from(`${values.join("\t")}\n`, "utf8"), values.length, 5);
  assert.deepEqual(rows, [values]);
  assert.equal(typeof rows[0][0], "string");
  assert.equal(rows[0][0], values[0]);
  assert.equal(rows[0][1], values[1]);
});

test("an empty stream is valid and an empty field is not NULL", async () => {
  const empty = await decodeBytes(Buffer.alloc(0), 1);
  assert.deepEqual(empty, []);
  const oneEmpty = await decodeBytes(Buffer.from("\n"), 1);
  assert.deepEqual(oneEmpty, [[""]]);
});

test("a leading UTF-8 BOM is preserved as source data across chunk boundaries", async () => {
  const bytes = Buffer.from("\uFEFFvalue\n", "utf8");
  const decoder = new CopyTextDecoder(1);
  const rows: CopyRow[] = [];
  for (let offset = 0; offset < bytes.length; offset += 1) {
    await decoder.push(bytes.subarray(offset, offset + 1), (row) => {
      rows.push(row);
    });
  }
  await decoder.finish((row) => {
    rows.push(row);
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0]?.codePointAt(0), 0xfeff);
  assert.equal(rows[0][0], "\uFEFFvalue");
});

test("raw PostgreSQL control bytes remain data and NUL is rejected", async () => {
  const controls = String.fromCodePoint(...Array.from({ length: 7 }, (_, index) => index + 1), 0x0b, 0x0c, ...Array.from({ length: 19 }, (_, index) => index + 0x0d));
  const rows = await decodeBytes(Buffer.from(`${controls}\n`, "utf8"), 1, 2);
  assert.deepEqual(rows, [[controls]]);
  await expectCode(() => decodeBytes(Buffer.from([0x00, 0x0a]), 1), "copy_malformed_control");
});

test("malformed framing and escapes fail with stable codes and no input text", async (t) => {
  await t.test("missing terminal LF", async () => {
    const error = await expectCode(
      () => decodeBytes(Buffer.from("private-note-without-newline"), 1),
      "copy_truncated",
    );
    assert.equal(error.message, "COPY text input does not end at a complete row boundary.");
  });
  await t.test("dangling and unsupported escapes", async () => {
    await expectCode(() => decodeBytes(Buffer.from("x\\"), 1), "copy_truncated");
    await expectCode(() => decodeBytes(Buffer.from("x\\q\n"), 1), "copy_malformed_escape");
    await expectCode(() => decodeBytes(Buffer.from("\\Nsecret\n"), 1), "copy_null_with_data");
  });
  await t.test("wrong field count and impossible NUL", async () => {
    await expectCode(() => decodeBytes(Buffer.from("a\n"), 2), "copy_field_count");
    await expectCode(() => decodeBytes(Buffer.from([0x61, 0x00, 0x0a]), 1), "copy_malformed_control");
  });
  await t.test("invalid UTF-8 is rejected", async () => {
    await expectCode(() => decodeBytes(Buffer.from([0xc3, 0x28, 0x0a]), 1), "copy_invalid_utf8");
  });
});

test("decoder limits bound input chunks, fields, rows and columns", async (t) => {
  await t.test("columns", async () => {
    await expectCode(() => new CopyTextDecoder(COPY_DECODER_DEFAULT_LIMITS.maxColumns + 1), "copy_columns_invalid");
  });
  await t.test("input chunk", async () => {
    const decoder = new CopyTextDecoder(1, { maxInputChunkBytes: 2 });
    await expectCode(() => decoder.push(Buffer.from("abc"), () => {}), "copy_chunk_too_large");
  });
  await t.test("field and row", async () => {
    await expectCode(
      () => decodeCopyText([Buffer.from("abcd\n")], 1, () => {}, { maxFieldBytes: 3, maxRowBytes: 20 }),
      "copy_field_too_large",
    );
    await expectCode(
      () => decodeCopyText([Buffer.from("a\tb\n")], 2, () => {}, { maxFieldBytes: 3, maxRowBytes: 3 }),
      "copy_row_too_large",
    );
  });
});

test("rows are emitted incrementally and an async consumer is awaited", async () => {
  const rows: string[] = [];
  const decoder = new CopyTextDecoder(1);
  await decoder.push(Buffer.from("first\nsecond\n"), async (row) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    rows.push(row[0] as string);
  });
  const result = await decoder.finish(async () => {});
  assert.deepEqual(rows, ["first", "second"]);
  assert.equal(result.rows, 2);
});
