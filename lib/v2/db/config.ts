export type DatabaseConfig = Readonly<{
  connectionString: string;
  maxConnections: number;
  connectTimeoutSeconds: number;
  idleTimeoutSeconds: number;
  /** Direct local fixtures may use a Unix-domain socket instead of TCP. */
  socketPath?: string;
  /** Optional explicitly supplied CA for the Supabase TLS chain. */
  tlsCaPem?: string;
}>;

export type DatabaseConfigInput = Readonly<{
  connectionString?: unknown;
  maxConnections?: unknown;
  connectTimeoutSeconds?: unknown;
  idleTimeoutSeconds?: unknown;
  socketPath?: unknown;
  tlsCaPem?: unknown;
}>;

const DEFAULT_MAX_CONNECTIONS = 4;
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 5;
const DEFAULT_IDLE_TIMEOUT_SECONDS = 20;

/**
 * Runtime credentials are supplied by the server composition root. This parser
 * intentionally does not inspect environment variables or configuration files.
 */
export function parseDatabaseConfig(input: DatabaseConfigInput): DatabaseConfig {
  if (!input || typeof input !== "object") throw new DatabaseConfigError("configuration is required");
  if (typeof input.connectionString !== "string" || input.connectionString.length === 0) {
    throw new DatabaseConfigError("connection string is required");
  }

  let url: URL;
  try {
    url = new URL(input.connectionString);
  } catch {
    throw new DatabaseConfigError("connection string is invalid");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new DatabaseConfigError("connection string must use PostgreSQL");
  }
  if (!url.hostname && !url.searchParams.has("host")) {
    throw new DatabaseConfigError("connection string host is required");
  }

  if (input.socketPath !== undefined && (typeof input.socketPath !== "string" || !input.socketPath.startsWith("/"))) {
    throw new DatabaseConfigError("socket path must be absolute");
  }
  if (input.tlsCaPem !== undefined && (typeof input.tlsCaPem !== "string" || !input.tlsCaPem.includes("BEGIN CERTIFICATE"))) {
    throw new DatabaseConfigError("TLS CA must be PEM certificate text");
  }

  return Object.freeze({
    connectionString: input.connectionString,
    maxConnections: boundedInteger(input.maxConnections, DEFAULT_MAX_CONNECTIONS, 1, 5, "max connections"),
    connectTimeoutSeconds: boundedInteger(
      input.connectTimeoutSeconds,
      DEFAULT_CONNECT_TIMEOUT_SECONDS,
      1,
      30,
      "connect timeout"
    ),
    idleTimeoutSeconds: boundedInteger(
      input.idleTimeoutSeconds,
      DEFAULT_IDLE_TIMEOUT_SECONDS,
      1,
      300,
      "idle timeout"
    ),
    ...(typeof input.socketPath === "string" ? { socketPath: input.socketPath } : {}),
    ...(typeof input.tlsCaPem === "string" ? { tlsCaPem: input.tlsCaPem } : {}),
  });
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || typeof value !== "number" || value < min || value > max) {
    throw new DatabaseConfigError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(`Invalid v2 database configuration: ${message}`);
    this.name = "DatabaseConfigError";
  }
}
