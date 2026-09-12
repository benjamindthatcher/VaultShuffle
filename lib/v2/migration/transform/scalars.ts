import { ExportError } from "../shared/redaction.ts";

/**
 * The scalar layer deliberately accepts the small set of text forms emitted by
 * the PG17 COPY exporter.  It is not a general SQL or date parser.  A caller
 * that needs another source representation must add a reviewed representation
 * first rather than silently widening these grammars.
 */

export type ScalarErrorCode =
  | "scalar_integer_invalid"
  | "scalar_integer_bounds_invalid"
  | "scalar_integer_overflow"
  | "scalar_decimal_invalid"
  | "scalar_decimal_nonfinite"
  | "scalar_decimal_bounds_invalid"
  | "scalar_decimal_scale_out_of_bounds"
  | "scalar_decimal_digits_out_of_bounds"
  | "scalar_decimal_out_of_bounds"
  | "scalar_timestamp_invalid"
  | "scalar_timestamp_nonfinite"
  | "scalar_timestamp_timezone_missing"
  | "scalar_timestamp_timezone_ambiguous"
  | "scalar_timestamp_precision_unsupported"
  | "scalar_timestamp_offset_out_of_bounds"
  | "scalar_timestamp_out_of_bounds"
  | "scalar_civil_date_invalid"
  | "scalar_civil_date_out_of_bounds";

const SCALAR_MESSAGES: Readonly<Record<ScalarErrorCode, string>> = {
  scalar_integer_invalid: "The PostgreSQL integer text is malformed.",
  scalar_integer_bounds_invalid: "The integer destination bounds are malformed.",
  scalar_integer_overflow: "The PostgreSQL integer does not fit the destination bounds.",
  scalar_decimal_invalid: "The PostgreSQL numeric text is malformed.",
  scalar_decimal_nonfinite: "Non-finite PostgreSQL numeric values are not supported.",
  scalar_decimal_bounds_invalid: "The decimal destination bounds are malformed.",
  scalar_decimal_scale_out_of_bounds: "The PostgreSQL numeric scale is outside the configured bound.",
  scalar_decimal_digits_out_of_bounds: "The PostgreSQL numeric precision is outside the configured bound.",
  scalar_decimal_out_of_bounds: "The PostgreSQL numeric does not fit the destination bounds.",
  scalar_timestamp_invalid: "The PostgreSQL timestamptz text is malformed.",
  scalar_timestamp_nonfinite: "Non-finite PostgreSQL timestamptz values are not supported.",
  scalar_timestamp_timezone_missing: "The PostgreSQL timestamptz text has no supported timezone.",
  scalar_timestamp_timezone_ambiguous: "The PostgreSQL timestamptz timezone is ambiguous.",
  scalar_timestamp_precision_unsupported: "The PostgreSQL timestamptz precision exceeds six fractional digits.",
  scalar_timestamp_offset_out_of_bounds: "The PostgreSQL timestamptz offset is outside the supported range.",
  scalar_timestamp_out_of_bounds: "The PostgreSQL timestamptz is outside the configured bounds.",
  scalar_civil_date_invalid: "The civil date text is malformed or names a non-existent day.",
  scalar_civil_date_out_of_bounds: "The civil date is outside the supported year range.",
};

/** A stable, redaction-safe failure.  Raw source values never enter this error. */
export class ScalarError extends ExportError {
  readonly scalarCode: ScalarErrorCode;

  constructor(code: ScalarErrorCode, field?: string) {
    super(code, SCALAR_MESSAGES[code], field ? { field } : {});
    this.name = "ScalarError";
    this.scalarCode = code;
  }
}

function scalarError(code: ScalarErrorCode, field?: string): ScalarError {
  return new ScalarError(code, field);
}

function fail(code: ScalarErrorCode, field?: string): never {
  throw scalarError(code, field);
}

function fieldName(field: string | undefined): string | undefined {
  return field && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(field) ? field : undefined;
}

