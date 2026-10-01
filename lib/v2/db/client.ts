import postgres, { type Sql, type TransactionSql } from "postgres";
import type { DatabaseConfig } from "./config.ts";
import { DatabaseUnavailableError } from "./errors.ts";

export type VerifiedServerPrincipal = Readonly<{
  accountId: number;
  accountPublicId: string;
  accountKind: "manual" | "steam";
  /** Kept as decimal text because the app targets ES2017. */
  sessionId: string;
  sessionKind: "manual" | "verified_steam";
  identityVerified: boolean;
}>;

export type TenantTransaction = TransactionSql<any>;

export type DatabaseClient = Readonly<{
  sql: Sql<any>;
  withPrincipal<T>(principal: VerifiedServerPrincipal, operation: (tx: TenantTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}>;

/**
 * Creates the ordinary-request client. TCP connections always verify TLS and
 * prepared statements stay disabled for Supavisor transaction pooling.
 */
export function createDatabaseClient(config: DatabaseConfig): DatabaseClient {
  const sql = postgres<any>(config.connectionString, {
    max: config.maxConnections,
    prepare: false,
    ssl: config.socketPath ? false : {
      rejectUnauthorized: true,
      ...(config.tlsCaPem ? { ca: config.tlsCaPem } : {}),
    },
    // postgres.js derives `.s.PGSQL.<port>` from a Unix socket host. Passing a
    // directory as `path` would instead attempt to connect to the directory.
    ...(config.socketPath ? { host: config.socketPath } : {}),
    connect_timeout: config.connectTimeoutSeconds,
    idle_timeout: config.idleTimeoutSeconds,
    onnotice: () => {},
  });

  return Object.freeze({
    sql,
    async withPrincipal<T>(principal: VerifiedServerPrincipal, operation: (tx: TenantTransaction) => Promise<T>) {
      assertPrincipal(principal);
      const result = await sql.begin(async (tx) => {
        await tx`select set_config('app.account_id', ${String(principal.accountId)}, true)`;
        return operation(tx);
      });
      return result as T;
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  });
}

function assertPrincipal(principal: VerifiedServerPrincipal): void {
  if (!Number.isSafeInteger(principal.accountId) || principal.accountId < 1
    || !/^[1-9][0-9]*$/.test(principal.sessionId)
    || (principal.accountKind !== "manual" && principal.accountKind !== "steam")
    || (principal.sessionKind !== "manual" && principal.sessionKind !== "verified_steam")
    || typeof principal.identityVerified !== "boolean"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(principal.accountPublicId)) {
    throw new DatabaseUnavailableError();
  }
  if ((principal.sessionKind === "manual" && (principal.accountKind !== "manual" || principal.identityVerified))
    || (principal.sessionKind === "verified_steam" && (principal.accountKind !== "steam" || !principal.identityVerified))) {
    throw new DatabaseUnavailableError();
  }
}
