import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createDatabaseClient, type DatabaseClient } from "../db/client.ts";
import { parseDatabaseConfig } from "../db/config.ts";
import { DatabaseUnavailableError } from "../db/errors.ts";
import { SessionRepository } from "./session-core.ts";

const PG_BIN = join(process.cwd(), "node_modules/.cache/vaultshuffle-pg17-20260910/bin");
const MIGRATION = join(process.cwd(), "database/v2/supabase/migrations/20260906093036_m1_private_foundation.sql");
const TOUCH_MIGRATION = join(process.cwd(), "database/v2/supabase/migrations/20260913191021_m4_manual_session_touch.sql");
const SECRET = "m4-private-fixture-secret";
const MANUAL_TOKEN = "manual.fixture-session";
const VERIFIED_TOKEN = "fixture-verified-session";
const EXPIRED_TOKEN = "manual.fixture-expired";
const REVOKED_TOKEN = "manual.fixture-revoked";
const WRONG_KIND_TOKEN = "manual.fixture-wrong-kind";

type Fixture = {
  root: string;
  socket: string;
  port: number;
  database: DatabaseClient;
  repository: SessionRepository;
};

test("M4 database configuration is injected, bounded, and verifies TCP TLS", async () => {
  const config = parseDatabaseConfig({
    connectionString: "postgres://runtime@example.test/vault_m4?sslmode=disable",
    tlsCaPem: "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----",
  });
  assert.equal(config.maxConnections, 4);
  const client = createDatabaseClient(config);
  assert.equal(client.sql.options.max, 4);
  assert.equal(client.sql.options.prepare, false);
  assert.deepEqual(client.sql.options.ssl, {
    rejectUnauthorized: true,
    ca: "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----",
  });
  await client.close();
  assert.throws(
    () => parseDatabaseConfig({ connectionString: "postgres://runtime@example.test/vault_m4", maxConnections: 6 }),
    /max connections/
  );
  assert.throws(
    () => parseDatabaseConfig({ connectionString: "postgres://runtime@example.test/vault_m4", tlsCaPem: "fixture" }),
    /TLS CA/
  );
});

function command(binary: string, args: readonly string[]): void {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    timeout: 30_000,
    env: { LC_ALL: "C", PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`local PostgreSQL command failed: ${binary}; ${result.stderr.trim()}`);
  }
}