export type IntegerBounds = Readonly<{
  minInclusive?: bigint;
  maxInclusive?: bigint;
  field?: string;
}>;

const PG_INTEGER_TEXT = /^[+-]?[0-9]+$/;

/**
 * Parse a PostgreSQL integer cell without converting through Number.  NULL is
 * a first-class result; the caller decides whether the source column permits
 * it.  Bounds are inclusive and explicit when a narrower destination exists.
 */
export function parsePgInteger(value: string | null, bounds: IntegerBounds = {}): bigint | null {
  const field = fieldName(bounds.field);
  if (bounds.minInclusive !== undefined && typeof bounds.minInclusive !== "bigint") {
    fail("scalar_integer_bounds_invalid", field);
  }
  if (bounds.maxInclusive !== undefined && typeof bounds.maxInclusive !== "bigint") {
    fail("scalar_integer_bounds_invalid", field);
  }
  if (
    bounds.minInclusive !== undefined &&
    bounds.maxInclusive !== undefined &&
    bounds.minInclusive > bounds.maxInclusive
  ) {
    fail("scalar_integer_bounds_invalid", field);
  }
  if (value === null) return null;
  if (typeof value !== "string" || !PG_INTEGER_TEXT.test(value)) {
    fail("scalar_integer_invalid", field);
  }

  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    fail("scalar_integer_invalid", field);
  }
  if (
    (bounds.minInclusive !== undefined && parsed < bounds.minInclusive) ||
    (bounds.maxInclusive !== undefined && parsed > bounds.maxInclusive)
  ) {
    fail("scalar_integer_overflow", field);
  }
  return parsed;
}

export const parsePgInt = parsePgInteger;

export type DecimalBounds = Readonly<{
  minInclusive?: string;
  maxInclusive?: string;
  /** Maximum significant coefficient digits. Defaults to a bounded PG value. */
  maxDigits?: number;
  /** Maximum absolute scale. Defaults to the PG numeric scale bound. */
  maxScale?: number;
  field?: string;
}>;

export type PgDecimal = Readonly<{
  /** -1, 0, or 1. Zero has coefficient zero regardless of source sign. */
  sign: -1 | 0 | 1;
  coefficient: bigint;
  /** Decimal point position relative to the coefficient; may be negative. */
  scale: number;
  sourceText: string;
  toCanonicalString: () => string;
  toJSON: () => string;
}>;

const DECIMAL_TEXT = /^[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?)|(?:\.[0-9]+))(?:[eE][+-]?[0-9]+)?$/;
const DEFAULT_DECIMAL_MAX_DIGITS = 100_000;
const DEFAULT_DECIMAL_MAX_SCALE = 16_383;
const ZERO = BigInt(0);

function finiteDecimalLimits(options: DecimalBounds): { maxDigits: number; maxScale: number; field?: string } {
  const maxDigits = options.maxDigits ?? DEFAULT_DECIMAL_MAX_DIGITS;
  const maxScale = options.maxScale ?? DEFAULT_DECIMAL_MAX_SCALE;
  const field = fieldName(options.field);
  if (
    !Number.isSafeInteger(maxDigits) ||
    maxDigits < 1 ||
    maxDigits > DEFAULT_DECIMAL_MAX_DIGITS ||
    !Number.isSafeInteger(maxScale) ||
    maxScale < 0 ||
    maxScale > DEFAULT_DECIMAL_MAX_SCALE
  ) {
    fail("scalar_decimal_bounds_invalid", field);
  }
  return { maxDigits, maxScale, field };
}

function decimalExponent(text: string, field?: string): bigint {
  try {
    return BigInt(text);
  } catch {
    fail("scalar_decimal_invalid", field);
  }
}

function decimalAbsolute(value: PgDecimal): PgDecimal {
  return value.sign < 0
    ? ({ ...value, sign: 1 } as PgDecimal)
    : value;
}

function decimalMagnitude(value: PgDecimal): number {
  if (value.coefficient === ZERO) return 0;
  return value.coefficient.toString().length - value.scale;
}

