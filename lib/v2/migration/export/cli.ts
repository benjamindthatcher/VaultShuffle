import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ExportError, describeFailure } from "../shared/redaction.ts";
import { assertNoCredentialInProcessArguments, runExport } from "./run.ts";
import { loadExportPlanFromInventoryFile } from "./plan.ts";
import { loadConnectionProfile } from "./profile.ts";

/**
 * Deliberately opt-in command line wrapper for a real source export.
 *
 * The only argument that can carry authentication material is
 * `--connection-file`, whose value is a path to a private profile. There is no
 * password, DSN or connection-string option. A second explicit confirmation
 * flag is required so a copied command cannot start a source read by itself.
 */

const DEFAULT_INVENTORY = "database/v2/source-schema-inventory-20260909.json";

export const EXPORT_CLI_USAGE = `Usage:
  node --experimental-strip-types lib/v2/migration/export/cli.ts \\
    --confirm-read-only-source \\
    --connection-file <0600-profile.json> \\
    --output-root <existing-0700-directory> \\
    [--inventory <schema-inventory.json>] \\
    [--schema public] [--include relation_a,relation_b] \\
    [--code-revision <revision>] [--connect-timeout-ms <ms>] \\
    [--statement-timeout-ms <ms>] [--allow-inside-git-worktree]

The profile supplies the source identity, read-only role, transport and password.
The password is never accepted as an argument or environment variable. TCP
profiles use TLS with certificate verification; a TCP profile may name a CA PEM
bundle with tls.ca_certificates_pem_path.
`;

type ParsedCliOptions = {
  connectionFile: string;
  outputRoot: string;
  inventory: string;
  schema: string;
  include: readonly string[] | undefined;
  codeRevision: string | null;
  connectTimeoutMs: number | undefined;
  statementTimeoutMs: number | undefined;
  allowInsideGitWorktree: boolean;
};

function cliError(code: string, message: string): ExportError {
  return new ExportError(code, message);
}

function requiredValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw cliError("cli_argument_missing", `Argument ${flag} needs a value.`);
  }
  return value;
}

function positiveMilliseconds(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 24 * 60 * 60 * 1000) {
    throw cliError("cli_argument_invalid", `Argument ${flag} must be a whole number of milliseconds from 1 to 86400000.`);
  }
  return parsed;
}

export function parseExportCliArgs(args: readonly string[]): ParsedCliOptions {
  let confirmed = false;
  let connectionFile: string | undefined;
  let outputRoot: string | undefined;
  let inventory = DEFAULT_INVENTORY;
  let schema = "public";
  let include: readonly string[] | undefined;
  let codeRevision: string | null = null;
  let connectTimeoutMs: number | undefined;
  let statementTimeoutMs: number | undefined;
  let allowInsideGitWorktree = false;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    switch (flag) {
      case "--confirm-read-only-source":
        confirmed = true;
        break;
      case "--connection-file":
        connectionFile = requiredValue(args, index, flag);
        index += 1;
        break;
      case "--output-root":
        outputRoot = requiredValue(args, index, flag);
        index += 1;
        break;
      case "--inventory":
        inventory = requiredValue(args, index, flag);
        index += 1;
        break;
      case "--schema":
        schema = requiredValue(args, index, flag);
        index += 1;
        break;
      case "--include": {
        const raw = requiredValue(args, index, flag);
        const names = raw.split(",").map((name) => name.trim()).filter((name) => name.length > 0);
        if (names.length === 0) throw cliError("cli_argument_invalid", "Argument --include must name at least one relation.");
        include = names;
        index += 1;
        break;
      }
      case "--code-revision":
        codeRevision = requiredValue(args, index, flag);
        index += 1;
        break;
      case "--connect-timeout-ms":
        connectTimeoutMs = positiveMilliseconds(requiredValue(args, index, flag), flag);
        index += 1;
        break;
      case "--statement-timeout-ms":
        statementTimeoutMs = positiveMilliseconds(requiredValue(args, index, flag), flag);
        index += 1;
        break;
      case "--allow-inside-git-worktree":
        allowInsideGitWorktree = true;
        break;
      case "--help":
        throw cliError("cli_help", EXPORT_CLI_USAGE);
      default:
        // Do not echo the unknown token. A user who accidentally supplies a
        // password flag must not see its value reflected in a diagnostic.
        throw cliError("cli_argument_unknown", "Unrecognised command-line argument. Use --help for usage.");
    }
  }

  if (!confirmed) {
    throw cliError(
      "cli_confirmation_required",
      "This exporter is opt-in. Repeat the command with --confirm-read-only-source after reviewing the source profile and output root.",
    );
  }
  if (!connectionFile) throw cliError("cli_argument_missing", "Argument --connection-file is required.");
  if (!outputRoot) throw cliError("cli_argument_missing", "Argument --output-root is required.");

  return {
    connectionFile,
    outputRoot,
    inventory,
    schema,
    include,
    codeRevision,
    connectTimeoutMs,
    statementTimeoutMs,
    allowInsideGitWorktree,
  };
}

export type ExportCliResult =
  | {
      status: "complete";
      runId: string;
      runDirectory: string;
      manifestSha256: string;
      schemaViewsSidecarPath: string | null;
    }
  | { status: "help"; usage: string };

/** Run the CLI flow without calling process.exit, which keeps it testable. */
export async function runExportCli(args: readonly string[]): Promise<ExportCliResult> {
  let parsed: ParsedCliOptions;
  try {
    parsed = parseExportCliArgs(args);
  } catch (error) {
    if (error instanceof ExportError && error.code === "cli_help") {
      return { status: "help", usage: error.message };
    }
    throw error;
  }

  const profile = await loadConnectionProfile(parsed.connectionFile);
  // Keep the assertion here as well as in runExport: this is the point where a
  // profile password first exists in this process, and the check documents that
  // no caller may have smuggled it into argv.
  assertNoCredentialInProcessArguments(profile, process.argv);
  const expectedProjectRef = profile.identity.projectRef;
  if (!expectedProjectRef) {
    throw cliError(
      "cli_project_ref_required",
      "The connection profile must declare identity.project_ref before a real inventory can be selected.",
    );
  }

  const plan = await loadExportPlanFromInventoryFile(resolve(parsed.inventory), {
    schema: parsed.schema,
    expectedProjectRef,
    include: parsed.include,
  });
  const result = await runExport({
    profile,
    plan,
    outputRoot: resolve(parsed.outputRoot),
    codeRevision: parsed.codeRevision,
    connectTimeoutMs: parsed.connectTimeoutMs,
    statementTimeoutMs: parsed.statementTimeoutMs,
    allowInsideGitWorktree: parsed.allowInsideGitWorktree,
  });
  return {
    status: "complete",
    runId: result.runId,
    runDirectory: result.runDirectory,
    manifestSha256: result.manifestSha256,
    schemaViewsSidecarPath: result.schemaViewsSidecarPath,
  };
}

async function main(): Promise<void> {
  try {
    const result = await runExportCli(process.argv.slice(2));
    if (result.status === "help") {
      process.stdout.write(result.usage);
      return;
    }
    process.stdout.write(
      `${JSON.stringify({
        status: result.status,
        run_id: result.runId,
        run_directory: result.runDirectory,
        manifest_sha256: result.manifestSha256,
        schema_views_sidecar: result.schemaViewsSidecarPath,
      })}\n`,
    );
  } catch (error) {
    const failure = describeFailure(error);
    process.stderr.write(`${JSON.stringify({ status: "failed", code: failure.code, message: failure.message })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main();
}
