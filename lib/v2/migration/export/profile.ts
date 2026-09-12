import { ExportError } from "../shared/redaction.ts";
import { Secret } from "../shared/secret.ts";
import { readPrivateFile } from "../shared/private-fs.ts";
import { readFile } from "node:fs/promises";
import { quoteLiteral, type WireConnection } from "./wire.ts";

/**
 * The exporter's only input channel for a credential: a 0600 JSON file the
 * operator writes by hand.
 *
 * Nothing here comes from an environment variable, a command-line argument or a
 * prompt. `--connection-file <path>` is the entire surface, so `ps` shows a path
 * and never a secret, and a shell history file cannot capture one either.
 */

export const PROFILE_ROLE_SOURCE = "source-read-only";

export type ProfileTransport = "tcp" | "unix-socket";

export type SourceIdentityExpectations = {
  /** Supabase project reference. Must appear in the host or the user. */
  projectRef: string | null;
  expectedDatabase: string;
  expectedCurrentUser: string;
  /** `pg_control_system().system_identifier`, when the operator has recorded one. */
  expectedSystemIdentifier: string | null;
  /** Schemas that must exist. A source that lacks them is the wrong database. */
  expectSchemasPresent: readonly string[];
  /** Schemas that must NOT exist. This is the destination guard. */
  expectSchemasAbsent: readonly string[];
};

export type ConnectionProfile = {
  label: string;
  transport: ProfileTransport;
  host: string;
  port: number;
  database: string;
  user: string;
  password: Secret | null;
  caCertificatesPemPath: string | null;
  identity: SourceIdentityExpectations;
};

const ALLOWED_TOP_LEVEL = new Set(["profile_version", "role", "label", "connection", "identity", "tls"]);
const ALLOWED_CONNECTION = new Set(["transport", "host", "port", "database", "user", "password"]);
const ALLOWED_IDENTITY = new Set([
  "project_ref",
  "expected_database",
  "expected_current_user",
  "expected_system_identifier",
  "expect_schemas_present",
  "expect_schemas_absent",
]);

function rejectUnknownKeys(object: Record<string, unknown>, allowed: Set<string>, where: string): void {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new ExportError(
        "profile_unknown_key",
        `Connection profile has an unrecognised key ${JSON.stringify(key)} in ${where}. A misspelled key is a silently skipped safety check, so it is refused.`,
        { key, where },
      );
    }
  }
}

function requireString(object: Record<string, unknown>, key: string, where: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ExportError(
      "profile_invalid",
      `Connection profile field ${where}.${key} must be a non-empty string.`,
      { field: `${where}.${key}` },
    );
  }
  return value;
}

function optionalString(object: Record<string, unknown>, key: string, where: string): string | null {
  const value = object[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new ExportError(
      "profile_invalid",
      `Connection profile field ${where}.${key} must be a non-empty string when present.`,
      { field: `${where}.${key}` },
    );
  }
  return value;
}

function requireStringArray(object: Record<string, unknown>, key: string, where: string): readonly string[] {
  const value = object[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new ExportError(
      "profile_invalid",
      `Connection profile field ${where}.${key} must be an array of non-empty strings.`,
      { field: `${where}.${key}` },
    );
  }
  return value as readonly string[];
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ExportError("profile_invalid", `Connection profile section ${where} must be an object.`, {
      section: where,
    });
  }
  return value as Record<string, unknown>;
}

