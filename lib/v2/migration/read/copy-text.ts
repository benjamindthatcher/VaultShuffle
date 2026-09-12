import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import { ExportError } from "../shared/redaction.ts";

/**
 * Limits for the text COPY decoder.
 *
 * The decoder keeps one row and one field in memory. These limits are on the
 * decoded UTF-8 values, so an escaped control character consumes one logical
 * byte even though its COPY representation uses two bytes. Input chunks are
 * bounded separately; a caller cannot turn a single push into an unbounded
 * temporary allocation.
 */
export const COPY_DECODER_DEFAULT_LIMITS = Object.freeze({
  maxInputChunkBytes: 1024 * 1024,
  maxFieldBytes: 8 * 1024 * 1024,
  maxRowBytes: 32 * 1024 * 1024,
  maxColumns: 4096,
});

export type CopyDecoderLimits = {
  maxInputChunkBytes?: number;
  maxFieldBytes?: number;
  maxRowBytes?: number;
  maxColumns?: number;
};

export type CopyTextDecoderOptions = {
  expectedColumns: number;
  limits?: CopyDecoderLimits;
};

export type CopyRow = readonly (string | null)[];
export type CopyRowSink = (row: CopyRow) => void | Promise<void>;

export type CopyDecodeResult = {
  rows: number;
};

type ResolvedLimits = {
  maxInputChunkBytes: number;
  maxFieldBytes: number;
  maxRowBytes: number;
  maxColumns: number;
};

const ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
});

function decoderError(code: string): ExportError {
  const messages: Readonly<Record<string, string>> = {
    copy_invalid_chunk: "COPY text input must be a byte array.",
    copy_chunk_too_large: "COPY text input chunk exceeds the configured bound.",
    copy_invalid_utf8: "COPY text input is not valid UTF-8.",
    copy_malformed_escape: "COPY text input contains an unsupported or incomplete escape.",
    copy_malformed_control: "COPY text input contains an impossible NUL byte.",
    copy_null_with_data: "COPY text input has data after a NULL marker.",
    copy_field_too_large: "COPY text field exceeds the configured bound.",
    copy_row_too_large: "COPY text row exceeds the configured bound.",
    copy_field_count: "COPY text row has the wrong number of fields.",
    copy_truncated: "COPY text input does not end at a complete row boundary.",
    copy_columns_invalid: "COPY text column count is outside the configured bound.",
    copy_limits_invalid: "COPY text decoder limits are invalid.",
  };
  return new ExportError(code, messages[code] ?? "COPY text input is malformed.");
}

function positiveBound(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : value;
}

