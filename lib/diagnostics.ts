/** Deliberately allowlisted: never serialize an Error, URL, request or DB row. */
export const DIAGNOSTICS_COOKIE = "vault_diagnostics";
export const AUTH_TRACE_COOKIE = "vault_auth_trace";
export function diagnosticId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value) ? value : undefined;
}

// Unknown/dynamic segments are never sent to analytics, even if they look like names.
const ROUTE_SEGMENTS = new Set("api auth steam callback manual-profile lookup create account secure-profile session logout owned-games games collections vault draw draws events pin pins history preferences genre-preferences playtime summary analytics consent feedback contact catalogue process dashboard library purge stats export import completion complete review suggest tags health snapshot settings acknowledge secure app-data cron catalogue-metadata durations nightly-metadata steam-tags completions restore flags reviews state apps".split(" "));
export function diagnosticRoute(path: string) {
  return path.split(/[?#]/, 1)[0].split("/").filter(Boolean).slice(0, 8)
    .map((segment) => ROUTE_SEGMENTS.has(segment) ? segment : ":id").join("/").replace(/^/, "/");
}

const ERROR_CODES = new Set([
  "unexpected_error", "invalid_request", "unauthorized", "session_lookup_failed", "rate_limited",
  "steam_rate_limited", "steam_timeout", "steam_network_error", "steam_http_error", "steam_invalid_response",
  "profile_not_found", "invalid_profile", "invalid_steam_id", "invalid_profile_url", "invalid_input", "invalid_host",
  "library_private", "library_empty", "library_unavailable", "steam_library_private", "steam_unavailable",
  "lookup_expired", "invalid_lookup", "session_exists", "steam_sign_in_cancelled", "steam_identity_missing",
  "steam_identity_unverified", "link_session_missing", "link_intent_invalid", "link_session_mismatch",
  "link_intent_consumed", "link_intent_expired", "steam_account_mismatch", "link_merge_failed", "link_merge_conflict",
  "configuration_missing", "cache_unavailable", "import_staging_failed", "analytics_delivery_failed",
]);
export type DiagnosticProperties = Record<string, string | number | boolean>;
const TEXT_FIELDS = new Set(["operation", "stage", "outcome", "account_type", "source", "cache_result", "upstream_operation", "error_type"]);
const ID_FIELDS = new Set(["request_id", "operation_id", "flow_id", "account_id", "replay_id"]);
const NUMBER_FIELDS = new Set(["status", "upstream_status", "retry_after_seconds", "duration_ms", "stage_duration_ms", "game_count", "imported", "total", "attempt"]);
export function safeDiagnosticProperties(input: Record<string, unknown>): DiagnosticProperties {
  const safe: DiagnosticProperties = {};
  for (const [key, value] of Object.entries(input)) {
    if (ID_FIELDS.has(key)) { const id = diagnosticId(value); if (id) safe[key] = id; }
    else if (NUMBER_FIELDS.has(key) && typeof value === "number" && Number.isFinite(value)) safe[key] = Math.max(0, Math.min(1e9, value));
    else if (key === "route" && typeof value === "string") safe[key] = diagnosticRoute(value);
    else if (key === "method" && typeof value === "string" && /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(value)) safe[key] = value;
    else if (key === "error_code" && typeof value === "string") safe[key] = ERROR_CODES.has(value) ? value : "unexpected_error";
    else if (key === "database_code" && typeof value === "string" && /^(?:[0-9]{2}[A-Z0-9]{3}|P000[1-4]|XX00[012]|PGRST[0-9]{3})$/.test(value)) safe[key] = value;
    else if (key === "digest" && typeof value === "string" && /^[0-9]{1,20}$/.test(value)) safe[key] = value;
    else if (key === "error_fingerprint" && typeof value === "string" && /^[a-f0-9]{8}$/.test(value)) safe[key] = value;
    else if (TEXT_FIELDS.has(key) && typeof value === "string" && /^[a-z][a-z0-9_]{0,59}$/.test(value)) safe[key] = value;
  }
  return safe;
}

export function diagnosticFailure(error: unknown): DiagnosticProperties {
  const item = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const cause = item.cause && typeof item.cause === "object" ? item.cause as Record<string, unknown> : {};
  const nestedCause = cause.cause && typeof cause.cause === "object" ? cause.cause as Record<string, unknown> : {};
  const name = error instanceof Error ? error.name : "UnknownError";
  const type = ({ ZodError: "validation", SessionRequiredError: "session", SessionLookupError: "session", SteamApiError: "steam", ManualSteamProfileError: "profile", ManualProfileSecurityError: "account_link", SteamLibraryUnavailableError: "library", HttpError: "request", TypeError: "type_error", SyntaxError: "syntax_error", TimeoutError: "timeout", AbortError: "aborted", CooldownError: "rate_limit" } as Record<string, string>)[name] ?? "unexpected";
  const code = typeof item.code === "string" && ERROR_CODES.has(item.code) ? item.code
    : error instanceof Error && /^Missing required environment variable:/i.test(error.message) ? "configuration_missing"
    : name === "ZodError" || name === "HttpError" ? "invalid_request"
      : name === "SessionRequiredError" ? "unauthorized" : name === "SessionLookupError" ? "session_lookup_failed" : "unexpected_error";
  // Group unexpected failures by code location without exporting raw stacks or
  // error messages (which often contain URLs, credentials or database values).
  const frames = error instanceof Error ? error.stack?.split("\n").slice(1).flatMap((line) => line.match(/[a-zA-Z0-9_.-]+\.(?:js|mjs|ts|tsx):[0-9]+:[0-9]+/g) ?? []).slice(0, 4).join("|") : "";
  let hash = 2166136261;
  for (const char of `${type}:${code}:${frames ?? ""}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return safeDiagnosticProperties({ error_type: type, error_code: code, error_fingerprint: (hash >>> 0).toString(16).padStart(8, "0"), database_code: nestedCause.code ?? cause.code ?? item.code, digest: item.digest,
    upstream_status: item.upstreamStatus ?? cause.upstreamStatus ?? nestedCause.upstreamStatus,
    upstream_operation: item.operation ?? cause.operation ?? nestedCause.operation,
    retry_after_seconds: item.retryAfterSeconds ?? cause.retryAfterSeconds ?? nestedCause.retryAfterSeconds });
}

export function diagnosticConsent(headers: Headers) {
  if (headers.get("dnt") === "1" || headers.get("sec-gpc") === "1") return { enabled: false };
  const cookie = headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${DIAGNOSTICS_COOKIE}=`))?.slice(DIAGNOSTICS_COOKIE.length + 1);
  const [mode, person, replay] = (cookie ?? "").split(".");
  return { enabled: mode === "enabled", person: diagnosticId(person), replay: diagnosticId(replay) };
}