function powerOfTen(exponent: number): bigint {
  // exponent is bounded by the parser's PG-scale bound plus coefficient size;
  // this guard protects callers that construct a malformed PgDecimal object.
  if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > DEFAULT_DECIMAL_MAX_DIGITS + DEFAULT_DECIMAL_MAX_SCALE) {
    fail("scalar_decimal_scale_out_of_bounds");
  }
  return BigInt(10) ** BigInt(exponent);
}

function parseDecimalUnbounded(value: string, limits: { maxDigits: number; maxScale: number; field?: string }): PgDecimal {
  if (value === "NaN" || value === "nan" || /inf/i.test(value)) {
    fail("scalar_decimal_nonfinite", limits.field);
  }
  if (!DECIMAL_TEXT.test(value)) fail("scalar_decimal_invalid", limits.field);

  const exponentMarker = value.search(/[eE]/);
  const mantissa = exponentMarker >= 0 ? value.slice(0, exponentMarker) : value;
  const exponentText = exponentMarker >= 0 ? value.slice(exponentMarker + 1) : "0";
  const exponent = decimalExponent(exponentText, limits.field);
  const signChar = mantissa[0] === "+" || mantissa[0] === "-" ? mantissa[0] : "";
  const unsigned = signChar ? mantissa.slice(1) : mantissa;
  const dot = unsigned.indexOf(".");
  const integerPart = dot >= 0 ? unsigned.slice(0, dot) : unsigned;
  const fractionPart = dot >= 0 ? unsigned.slice(dot + 1) : "";
  const digitText = `${integerPart}${fractionPart}`;
  const significantDigits = digitText.replace(/^0+/, "") || "0";
  if (significantDigits.length > limits.maxDigits) {
    fail("scalar_decimal_digits_out_of_bounds", limits.field);
  }

  const scale = BigInt(fractionPart.length) - exponent;
  const maxScale = BigInt(limits.maxScale);
  if (scale > maxScale || scale < -maxScale) {
    fail("scalar_decimal_scale_out_of_bounds", limits.field);
  }

  let coefficient: bigint;
  try {
    coefficient = BigInt(significantDigits);
  } catch {
    fail("scalar_decimal_invalid", limits.field);
  }
  const numericScale = Number(scale);
  const sign: -1 | 0 | 1 = coefficient === ZERO ? 0 : signChar === "-" ? -1 : 1;
  const result: PgDecimal = Object.freeze({
    sign,
    coefficient,
    scale: numericScale,
    sourceText: value,
    toCanonicalString(): string {
      if (coefficient === ZERO) return "0";
      const digits = coefficient.toString();
      const negative = sign < 0 && coefficient !== ZERO;
      let body: string;
      if (numericScale <= 0) {
        body = `${digits}${"0".repeat(-numericScale)}`;
      } else if (digits.length <= numericScale) {
        body = `0.${"0".repeat(numericScale - digits.length)}${digits}`;
      } else {
        const split = digits.length - numericScale;
        body = `${digits.slice(0, split)}.${digits.slice(split)}`;
      }
      return negative ? `-${body}` : body;
    },
    toJSON(): string {
      return this.toCanonicalString();
    },
  });
  return result;
}

function compareAbsoluteDecimals(left: PgDecimal, right: PgDecimal): -1 | 0 | 1 {
  const l = decimalAbsolute(left);
  const r = decimalAbsolute(right);
  if (l.coefficient === ZERO && r.coefficient === ZERO) return 0;
  const leftMagnitude = decimalMagnitude(l);
  const rightMagnitude = decimalMagnitude(r);
  if (leftMagnitude !== rightMagnitude) return leftMagnitude < rightMagnitude ? -1 : 1;
  const scale = Math.max(l.scale, r.scale);
  const leftCoefficient = l.coefficient * powerOfTen(scale - l.scale);
  const rightCoefficient = r.coefficient * powerOfTen(scale - r.scale);
  return leftCoefficient < rightCoefficient ? -1 : leftCoefficient > rightCoefficient ? 1 : 0;
}

