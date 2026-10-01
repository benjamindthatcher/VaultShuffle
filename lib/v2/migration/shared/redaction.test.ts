import assert from "node:assert/strict";
import { Console } from "node:console";
import { Writable } from "node:stream";
import test from "node:test";
import { inspect } from "node:util";
import {
  Secret,
  clearRegisteredSecretsForTest,
  registerSecret,
  registeredSecretValues,
} from "./secret.ts";
import { ExportError, describeFailure, redact } from "./redaction.ts";

/**
 * The credential used throughout. It is synthetic, has no relationship to any
 * real VaultShuffle or Supabase credential, and is long enough to pass the
 * registry's minimum length so the last-resort masking pass applies to it.
 */
const PLAINTEXT = "hunter2-Zx9QwErTyUiOpAsDfGhJ";

function collectConsoleOutput(write: (c: Console) => void): string {
  let captured = "";
  const sink = new Writable({
    write(chunk, _encoding, done) {
      captured += String(chunk);
      done();
    },
  });
  write(new Console({ stdout: sink, stderr: sink, colorMode: false }));
  return captured;
}

test("Secret closes the four escape routes a credential actually leaks through", async (t) => {
  clearRegisteredSecretsForTest();
  const secret = new Secret(PLAINTEXT, "source password");

  await t.test("template interpolation", () => {
    const line = `connecting with ${secret}`;
    assert.ok(!line.includes(PLAINTEXT), line);
    assert.equal(line, "connecting with [redacted source password]");
  });

  await t.test("JSON.stringify of an enclosing config object", () => {
    const json = JSON.stringify({ user: "postgres", password: secret, port: 5432 });
    assert.ok(!json.includes(PLAINTEXT), json);
    assert.match(json, /"password":"\[redacted source password\]"/);
  });

  await t.test("console.log, which formats objects through util.inspect", () => {
    const output = collectConsoleOutput((c) => {
      c.log({ profile: { password: secret } });
    });
    assert.ok(!output.includes(PLAINTEXT), output);
    assert.match(output, /\[redacted source password\]/);
  });

  await t.test("util.inspect directly, at depth and on the bare value", () => {
    assert.ok(!inspect(secret).includes(PLAINTEXT));
    assert.ok(!inspect({ a: { b: { c: secret } } }, { depth: 5 }).includes(PLAINTEXT));
  });

  await t.test("String() and concatenation", () => {
    assert.ok(!String(secret).includes(PLAINTEXT));
    assert.ok(!("prefix" + secret).includes(PLAINTEXT));
    assert.ok(![secret].join(",").includes(PLAINTEXT));
  });

  await t.test("reveal() is the only way through, and label/isEmpty stay safe", () => {
    assert.equal(secret.reveal(), PLAINTEXT);
    assert.equal(secret.label, "source password");
    assert.equal(secret.isEmpty, false);
    assert.equal(new Secret("", "empty").isEmpty, true);
  });

  await t.test("no enumerable field carries the plaintext", () => {
    assert.deepEqual(Object.keys(secret), []);
    assert.deepEqual(Object.getOwnPropertyNames(secret), []);
    assert.deepEqual(Object.entries(secret), []);
    assert.ok(!inspect(Object.assign({}, secret)).includes(PLAINTEXT));
  });
});

test("constructing a Secret registers it for the last-resort masking pass", () => {
  clearRegisteredSecretsForTest();
  assert.deepEqual(registeredSecretValues(), []);
  new Secret(PLAINTEXT, "source password");
  assert.deepEqual(registeredSecretValues(), [PLAINTEXT]);
});

test("very short values are not registered, so unrelated text is not corrupted", () => {
  clearRegisteredSecretsForTest();
  registerSecret("ab");
  registerSecret("abcde");
  assert.deepEqual(registeredSecretValues(), []);
  registerSecret("abcdef");
  assert.deepEqual(registeredSecretValues(), ["abcdef"]);
  clearRegisteredSecretsForTest();
});

test("registered values are masked longest first", () => {
  clearRegisteredSecretsForTest();
  registerSecret("alpha-secret");
  registerSecret("alpha-secret-and-more");
  assert.deepEqual(registeredSecretValues(), ["alpha-secret-and-more", "alpha-secret"]);
  assert.equal(redact("value alpha-secret-and-more here"), "value [redacted] here");
  clearRegisteredSecretsForTest();
});

test("redact removes a credential a driver quoted back at us verbatim", () => {
  clearRegisteredSecretsForTest();
  new Secret(PLAINTEXT, "source password");
  const driverMessage = `FATAL: password authentication failed (tried "${PLAINTEXT}")`;
  const safe = redact(driverMessage);
  assert.ok(!safe.includes(PLAINTEXT), safe);
  assert.match(safe, /\[redacted\]/);
  clearRegisteredSecretsForTest();
});