function psql(fixture: Fixture, query: string, tuples = false): string {
  const args = ["-X", "-q", "-w", "-v", "ON_ERROR_STOP=1", "-h", fixture.socket, "-p", String(fixture.port), "-U", "vault_m4_admin", "-d", "vault_m4"];
  if (tuples) args.push("-A", "-t");
  args.push("-c", query);
  const result = spawnSync(join(PG_BIN, "psql"), args, {
    encoding: "utf8",
    timeout: 30_000,
    env: { LC_ALL: "C", PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv,
  });
  if (result.status !== 0 || result.error) throw new Error("local PostgreSQL fixture SQL failed");
  return result.stdout.trim();
}

function digest(token: string): string {
  return createHmac("sha256", SECRET).update(token).digest("hex");
}

function createFixture(): Fixture {
  // PostgreSQL limits Unix socket filenames to 103 bytes on macOS. `/tmp`
  // stays short while os.tmpdir() expands to a longer per-user directory.
  const root = mkdtempSync("/tmp/vaultshuffle-m4-session-");
  const data = join(root, "data");
  const socket = join(root, "socket");
  const port = 56_000 + (process.pid % 2_000);
  mkdirSync(socket);
  command(join(PG_BIN, "initdb"), ["-D", data, "-A", "trust", "-U", "vault_m4_admin"]);
  command(join(PG_BIN, "pg_ctl"), ["-D", data, "-l", join(root, "postgres.log"), "-o", `-F -k ${socket} -p ${port}`, "-w", "start"]);

  const seedFixture = { root, socket, port } as Fixture;
  try {
    command(join(PG_BIN, "createdb"), ["-h", socket, "-p", String(port), "-U", "vault_m4_admin", "vault_m4"]);
    command(join(PG_BIN, "psql"), ["-X", "-q", "-w", "-v", "ON_ERROR_STOP=1", "-h", socket, "-p", String(port), "-U", "vault_m4_admin", "-d", "vault_m4", "-f", MIGRATION]);
    command(join(PG_BIN, "psql"), ["-X", "-q", "-w", "-v", "ON_ERROR_STOP=1", "-h", socket, "-p", String(port), "-U", "vault_m4_admin", "-d", "vault_m4", "-f", TOUCH_MIGRATION]);
    psql(seedFixture, "create role vault_session_runtime login; grant vault_app to vault_session_runtime with inherit true, set false;");
    psql(seedFixture, [
      "insert into app.accounts(id, public_id, account_kind, display_name) overriding system value values",
      "(1, '11111111-1111-4111-8111-111111111111', 'manual', 'M4 Manual'),",
      "(2, '22222222-2222-4222-8222-222222222222', 'steam', 'M4 Steam');",
      "insert into app.steam_profiles(account_id, steam_id, verified, display_name) values",
      "(1, 76561198000000001, false, 'M4 Manual'),",
      "(2, 76561198000000002, true, 'M4 Steam');",
      "insert into app.sessions(id, account_id, token_digest, session_kind, created_at, last_seen_at, expires_at, revoked_at) overriding system value values",
      `(1001, 1, decode('${digest(MANUAL_TOKEN)}', 'hex'), 'manual', statement_timestamp() - interval '2 hours', statement_timestamp() - interval '2 hours', statement_timestamp() + interval '1 day', null),`,
      `(1002, 2, decode('${digest(VERIFIED_TOKEN)}', 'hex'), 'verified_steam', statement_timestamp() - interval '2 hours', statement_timestamp() - interval '2 hours', statement_timestamp() + interval '1 day', null),`,
      `(1003, 1, decode('${digest(EXPIRED_TOKEN)}', 'hex'), 'manual', statement_timestamp() - interval '2 days', statement_timestamp() - interval '2 days', statement_timestamp() - interval '1 hour', null),`,
      `(1004, 1, decode('${digest(REVOKED_TOKEN)}', 'hex'), 'manual', statement_timestamp() - interval '2 days', statement_timestamp() - interval '2 days', statement_timestamp() + interval '1 day', statement_timestamp() - interval '1 hour'),`,
      `(1005, 2, decode('${digest(WRONG_KIND_TOKEN)}', 'hex'), 'manual', statement_timestamp() - interval '2 hours', statement_timestamp() - interval '2 hours', statement_timestamp() + interval '1 day', null);`,
    ].join("\n"));
    const database = createDatabaseClient(parseDatabaseConfig({
      connectionString: `postgres://vault_session_runtime@localhost:${port}/vault_m4`,
      socketPath: socket,
      maxConnections: 1,
    }));
    return { root, socket, port, database, repository: new SessionRepository(database) };
  } catch (error) {
    command(join(PG_BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function disposeFixture(fixture: Fixture): Promise<void> {
  await fixture.database.close();
  command(join(PG_BIN, "pg_ctl"), ["-D", join(fixture.root, "data"), "-m", "immediate", "-w", "stop"]);
  rmSync(fixture.root, { recursive: true, force: true });
}

test("M4 session repository preserves resolver, renewal, tenant, and pool contracts", async (t) => {
  const fixture = createFixture();
  t.after(async () => disposeFixture(fixture));

  const manual = await fixture.repository.resolveCookie(MANUAL_TOKEN, SECRET);
  const verified = await fixture.repository.resolveCookie(VERIFIED_TOKEN, SECRET);
  assert.ok(manual);
  assert.ok(verified);
  assert.equal(manual.principal.accountId, 1);
  assert.equal(manual.principal.accountKind, "manual");
  assert.equal(manual.principal.identityVerified, false);
  assert.equal(verified.principal.accountId, 2);
  assert.equal(verified.principal.accountKind, "steam");
  assert.equal(verified.principal.identityVerified, true);
  assert.ok(Date.parse(manual.expiresAt) > Date.now() + 364 * 24 * 60 * 60 * 1000);
  assert.ok(Date.parse(verified.expiresAt) < Date.now() + 2 * 24 * 60 * 60 * 1000);

  const firstManualLastSeen = psql(fixture, `select last_seen_at::text from app.sessions where id = 1001`, true);
  const secondManual = await fixture.repository.resolveCookie(MANUAL_TOKEN, SECRET);
  assert.ok(secondManual);
  assert.equal(secondManual.expiresAt, manual.expiresAt);
  assert.equal(psql(fixture, "select last_seen_at::text from app.sessions where id = 1001", true), firstManualLastSeen);

  // The complete manual prefix is HMAC input: the same suffix is not a session.
  assert.equal(await fixture.repository.resolveCookie("fixture-session", SECRET), null);
  assert.equal(await fixture.repository.resolveCookie(EXPIRED_TOKEN, SECRET), null);
  assert.equal(await fixture.repository.resolveCookie(REVOKED_TOKEN, SECRET), null);
  assert.equal(await fixture.repository.resolveCookie(WRONG_KIND_TOKEN, SECRET), null);

  const directTouch = async (token: string, sessionId: string | number) => fixture.database.withPrincipal(manual.principal, async (tx) =>
    tx<{ expires_at: string }[]>`select expires_at from app.touch_manual_session(${Buffer.from(digest(token), "hex")}, ${String(sessionId)})`
  );
  assert.equal((await directTouch("manual.wrong-digest", manual.principal.sessionId)).length, 0);
  assert.equal((await directTouch(MANUAL_TOKEN, 999_999)).length, 0);
  assert.equal((await directTouch(VERIFIED_TOKEN, 1002)).length, 0);
  assert.equal((await directTouch(EXPIRED_TOKEN, 1003)).length, 0);
  assert.equal((await directTouch(REVOKED_TOKEN, 1004)).length, 0);
  psql(fixture, "update app.accounts set lifecycle_status = 'merged' where id = 1");
  assert.equal((await directTouch(MANUAL_TOKEN, manual.principal.sessionId)).length, 0);

  // The runtime credential has vault_app membership only. It cannot read raw
  // session rows, while the narrowly granted SECURITY DEFINER resolver can.
  await assert.rejects(() => fixture.database.sql`select id from app.sessions`, Error);
  const nonOwnerRows = await fixture.database.withPrincipal(manual.principal, async (tx) =>
    tx<{ id: number }[]>`select id from app.accounts where id = ${verified.principal.accountId}`
  );
  assert.equal(nonOwnerRows.length, 0);

  const committedContext = await fixture.database.withPrincipal(manual.principal, async (tx) =>
    tx<{ account_id: string }[]>`select current_setting('app.account_id', true) as account_id`
  );
  assert.equal(committedContext[0]?.account_id, "1");
  await assert.rejects(
    () => fixture.database.withPrincipal(manual.principal, async () => { throw new Error("fixture rollback"); }),
    /fixture rollback/
  );
  const afterRollback = await fixture.database.sql<{ account_id: string }[]>`
    select coalesce(current_setting('app.account_id', true), '') as account_id
  `;
  assert.equal(afterRollback[0]?.account_id, "");

});

test("M4 session repository distinguishes database failure from an absent session", async () => {
  const absentClient = {
    sql: async () => [],
    withPrincipal: async () => undefined,
    close: async () => {},
  } as unknown as DatabaseClient;
  const failedClient = {
    sql: async () => { throw new Error("fixture database unavailable"); },
    withPrincipal: async () => undefined,
    close: async () => {},
  } as unknown as DatabaseClient;
  assert.equal(await new SessionRepository(absentClient).resolveCookie(MANUAL_TOKEN, SECRET), null);
  await assert.rejects(
    () => new SessionRepository(failedClient).resolveCookie(MANUAL_TOKEN, SECRET),
    DatabaseUnavailableError
  );
});