function resolveLimits(limits: CopyDecoderLimits | undefined): ResolvedLimits {
  const resolved: ResolvedLimits = {
    maxInputChunkBytes: positiveBound(limits?.maxInputChunkBytes, COPY_DECODER_DEFAULT_LIMITS.maxInputChunkBytes),
    maxFieldBytes: positiveBound(limits?.maxFieldBytes, COPY_DECODER_DEFAULT_LIMITS.maxFieldBytes),
    maxRowBytes: positiveBound(limits?.maxRowBytes, COPY_DECODER_DEFAULT_LIMITS.maxRowBytes),
    maxColumns: positiveBound(limits?.maxColumns, COPY_DECODER_DEFAULT_LIMITS.maxColumns),
  };
  if (
    Object.values(resolved).some((value) => !Number.isSafeInteger(value) || value < 1) ||
    resolved.maxInputChunkBytes > COPY_DECODER_DEFAULT_LIMITS.maxInputChunkBytes ||
    resolved.maxFieldBytes > COPY_DECODER_DEFAULT_LIMITS.maxFieldBytes ||
    resolved.maxRowBytes > COPY_DECODER_DEFAULT_LIMITS.maxRowBytes ||
    resolved.maxFieldBytes > resolved.maxRowBytes ||
    resolved.maxColumns > COPY_DECODER_DEFAULT_LIMITS.maxColumns
  ) {
    throw decoderError("copy_limits_invalid");
  }
  return resolved;
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Incremental decoder for PostgreSQL's `COPY ... FORMAT text` row bytes.
 *
 * The decoder accepts arbitrary byte boundaries. It recognizes PostgreSQL's
 * canonical text escapes and treats a field containing exactly `\N` as NULL;
 * `\\N` becomes the literal two-character string `\N`. The other nonzero ASCII
 * controls that PostgreSQL emits literally are retained; NUL is impossible in
 * a PostgreSQL text value. Values remain strings for the caller to interpret
 * later. A row is emitted only on LF, which is the terminal framing produced by
 * the exporter's COPY stream.
 */
export class CopyTextDecoder {
  readonly expectedColumns: number;
  readonly limits: ResolvedLimits;

  // `ignoreBOM: true` makes a leading U+FEFF ordinary data. The default
  // (`false`) consumes it as a transport marker, which would silently change
  // the first source cell.
  #utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  #fieldValue = "";
  #row: Array<string | null> = [];
  #fieldBytes = 0;
  #rowBytes = 0;
  #escapePending = false;
  #nullField = false;
  #rows = 0;
  #finished = false;

  constructor(expectedColumns: number, limits?: CopyDecoderLimits);
  constructor(options: CopyTextDecoderOptions);
  constructor(
    expectedColumnsOrOptions: number | CopyTextDecoderOptions,
    limits?: CopyDecoderLimits,
  ) {
    const expectedColumns =
      typeof expectedColumnsOrOptions === "number"
        ? expectedColumnsOrOptions
        : expectedColumnsOrOptions.expectedColumns;
    const selectedLimits =
      typeof expectedColumnsOrOptions === "number" ? limits : expectedColumnsOrOptions.limits;
    const resolved = resolveLimits(selectedLimits);
    if (!Number.isSafeInteger(expectedColumns) || expectedColumns < 1 || expectedColumns > resolved.maxColumns) {
      throw decoderError("copy_columns_invalid");
    }
    this.expectedColumns = expectedColumns;
    this.limits = resolved;
  }

  get rows(): number {
    return this.#rows;
  }

  /** Feed one bounded byte chunk. */
  async push(chunk: Uint8Array, onRow: CopyRowSink): Promise<void> {
    if (this.#finished) throw decoderError("copy_truncated");
    if (!(chunk instanceof Uint8Array)) throw decoderError("copy_invalid_chunk");
    if (chunk.byteLength > this.limits.maxInputChunkBytes) {
      throw decoderError("copy_chunk_too_large");
    }

    let text: string;
    try {
      text = this.#utf8.decode(chunk, { stream: true });
    } catch {
      throw decoderError("copy_invalid_utf8");
    }
    await this.#consumeText(text, onRow);
  }

  /** Finish the byte stream and require a terminal LF after every row. */
  async finish(onRow: CopyRowSink): Promise<CopyDecodeResult> {
    if (this.#finished) throw decoderError("copy_truncated");
    this.#finished = true;
    let text: string;
    try {
      text = this.#utf8.decode();
    } catch {
      throw decoderError("copy_invalid_utf8");
    }
    await this.#consumeText(text, onRow);
    if (this.#escapePending || this.#fieldValue.length > 0 || this.#row.length > 0 || this.#nullField) {
      throw decoderError("copy_truncated");
    }
    return { rows: this.#rows };
  }

  async #consumeText(text: string, onRow: CopyRowSink): Promise<void> {
    for (const character of text) {
      if (this.#escapePending) {
        this.#escapePending = false;
        if (character === "N") {
          if (this.#fieldValue.length === 0 && !this.#nullField) {
            this.#nullField = true;
            continue;
          }
          if (this.#nullField) throw decoderError("copy_null_with_data");
          // A non-canonical `foo\N` is interpreted by PostgreSQL's escape
          // scanner as `fooN`. Canonical exporter output for a literal slash is
          // `foo\\N`, which takes the branch below for the first slash and
          // remains lossless.
          this.#appendValue("N");
          continue;
        }
        const replacement = ESCAPES[character];
        if (replacement === undefined) throw decoderError("copy_malformed_escape");
        if (this.#nullField) throw decoderError("copy_null_with_data");
        this.#appendValue(replacement);
        continue;
      }

      if (character === "\\") {
        if (this.#nullField) throw decoderError("copy_null_with_data");
        this.#escapePending = true;
        continue;
      }
      if (character === "\t") {
        this.#finishField();
        this.#addRowStructuralByte();
        continue;
      }
      if (character === "\n") {
        this.#finishField();
        this.#addRowStructuralByte();
        await this.#finishRow(onRow);
        continue;
      }
      // PostgreSQL's COPY TO text writer emits the C-like escapes above for
      // b/f/n/r/t/v, but deliberately sends the other ASCII controls as raw
      // bytes. NUL terminates PostgreSQL's text representation and can never
      // be a source value. TAB and LF were handled as framing delimiters above.
      if (character === "\u0000") {
        throw decoderError("copy_malformed_control");
      }
      if (this.#nullField) throw decoderError("copy_null_with_data");
      this.#appendValue(character);
    }
  }

  #appendValue(value: string): void {
    const bytes = utf8ByteLength(value);
    this.#fieldBytes += bytes;
    this.#rowBytes += bytes;
    if (this.#fieldBytes > this.limits.maxFieldBytes) throw decoderError("copy_field_too_large");
    if (this.#rowBytes > this.limits.maxRowBytes) throw decoderError("copy_row_too_large");
    this.#fieldValue += value;
  }

  #addRowStructuralByte(): void {
    this.#rowBytes += 1;
    if (this.#rowBytes > this.limits.maxRowBytes) throw decoderError("copy_row_too_large");
  }

  #finishField(): void {
    if (this.#nullField) {
      this.#row.push(null);
    } else {
      this.#row.push(this.#fieldValue);
    }
    if (this.#row.length > this.expectedColumns) throw decoderError("copy_field_count");
    this.#fieldValue = "";
    this.#fieldBytes = 0;
    this.#nullField = false;
  }

  async #finishRow(onRow: CopyRowSink): Promise<void> {
    if (this.#row.length !== this.expectedColumns) throw decoderError("copy_field_count");
    const row = Object.freeze(this.#row.slice()) as CopyRow;
    this.#row = [];
    this.#rowBytes = 0;
    this.#rows += 1;
    await onRow(row);
  }
}

/** Decode an async or synchronous sequence of bounded byte chunks. */
export async function decodeCopyText(
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  expectedColumns: number,
  onRow: CopyRowSink,
  limits?: CopyDecoderLimits,
): Promise<CopyDecodeResult> {
  const decoder = new CopyTextDecoder(expectedColumns, limits);
  for await (const chunk of chunks) {
    await decoder.push(chunk, onRow);
  }
  return decoder.finish(onRow);
}
