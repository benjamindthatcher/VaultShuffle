import assert from "node:assert/strict";
import test from "node:test";
import {
  comparePgDecimals,
  comparePgTimestamps,
  isLeapYear,
  parseCivilDate,
  parsePgDecimal,
  parsePgInteger,
  parsePgTimestamptz,
  ScalarError,
  timestampFromEpochMicros,
} from "./scalars.ts";

function throwsCode(action: () => unknown, code: string, sentinel?: string): void {
  assert.throws(
    action,
    (error: unknown) => {
      assert.ok(error instanceof ScalarError);
      assert.equal(error.code, code);
      if (sentinel) {
        assert.doesNotMatch(error.message, new RegExp(sentinel));
        assert.doesNotMatch(JSON.stringify(error), new RegExp(sentinel));
      }
      return true;
    },
  );
}

test("integer parsing keeps values beyond JavaScript safe integer exact", () => {
  assert.equal(parsePgInteger("9007199254740993"), BigInt("9007199254740993"));
  assert.equal(parsePgInteger("-9223372036854775808", { minInclusive: BigInt("-9223372036854775808") }), BigInt("-9223372036854775808"));
  assert.equal(parsePgInteger(null), null);
  throwsCode(() => parsePgInteger("9223372036854775808", { maxInclusive: BigInt("9223372036854775807") }), "scalar_integer_overflow");
  throwsCode(() => parsePgInteger("9007199254740993x"), "scalar_integer_invalid", "9007199254740993x");
});

test("epoch-microsecond construction uses civil arithmetic across the Unix epoch and rejects years outside the accepted scalar range", () => {
  const beforeEpoch = parsePgTimestamptz("1969-12-31 23:59:59.999999+00")!;
  assert.equal(timestampFromEpochMicros(beforeEpoch.epochMicros).canonicalUtc, "1969-12-31T23:59:59.999999Z");
  const rollover = parsePgTimestamptz("1969-12-31 23:59:59.999999+00")!.epochMicros + BigInt(1);
  assert.equal(timestampFromEpochMicros(rollover).canonicalUtc, "1970-01-01T00:00:00.000000Z");
  const finalDay = parsePgTimestamptz("9999-12-31 23:59:59.999999+00")!.epochMicros;
  throwsCode(() => timestampFromEpochMicros(finalDay + BigInt(1)), "scalar_civil_date_out_of_bounds");
});

test("decimal parsing and comparison do not pass through Number", () => {
  const large = parsePgDecimal("9007199254740993.125e+3");
  assert.ok(large);
  assert.equal(large.toCanonicalString(), "9007199254740993125");
  assert.equal(large.sourceText, "9007199254740993.125e+3");
  assert.equal(JSON.stringify(large), '"9007199254740993125"');
  assert.equal(comparePgDecimals(parsePgDecimal("1.20")!, parsePgDecimal("1.2")!), 0);
  assert.equal(comparePgDecimals(parsePgDecimal("-2")!, parsePgDecimal("-3")!), 1);
  assert.equal(parsePgDecimal("12", { minInclusive: "12", maxInclusive: "12" })?.toCanonicalString(), "12");
  assert.equal(parsePgDecimal(null), null);
  throwsCode(() => parsePgDecimal("NaN"), "scalar_decimal_nonfinite");
  throwsCode(() => parsePgDecimal("Infinity"), "scalar_decimal_nonfinite");
  throwsCode(() => parsePgDecimal("1e100000"), "scalar_decimal_scale_out_of_bounds");
  throwsCode(() => parsePgDecimal("9007199254740993", { maxDigits: 10 }), "scalar_decimal_digits_out_of_bounds");
  throwsCode(() => parsePgDecimal("100", { maxInclusive: "99" }), "scalar_decimal_out_of_bounds", "100");
});

test("decimal signs, fractions, zero and signed bounds match independent values", () => {
  const signedFraction = parsePgDecimal("-.125e+2")!;
  assert.equal(signedFraction.sign, -1);
  assert.equal(signedFraction.toCanonicalString(), "-12.5");
  assert.equal(parsePgDecimal("+12.50")?.toCanonicalString(), "12.50");
  const signedZero = parsePgDecimal("-0.000")!;
  assert.equal(signedZero.sign, 0);
  assert.equal(signedZero.toCanonicalString(), "0");

  assert.equal(comparePgDecimals(parsePgDecimal("-0.1")!, parsePgDecimal("0")!), -1);
  assert.equal(comparePgDecimals(parsePgDecimal("-2.50")!, parsePgDecimal("-2.5")!), 0);
  assert.equal(comparePgDecimals(parsePgDecimal("100.00")!, parsePgDecimal("99.999")!), 1);
  assert.equal(parsePgDecimal("-12.5", { minInclusive: "-12.5", maxInclusive: "12.5" })?.toCanonicalString(), "-12.5");
  assert.equal(parsePgDecimal("0", { minInclusive: "0", maxInclusive: "0" })?.toCanonicalString(), "0");
  throwsCode(() => parsePgDecimal("-12.5001", { minInclusive: "-12.5" }), "scalar_decimal_out_of_bounds");
  throwsCode(() => parsePgDecimal("12.5001", { maxInclusive: "12.5" }), "scalar_decimal_out_of_bounds");
});