/** Compare two parsed decimals exactly, without Number conversion. */
export function comparePgDecimals(left: PgDecimal, right: PgDecimal): -1 | 0 | 1 {
  if (left.sign !== right.sign) return left.sign < right.sign ? -1 : 1;
  if (left.sign === 0) return 0;
  const absolute = compareAbsoluteDecimals(left, right);
  return left.sign < 0 ? (absolute === 0 ? 0 : absolute === 1 ? -1 : 1) : absolute;
}

/** Parse finite PostgreSQL numeric text exactly and apply optional bounds. */
export function parsePgDecimal(value: string | null, options: DecimalBounds = {}): PgDecimal | null {
  const limits = finiteDecimalLimits(options);
  if (value === null) return null;
  if (typeof value !== "string") fail("scalar_decimal_invalid", limits.field);
  const parsed = parseDecimalUnbounded(value, limits);

  let minimum: PgDecimal | null = null;
  let maximum: PgDecimal | null = null;
  if (options.minInclusive !== undefined) {
    if (typeof options.minInclusive !== "string") fail("scalar_decimal_bounds_invalid", limits.field);
    minimum = parseDecimalUnbounded(options.minInclusive, {
      maxDigits: DEFAULT_DECIMAL_MAX_DIGITS,
      maxScale: DEFAULT_DECIMAL_MAX_SCALE,
      field: limits.field,
    });
  }
  if (options.maxInclusive !== undefined) {
    if (typeof options.maxInclusive !== "string") fail("scalar_decimal_bounds_invalid", limits.field);
    maximum = parseDecimalUnbounded(options.maxInclusive, {
      maxDigits: DEFAULT_DECIMAL_MAX_DIGITS,
      maxScale: DEFAULT_DECIMAL_MAX_SCALE,
      field: limits.field,
    });
  }
  if (minimum && maximum && comparePgDecimals(minimum, maximum) > 0) {
    fail("scalar_decimal_bounds_invalid", limits.field);
  }
  if (minimum && comparePgDecimals(parsed, minimum) < 0) fail("scalar_decimal_out_of_bounds", limits.field);
  if (maximum && comparePgDecimals(parsed, maximum) > 0) fail("scalar_decimal_out_of_bounds", limits.field);
  return parsed;
}

export const parsePgNumeric = parsePgDecimal;

export type CivilDate = Readonly<{
  year: number;
  month: number;
  day: number;
  sourceText: string;
  toIsoString: () => string;
  toJSON: () => string;
}>;

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function isLeapYear(year: number): boolean {
  if (!Number.isSafeInteger(year) || year < 1) return false;
  return leapYear(year);
}

const DAYS_IN_MONTH = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);

function validateCivilParts(year: number, month: number, day: number, field?: string): void {
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month) || !Number.isSafeInteger(day)) {
    fail("scalar_civil_date_invalid", field);
  }
  if (year < 1 || year > 9999) fail("scalar_civil_date_out_of_bounds", field);
  if (month < 1 || month > 12) fail("scalar_civil_date_invalid", field);
  const maxDay = DAYS_IN_MONTH[month - 1] + (month === 2 && leapYear(year) ? 1 : 0);
  if (day < 1 || day > maxDay) fail("scalar_civil_date_invalid", field);
}

const CIVIL_DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Validate a PG date cell independently from timezone-bearing instants. */
export function parseCivilDate(value: string | null, field?: string): CivilDate | null {
  const safeField = fieldName(field);
  if (value === null) return null;
  if (typeof value !== "string") fail("scalar_civil_date_invalid", safeField);
  const match = CIVIL_DATE_TEXT.exec(value);
  if (!match) fail("scalar_civil_date_invalid", safeField);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  validateCivilParts(year, month, day, safeField);
  const result: CivilDate = Object.freeze({
    year,
    month,
    day,
    sourceText: value,
    toIsoString(): string {
      return value;
    },
    toJSON(): string {
      return value;
    },
  });
  return result;
}