test("redact masks URI userinfo, including an unencoded @ in the password", () => {
  clearRegisteredSecretsForTest();
  assert.equal(
    redact("postgresql://postgres:s3cr3tpw@db.example.supabase.co:5432/postgres"),
    "postgresql://[redacted]@db.example.supabase.co:5432/postgres",
  );
  // A password containing a literal @ must not leave its tail behind.
  const leaky = redact("postgres://postgres:p@sswordtail@db.example.com/postgres");
  assert.ok(!leaky.includes("sswordtail"), leaky);
  assert.equal(leaky, "postgres://[redacted]@db.example.com/postgres");
});

test("redact masks keyed secrets in the shapes they are actually written", () => {
  const cases: ReadonlyArray<readonly [string, RegExp]> = [
    ["PGPASSWORD=abc123xyz", /^PGPASSWORD=\[redacted\]$/],
    ["password = 'abc123xyz'", /^password=\[redacted\]$/],
    ['token: "abc123xyz"', /^token=\[redacted\]$/],
    ["service_role=abc123xyz", /^service_role=\[redacted\]$/],
    // The token after "Bearer" must go too; consuming only the word "Bearer"
    // as the value leaves the credential itself in the line.
    ["Authorization: Bearer abc123xyz", /^Authorization=\[redacted\]$/],
    ["authorization: Basic YWJjOmRlZg==", /^authorization=\[redacted\]$/],
  ];
  for (const [input, expected] of cases) {
    const safe = redact(input);
    assert.match(safe, expected, `input: ${input}`);
  }
});

test("redact masks JWTs, Supabase key prefixes, long hex digests and emails", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsInJlZiI6Inh4In0.c2lnbmF0dXJlLXZhbHVl";
  assert.equal(redact(`key ${jwt} end`), "key [redacted] end");
  assert.equal(redact("sb_secret_AbCdEfGhIjKl"), "[redacted]");
  assert.equal(redact("sb_publishable_AbCdEfGhIjKl"), "[redacted]");
  assert.equal(redact(`digest ${"a".repeat(64)}`), "digest [redacted-hex]");
  assert.equal(redact("owner ada@example.com filed it"), "owner [redacted-email] filed it");
});

test("redact truncates so an oversized driver blob cannot flood a log", () => {
  const safe = redact("x".repeat(5000));
  assert.ok(safe.length < 2100, String(safe.length));
  assert.match(safe, /… \[truncated\]$/);
});

test("redact accepts non-strings without throwing", () => {
  assert.equal(redact(null), "null");
  assert.equal(redact(undefined), "undefined");
  assert.equal(redact(42), "42");
});

test("an ExportError never carries a credential in its message or details", () => {
  clearRegisteredSecretsForTest();
  const secret = new Secret(PLAINTEXT, "source password");
  const error = new ExportError(
    "connect_failed",
    `could not connect using ${secret.reveal()}`,
    { dsn: `postgresql://postgres:${secret.reveal()}@db.example.supabase.co/postgres`, attempt: 2 },
  );

  assert.ok(!error.message.includes(PLAINTEXT), error.message);
  assert.ok(!JSON.stringify(error.details).includes(PLAINTEXT));
  assert.ok(!JSON.stringify(error).includes(PLAINTEXT));
  assert.ok(!inspect(error).includes(PLAINTEXT));
  assert.ok(!String(error).includes(PLAINTEXT));
  assert.equal(error.details.attempt, 2);
  assert.equal(error.code, "connect_failed");
  assert.ok(Object.isFrozen(error.details));

  const consoleOutput = collectConsoleOutput((c) => {
    c.error(`export failed: ${error.message}`);
    c.log(error.toJSON());
  });
  assert.ok(!consoleOutput.includes(PLAINTEXT), consoleOutput);
  clearRegisteredSecretsForTest();
});

test("describeFailure sanitizes anything thrown, and drops stacks", () => {
  clearRegisteredSecretsForTest();
  new Secret(PLAINTEXT, "source password");

  const exportError = new ExportError("identity_mismatch", "wrong project");
  assert.deepEqual(describeFailure(exportError), {
    code: "identity_mismatch",
    message: "wrong project",
  });

  const errno: NodeJS.ErrnoException = new Error(`connect ECONNREFUSED using ${PLAINTEXT}`);
  errno.code = "ECONNREFUSED";
  const described = describeFailure(errno);
  assert.equal(described.code, "node.ECONNREFUSED");
  assert.ok(!described.message.includes(PLAINTEXT), described.message);
  assert.ok(!Object.hasOwn(described, "stack"));

  const plain = describeFailure(new Error("plain failure"));
  assert.deepEqual(plain, { code: "unexpected_error", message: "plain failure" });

  const thrownString = describeFailure(`raw throw carrying ${PLAINTEXT}`);
  assert.equal(thrownString.code, "unexpected_error");
  assert.ok(!thrownString.message.includes(PLAINTEXT));
  clearRegisteredSecretsForTest();
});