/** Parse an already-read profile document. Split out so it is testable directly. */
export function parseConnectionProfile(text: string): ConnectionProfile {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    // The parser's own message can quote the offending line, which is the line
    // holding the password.
    throw new ExportError("profile_unparseable", "Connection profile is not valid JSON.");
  }

  const root = asObject(document, "profile");
  rejectUnknownKeys(root, ALLOWED_TOP_LEVEL, "profile");

  if (root.profile_version !== 1) {
    throw new ExportError(
      "profile_version_unsupported",
      "Connection profile must declare \"profile_version\": 1.",
    );
  }
  if (root.role !== PROFILE_ROLE_SOURCE) {
    // A profile for anything else - the v2 target, a staging mirror - is refused
    // outright rather than being connected to and checked afterwards.
    throw new ExportError(
      "profile_role_refused",
      `Connection profile role must be ${JSON.stringify(PROFILE_ROLE_SOURCE)}. This exporter only reads the legacy source.`,
      { role: typeof root.role === "string" ? root.role : "missing" },
    );
  }

  const label = requireString(root, "label", "profile");
  const connection = asObject(root.connection, "profile.connection");
  rejectUnknownKeys(connection, ALLOWED_CONNECTION, "profile.connection");

  const transport = connection.transport;
  if (transport !== "tcp" && transport !== "unix-socket") {
    throw new ExportError(
      "profile_invalid",
      'Connection profile field profile.connection.transport must be "tcp" or "unix-socket".',
    );
  }

  const host = requireString(connection, "host", "profile.connection");
  const port = connection.port;
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    throw new ExportError("profile_invalid", "Connection profile field profile.connection.port must be a port number.");
  }
  const database = requireString(connection, "database", "profile.connection");
  const user = requireString(connection, "user", "profile.connection");
  const passwordText = optionalString(connection, "password", "profile.connection");

  if (transport === "tcp" && host.startsWith("/")) {
    throw new ExportError("profile_invalid", "A tcp profile needs a hostname, not a socket path.");
  }
  if (transport === "unix-socket" && !host.startsWith("/")) {
    throw new ExportError(
      "profile_invalid",
      "A unix-socket profile needs an absolute socket directory as its host.",
    );
  }
  if (transport === "tcp" && !passwordText) {
    throw new ExportError(
      "profile_password_required",
      "A tcp profile must carry a password. An unauthenticated remote connection is not an acceptable source.",
    );
  }

  const identityRaw = asObject(root.identity, "profile.identity");
  rejectUnknownKeys(identityRaw, ALLOWED_IDENTITY, "profile.identity");
  const projectRef = optionalString(identityRaw, "project_ref", "profile.identity");

  if (transport === "tcp") {
    if (!projectRef) {
      throw new ExportError(
        "profile_project_ref_required",
        "A tcp profile must declare identity.project_ref so a wrong project fails before any row is read.",
      );
    }
    if (!host.includes(projectRef) && !user.includes(projectRef)) {
      throw new ExportError(
        "identity_project_mismatch",
        "The declared project reference appears in neither the host nor the user. Refusing to connect.",
        { project_ref: projectRef },
      );
    }
  }

  const identity: SourceIdentityExpectations = {
    projectRef,
    expectedDatabase: requireString(identityRaw, "expected_database", "profile.identity"),
    expectedCurrentUser: requireString(identityRaw, "expected_current_user", "profile.identity"),
    expectedSystemIdentifier: optionalString(identityRaw, "expected_system_identifier", "profile.identity"),
    expectSchemasPresent: requireStringArray(identityRaw, "expect_schemas_present", "profile.identity"),
    expectSchemasAbsent: requireStringArray(identityRaw, "expect_schemas_absent", "profile.identity"),
  };

  if (identity.expectSchemasAbsent.length === 0) {
    throw new ExportError(
      "profile_destination_guard_required",
      "identity.expect_schemas_absent must name at least one schema that exists only in the migration target. Without it, pointing the exporter at the target is not detectable.",
    );
  }
  const overlap = identity.expectSchemasPresent.filter((name) => identity.expectSchemasAbsent.includes(name));
  if (overlap.length > 0) {
    throw new ExportError(
      "profile_invalid",
      `Schema ${JSON.stringify(overlap[0])} is required to be both present and absent.`,
    );
  }

  const tls = root.tls === undefined ? {} : asObject(root.tls, "profile.tls");
  rejectUnknownKeys(tls, new Set(["ca_certificates_pem_path"]), "profile.tls");
  const caCertificatesPemPath = optionalString(tls, "ca_certificates_pem_path", "profile.tls");
  if (caCertificatesPemPath !== null && !caCertificatesPemPath.startsWith("/")) {
    throw new ExportError(
      "profile_invalid",
      "profile.tls.ca_certificates_pem_path must be an absolute path so certificate verification does not depend on the process working directory.",
    );
  }
  if (transport === "unix-socket" && caCertificatesPemPath !== null) {
    throw new ExportError(
      "profile_invalid",
      "profile.tls.ca_certificates_pem_path is only meaningful for a tcp profile; Unix-socket connections do not negotiate TLS.",
    );
  }

  return {
    label,
    transport,
    host,
    port: port as number,
    database,
    user,
    password: passwordText === null ? null : new Secret(passwordText, `${label} password`),
    caCertificatesPemPath,
    identity,
  };
}

/** Read the profile from a file that must itself be private. */
export async function loadConnectionProfile(path: string): Promise<ConnectionProfile> {
  const text = await readPrivateFile(path, "connection profile");
  return parseConnectionProfile(text);
}

/**
 * Load the optional trust anchor named by a TCP profile.
 *
 * CA material is public connection material, so it does not need the 0600
 * restriction used for the profile password. It is still bounded and checked
 * before it reaches Node's TLS stack: a typo or an accidentally enormous file
 * must fail as a profile error rather than becoming an unbounded allocation.
 */
export async function readCaCertificatesPem(profile: ConnectionProfile): Promise<string | undefined> {
  const path = profile.caCertificatesPemPath;
  if (path === null) return undefined;

  const MAX_CA_BUNDLE_BYTES = 1024 * 1024;
  try {
    const text = await readFile(path, { encoding: "utf8" });
    if (text.length === 0 || text.length > MAX_CA_BUNDLE_BYTES) {
      throw new ExportError(
        "tls_ca_invalid",
        "The configured CA certificate bundle is empty or larger than 1 MiB.",
      );
    }
    if (!text.includes("-----BEGIN CERTIFICATE-----")) {
      throw new ExportError(
        "tls_ca_invalid",
        "The configured CA certificate bundle contains no PEM certificate.",
      );
    }
    return text;
  } catch (error) {
    if (error instanceof ExportError) throw error;
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    throw new ExportError(
      "tls_ca_unreadable",
      `Cannot read the configured CA certificate bundle (${code}).`,
      { errno: code },
    );
  }
}