export const parsePgDate = parseCivilDate;

/** Proleptic Gregorian day number relative to 1970-01-01 (integer-only). */
function daysFromCivil(year: number, month: number, day: number): number {
  let adjustedYear = year;
  adjustedYear -= month <= 2 ? 1 : 0;
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const monthPrime = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * monthPrime + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

function civilFromDays(dayNumber: number): { year: number; month: number; day: number } {
  let z = dayNumber + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365);
  let year = yearOfEra + era * 400;
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  year += month <= 2 ? 1 : 0;
  return { year, month, day };
}

export type PgTimestamp = Readonly<{
  /** Exact UTC instant. BigInt is intentionally kept inside this scalar object. */
  epochMicros: bigint;
  /** Decimal text form for JSON, COPY and SQL boundaries. */
  epochMicrosText: string;
  canonicalUtc: string;
  sourceText: string;
  toJSON: () => string;
}>;

export type TimestampBounds = Readonly<{
  minEpochMicros?: bigint;
  maxEpochMicros?: bigint;
  field?: string;
}>;

const TIMESTAMP_TEXT = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:\s*(Z|UTC|[+-]\d{2}(?::?\d{2})?(?::?\d{2})?))?$/;
const MICROS_PER_SECOND = BigInt(1_000_000);
const MICROS_PER_DAY = BigInt(86_400_000_000);

function parseTimestampOffset(zone: string | undefined, field?: string): number {
  if (!zone) fail("scalar_timestamp_timezone_missing", field);
  if (zone === "Z" || zone === "UTC") return 0;
  const match = /^([+-])(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?$/.exec(zone);
  if (!match) fail("scalar_timestamp_timezone_ambiguous", field);
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? "0");
  const seconds = Number(match[4] ?? "0");
  if (hours > 23 || minutes > 59 || seconds > 59) fail("scalar_timestamp_offset_out_of_bounds", field);
  const total = hours * 3600 + minutes * 60 + seconds;
  return match[1] === "-" ? -total : total;
}

function formatCanonicalUtc(epochMicros: bigint): string {
  const day = epochMicros >= ZERO ? epochMicros / MICROS_PER_DAY : (epochMicros - (MICROS_PER_DAY - BigInt(1))) / MICROS_PER_DAY;
  const withinDay = epochMicros - day * MICROS_PER_DAY;
  const dayNumber = Number(day);
  if (!Number.isSafeInteger(dayNumber)) fail("scalar_timestamp_out_of_bounds");
  const civil = civilFromDays(dayNumber);
  validateCivilParts(civil.year, civil.month, civil.day);
  const hours = withinDay / BigInt(3_600_000_000);
  const afterHours = withinDay - hours * BigInt(3_600_000_000);
  const minutes = afterHours / BigInt(60_000_000);
  const afterMinutes = afterHours - minutes * BigInt(60_000_000);
  const seconds = afterMinutes / MICROS_PER_SECOND;
  const micros = afterMinutes - seconds * MICROS_PER_SECOND;
  const pad = (value: number | bigint, width: number): string => String(value).padStart(width, "0");
  return `${pad(civil.year, 4)}-${pad(civil.month, 2)}-${pad(civil.day, 2)}T${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(micros, 6)}Z`;
}

/**
 * Construct a checked timestamp from exact epoch microseconds.
 *
 * This is the counterpart to `parsePgTimestamptz` for a target instant derived
 * from an already-validated source fact. It deliberately uses the scalar
 * civil-time formatter rather than `Date`, whose range and negative-division
 * behaviour are not this migration contract.
 */
