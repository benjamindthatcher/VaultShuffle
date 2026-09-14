#!/usr/bin/env node
/**
 * Creates the exporter's existing private connection profile from Supabase's
 * temporary, explicitly read-only CLI-login API response.
 *
 * This tool has no default action. Creating a login role changes source
 * authentication state, so the caller must supply the confirmation flag after
 * the coordinator has approved that exact operation.
 */
import { lstat, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export const SOURCE_PROJECT_REF = "pfvblcopcmairdfeqdep";
export const SOURCE_DIRECT_HOST = `db.${SOURCE_PROJECT_REF}.supabase.co`;
const LOGIN_ROLE_URL = `https://api.supabase.com/v1/projects/${SOURCE_PROJECT_REF}/cli/login-role`;

const USAGE = `Usage:
  node scripts/migration/prepare-readonly-export-profile.mjs \\
    --approve-source-login-creation \\
    --management-token-file <existing-0600-token-file> \\
    --profile-path <new-0600-profile.json> \\
    [--label <operator-label>] [--ca-certificates-pem-path <absolute-pem-path>]

Creates one temporary Supabase login role with {"read_only":true} and writes
the existing exporter profile format. This operation contacts the source
management API and changes source authentication state; it is intentionally not
run until the coordinator has explicitly approved it.
`;

function failure(message) {
  throw new Error(message);
}

function requiredValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) failure(`Argument ${flag} needs a value.`);
  return value;
}

export function parseArgs(args) {
  const result = {
    approved: false,
    tokenFile: undefined,
    profilePath: undefined,
    label: "VaultShuffle production source temporary read-only export",
    caCertificatesPemPath: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    switch (flag) {
      case "--approve-source-login-creation":
        result.approved = true;
        break;
      case "--management-token-file":
        result.tokenFile = requiredValue(args, index, flag);
        index += 1;
        break;
      case "--profile-path":
        result.profilePath = requiredValue(args, index, flag);
        index += 1;
        break;
      case "--label":
        result.label = requiredValue(args, index, flag);
        index += 1;
        break;
      case "--ca-certificates-pem-path":
        result.caCertificatesPemPath = requiredValue(args, index, flag);
        index += 1;
        break;
      case "--help":
        return { help: true };
      default:
        // Do not reflect unknown input: it might be a mistakenly supplied token.
        failure("Unrecognised argument. Use --help for usage.");
    }
  }
  if (!result.approved) failure("Source-login creation needs --approve-source-login-creation.");
  if (!result.tokenFile) failure("Argument --management-token-file is required.");
  if (!result.profilePath) failure("Argument --profile-path is required.");
  if (result.caCertificatesPemPath && !isAbsolute(result.caCertificatesPemPath)) {
    failure("Argument --ca-certificates-pem-path must be an absolute path.");
  }
  return result;
}

async function requirePrivateRegularFile(path, description) {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    failure(`${description} is unavailable.`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    failure(`${description} must be a regular owner-only file.`);
  }
}

async function requirePrivateDirectory(path) {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    failure("Profile parent directory is unavailable.");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    failure("Profile parent directory must be owner-only.");
  }
}

async function requireMissingPath(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    failure("Profile path could not be inspected.");
  }
  failure("Profile path already exists; refusing to replace it.");
}

export function parseLoginRoleResponse(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failure("Login-role response has an invalid shape.");
  }
  const response = value;
  if (
    typeof response.role !== "string" || response.role.length === 0 ||
    typeof response.password !== "string" || response.password.length === 0 ||
    !Number.isSafeInteger(response.ttl_seconds) || response.ttl_seconds <= 0
  ) {
    failure("Login-role response is missing its role, password, or positive TTL.");
  }
  return { role: response.role, password: response.password, ttlSeconds: response.ttl_seconds };
}

export function buildProfile({ role, password }, options) {
  const profile = {
    profile_version: 1,
    role: "source-read-only",
    label: options.label,
    connection: {
      transport: "tcp",
      host: SOURCE_DIRECT_HOST,
      port: 5432,
      database: "postgres",
      user: role,
      password,
      // Supabase grants this existing BYPASSRLS/SELECT-only role to generated
      // read-only logins with INHERIT disabled. The exporter verifies that
      // membership, its attributes and complete public privileges before COPY.
      activate_role: "supabase_read_only_user",
    },
    identity: {
      project_ref: SOURCE_PROJECT_REF,
      expected_database: "postgres",
      expected_current_user: role,
      expect_schemas_present: ["public"],
      expect_schemas_absent: ["app"],
    },
  };
  if (options.caCertificatesPemPath) {
    profile.tls = { ca_certificates_pem_path: options.caCertificatesPemPath };
  }
  return profile;
}

async function createProfile(options) {
  const tokenPath = resolve(options.tokenFile);
  const profilePath = resolve(options.profilePath);
  await requirePrivateRegularFile(tokenPath, "Management token file");
  await requirePrivateDirectory(dirname(profilePath));
  // Fail before the source-authentication change if the operator selected a
  // target that cannot be created exclusively.
  await requireMissingPath(profilePath);

  const token = (await readFile(tokenPath, "utf8")).trim();
  if (!token) failure("Management token file is empty.");

  let response;
  try {
    response = await fetch(LOGIN_ROLE_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ read_only: true }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    failure("The source login-role request did not complete.");
  }
  if (response.status !== 201) {
    failure(`The source login-role request was refused (HTTP ${response.status}).`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    failure("The source login-role response was not valid JSON.");
  }
  const login = parseLoginRoleResponse(payload);
  const profile = `${JSON.stringify(buildProfile(login, options), null, 2)}\n`;

  let handle;
  try {
    handle = await open(profilePath, "wx", 0o600);
    await handle.writeFile(profile, "utf8");
    await handle.chmod(0o600);
  } catch {
    failure("The private exporter profile could not be created; no profile was replaced.");
  } finally {
    await handle?.close();
  }
  return { profilePath, ttlSeconds: login.ttlSeconds };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  const result = await createProfile(options);
  // The role and password are intentionally absent. TTL is API-provided, not inferred.
  process.stdout.write(`${JSON.stringify({ status: "profile_created", profile_path: result.profilePath, ttl_seconds: result.ttlSeconds })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Profile preparation failed."}\n`);
    process.exitCode = 1;
  });
}