test("timestamptz parsing preserves microseconds and compares equivalent UTC forms", () => {
  const first = parsePgTimestamptz("2026-09-10 00:00:00.000001+00")!;
  const second = parsePgTimestamptz("2026-09-10T00:00:00.001000Z")!;
  const equivalent = parsePgTimestamptz("2026-09-10 01:00:00.000001+01:00")!;
  assert.equal(comparePgTimestamps(first, second), -1);
  assert.equal(first.epochMicrosText, equivalent.epochMicrosText);
  assert.equal(first.canonicalUtc, equivalent.canonicalUtc);
  assert.equal(first.sourceText, "2026-09-10 00:00:00.000001+00");
  assert.equal(JSON.stringify(first), '"2026-09-10T00:00:00.000001Z"');
  assert.equal(parsePgTimestamptz(null), null);
  throwsCode(() => parsePgTimestamptz("2026-09-10 00:00:00.1234567+00"), "scalar_timestamp_precision_unsupported");
  throwsCode(() => parsePgTimestamptz("infinity"), "scalar_timestamp_nonfinite");
  throwsCode(() => parsePgTimestamptz("2026-09-10 00:00:00"), "scalar_timestamp_timezone_missing");
  throwsCode(() => parsePgTimestamptz("2026-09-10 00:00:00 Europe/Dublin"), "scalar_timestamp_timezone_ambiguous");
  throwsCode(() => parsePgTimestamptz("2026-09-10 00:00:00.000001+24:00"), "scalar_timestamp_offset_out_of_bounds");
});

test("timestamp boundaries preserve pre-epoch micros, leap days and UTC crossings", () => {
  const beforeEpoch = parsePgTimestamptz("1969-12-31 23:59:59.999999Z")!;
  assert.equal(beforeEpoch.epochMicrosText, "-1");
  assert.equal(beforeEpoch.canonicalUtc, "1969-12-31T23:59:59.999999Z");

  const yearBoundary = parsePgTimestamptz("2000-01-01 00:00:00.000000+00")!;
  assert.equal(yearBoundary.epochMicrosText, "946684800000000");
  const offsetAcrossYear = parsePgTimestamptz("1999-12-31 19:00:00.000000-05:00")!;
  assert.equal(offsetAcrossYear.epochMicrosText, "946684800000000");
  const firstMicrosecond = parsePgTimestamptz("2000-01-01 00:00:00.000001+00")!;
  assert.equal(firstMicrosecond.epochMicrosText, "946684800000001");
  assert.equal(comparePgTimestamps(yearBoundary, firstMicrosecond), -1);

  const leapDayUtc = parsePgTimestamptz("2024-03-01 00:30:00+01:00")!;
  assert.equal(leapDayUtc.canonicalUtc, "2024-02-29T23:30:00.000000Z");
});

test("civil dates validate leap boundaries without Date", () => {
  assert.equal(isLeapYear(2024), true);
  assert.equal(isLeapYear(1900), false);
  assert.equal(isLeapYear(2000), true);
  assert.equal(isLeapYear(0), false);
  assert.equal(parseCivilDate("2024-02-29")?.toIsoString(), "2024-02-29");
  assert.equal(parseCivilDate("2023-02-28")?.toIsoString(), "2023-02-28");
  assert.equal(parseCivilDate("2000-02-29")?.toIsoString(), "2000-02-29");
  assert.equal(parseCivilDate(null), null);
  throwsCode(() => parseCivilDate("2023-02-29"), "scalar_civil_date_invalid");
  throwsCode(() => parseCivilDate("1900-02-29"), "scalar_civil_date_invalid");
  throwsCode(() => parseCivilDate("0000-01-01"), "scalar_civil_date_out_of_bounds");
  throwsCode(() => parseCivilDate("2024-02-29 00:00:00"), "scalar_civil_date_invalid");
});