export function timestampFromEpochMicros(epochMicros: bigint, bounds: TimestampBounds = {}): PgTimestamp {
  const field = fieldName(bounds.field);
  if (typeof epochMicros !== "bigint") fail("scalar_timestamp_out_of_bounds", field);
  if (
    (bounds.minEpochMicros !== undefined && epochMicros < bounds.minEpochMicros) ||
    (bounds.maxEpochMicros !== undefined && epochMicros > bounds.maxEpochMicros)
  ) {
    fail("scalar_timestamp_out_of_bounds", field);
  }
  const canonicalUtc = formatCanonicalUtc(epochMicros);
  return Object.freeze({
    epochMicros,
    epochMicrosText: epochMicros.toString(),
    canonicalUtc,
    sourceText: canonicalUtc,
    toJSON(): string {
      return this.canonicalUtc;
    },
  });
}

/** Parse a PG17 UTC/fixed-offset timestamptz exactly through microseconds. */
export function parsePgTimestamptz(value: string | null, bounds: TimestampBounds = {}): PgTimestamp | null {
  const field = fieldName(bounds.field);
  if (bounds.minEpochMicros !== undefined && typeof bounds.minEpochMicros !== "bigint") {
    fail("scalar_timestamp_out_of_bounds", field);
  }
  if (bounds.maxEpochMicros !== undefined && typeof bounds.maxEpochMicros !== "bigint") {
    fail("scalar_timestamp_out_of_bounds", field);
  }
  if (
    bounds.minEpochMicros !== undefined &&
    bounds.maxEpochMicros !== undefined &&
    bounds.minEpochMicros > bounds.maxEpochMicros
  ) {
    fail("scalar_timestamp_out_of_bounds", field);
  }
  if (value === null) return null;
  if (typeof value !== "string") fail("scalar_timestamp_invalid", field);
  if (/^-?infinity$/i.test(value)) fail("scalar_timestamp_nonfinite", field);
  const match = TIMESTAMP_TEXT.exec(value);
  if (!match) {
    if (/\.[0-9]{7,}/.test(value)) fail("scalar_timestamp_precision_unsupported", field);
    if (/\b(?:[A-Za-z]+|[+-]\d{2}(?::?\d{2})?(?::?\d{2})?)$/.test(value) && !/[+-]\d{2}(?::?\d{2})(?::?\d{2})?$/.test(value)) {
      fail("scalar_timestamp_timezone_ambiguous", field);
    }
    fail("scalar_timestamp_invalid", field);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  validateCivilParts(year, month, day, field);
  if (hour > 23 || minute > 59 || second > 59) fail("scalar_timestamp_invalid", field);
  const fraction = match[7] ?? "";
  if (fraction.length > 6) fail("scalar_timestamp_precision_unsupported", field);
  const micros = Number(fraction.padEnd(6, "0") || "0");
  const offsetSeconds = parseTimestampOffset(match[8], field);
  let epochMicros = BigInt(daysFromCivil(year, month, day)) * MICROS_PER_DAY;
  epochMicros += BigInt(hour) * BigInt(3_600_000_000);
  epochMicros += BigInt(minute) * BigInt(60_000_000);
  epochMicros += BigInt(second) * MICROS_PER_SECOND;
  epochMicros += BigInt(micros);
  epochMicros -= BigInt(offsetSeconds) * MICROS_PER_SECOND;
  if (
    (bounds.minEpochMicros !== undefined && epochMicros < bounds.minEpochMicros) ||
    (bounds.maxEpochMicros !== undefined && epochMicros > bounds.maxEpochMicros)
  ) {
    fail("scalar_timestamp_out_of_bounds", field);
  }
  const result = timestampFromEpochMicros(epochMicros, bounds);
  return Object.freeze({ ...result, sourceText: value });
}

export const parsePgTimestamp = parsePgTimestamptz;

export function comparePgTimestamps(left: PgTimestamp | null, right: PgTimestamp | null): -1 | 0 | 1 {
  if (left === null && right === null) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return left.epochMicros < right.epochMicros ? -1 : left.epochMicros > right.epochMicros ? 1 : 0;
}

/** A small helper for callers that need a stable JSON-safe exact integer. */
export function bigintText(value: bigint): string {
  return value.toString(10);
}