export type IdentityEvidence = {
  currentDatabase: string;
  currentUser: string;
  sessionUser: string;
  serverVersion: string;
  serverVersionNum: number;
  systemIdentifier: string | null;
  inRecovery: boolean;
  schemasPresent: readonly string[];
  transactionIsolation: string;
  transactionReadOnly: string;
  projectRef: string | null;
};

function mismatch(field: string, expected: string, actual: string): ExportError {
  return new ExportError(
    "identity_mismatch",
    `Source identity check failed: ${field} is ${JSON.stringify(actual)} but the profile declares ${JSON.stringify(expected)}. Refusing to export.`,
    { field, expected, actual },
  );
}

/**
 * Prove the connection landed on the database the operator meant, before a
 * single row is read.
 *
 * Every check fails closed. There is no "warn and continue": an export from the
 * wrong database that looks successful is worse than no export, because it is
 * the input to a migration nobody re-checks.
 */
export async function assertSourceIdentity(
  connection: WireConnection,
  identity: SourceIdentityExpectations,
): Promise<IdentityEvidence> {
  const basics = await connection.query(
    "SELECT current_database(), current_user, session_user, version(), " +
      "current_setting('server_version_num'), pg_is_in_recovery()::text",
  );
  const row = basics.rows[0] ?? [];
  const currentDatabase = row[0] ?? "";
  const currentUser = row[1] ?? "";
  const sessionUser = row[2] ?? "";
  const serverVersion = row[3] ?? "";
  const serverVersionNum = Number.parseInt(row[4] ?? "0", 10);
  const inRecovery = row[5] === "true";

  if (currentDatabase !== identity.expectedDatabase) {
    throw mismatch("current_database()", identity.expectedDatabase, currentDatabase);
  }
  if (currentUser !== identity.expectedCurrentUser) {
    throw mismatch("current_user", identity.expectedCurrentUser, currentUser);
  }

  // The strongest fingerprint available, and the one that survives a DNS change
  // or a restored copy being put behind the same hostname. It is superuser-only
  // on some deployments, so it is optional to *have* - but if the operator has
  // recorded one, being unable to read it is itself a failure.
  let systemIdentifier: string | null = null;
  try {
    const control = await connection.query("SELECT system_identifier::text FROM pg_control_system()");
    systemIdentifier = control.rows[0]?.[0] ?? null;
  } catch {
    systemIdentifier = null;
  }
  if (identity.expectedSystemIdentifier !== null) {
    if (systemIdentifier === null) {
      throw new ExportError(
        "identity_system_identifier_unreadable",
        "The profile declares an expected system identifier but this role may not read pg_control_system(). Either grant EXECUTE on it or remove the expectation deliberately.",
      );
    }
    if (systemIdentifier !== identity.expectedSystemIdentifier) {
      throw mismatch("system_identifier", identity.expectedSystemIdentifier, systemIdentifier);
    }
  }

  const wanted = [...identity.expectSchemasPresent, ...identity.expectSchemasAbsent];
  const schemaResult =
    wanted.length === 0
      ? { rows: [] as ReadonlyArray<ReadonlyArray<string | null>> }
      : await connection.query(
          `SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname IN (${wanted
            .map((name) => quoteLiteral(name))
            .join(", ")}) ORDER BY nspname`,
        );
  const found = new Set(schemaResult.rows.map((r) => r[0] ?? ""));

  for (const name of identity.expectSchemasPresent) {
    if (!found.has(name)) {
      throw new ExportError(
        "identity_schema_missing",
        `Source identity check failed: schema ${JSON.stringify(name)} does not exist here. This is not the legacy source database.`,
        { schema: name },
      );
    }
  }
  for (const name of identity.expectSchemasAbsent) {
    if (found.has(name)) {
      throw new ExportError(
        "identity_destination_detected",
        `Source identity check failed: schema ${JSON.stringify(name)} exists here, and the profile says it must not. This looks like the migration destination, not the source. Refusing to export.`,
        { schema: name },
      );
    }
  }

  const settings = await connection.query(
    "SELECT current_setting('transaction_isolation'), current_setting('transaction_read_only')",
  );

  return {
    currentDatabase,
    currentUser,
    sessionUser,
    serverVersion,
    serverVersionNum,
    systemIdentifier,
    inRecovery,
    schemasPresent: [...found].sort(),
    transactionIsolation: settings.rows[0]?.[0] ?? "",
    transactionReadOnly: settings.rows[0]?.[1] ?? "",
    projectRef: identity.projectRef,
  };
}
