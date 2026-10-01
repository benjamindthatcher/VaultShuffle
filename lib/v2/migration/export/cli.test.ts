import assert from "node:assert/strict";
import test from "node:test";
import { ExportError } from "../shared/redaction.ts";
import { EXPORT_CLI_USAGE, parseExportCliArgs, runExportCli } from "./cli.ts";

test("the export entrypoint requires an explicit read-only confirmation", () => {
  assert.throws(
    () => parseExportCliArgs(["--connection-file", "/private/profile.json", "--output-root", "/private/out"]),
    (error: unknown) => error instanceof ExportError && error.code === "cli_confirmation_required",
  );
});

test("the export entrypoint accepts only path/options and never echoes unknown values", () => {
  const secret = "synthetic-command-secret-should-never-appear";
  assert.throws(
    () =>
      parseExportCliArgs([
        "--confirm-read-only-source",
        "--connection-file",
        "/private/profile.json",
        "--output-root",
        "/private/out",
        "--password",
        secret,
      ]),
    (error: unknown) => {
      assert.ok(error instanceof ExportError);
      assert.equal(error.code, "cli_argument_unknown");
      assert.ok(!error.message.includes(secret));
      return true;
    },
  );
});

test("--help is available without reading a profile", async () => {
  const result = await runExportCli(["--help"]);
  assert.equal(result.status, "help");
  if (result.status === "help") assert.equal(result.usage, EXPORT_CLI_USAGE);
});

test("CLI option parsing keeps relation order explicit and bounds timeout values", () => {
  const parsed = parseExportCliArgs([
    "--confirm-read-only-source",
    "--connection-file",
    "/private/profile.json",
    "--output-root",
    "/private/out",
    "--inventory",
    "/private/inventory.json",
    "--schema",
    "public",
    "--include",
    "user_games,catalog_games",
    "--code-revision",
    "synthetic-revision",
    "--connect-timeout-ms",
    "5000",
    "--statement-timeout-ms",
    "60000",
    "--allow-inside-git-worktree",
  ]);
  assert.deepEqual(parsed.include, ["user_games", "catalog_games"]);
  assert.equal(parsed.connectTimeoutMs, 5000);
  assert.equal(parsed.statementTimeoutMs, 60000);
  assert.equal(parsed.allowInsideGitWorktree, true);
});
