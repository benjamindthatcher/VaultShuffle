import type { VerifiedServerPrincipal } from "../db/client.ts";
import type { SessionRepository } from "../repositories/session-core.ts";
import { InvalidPageQueryError, PageCursorRestartRequiredError } from "../repositories/page-errors.ts";
import { RequestLimitError } from "../db/errors.ts";
import { FamilyRequestError } from "../repositories/family-core.ts";
import { ImportRequestError } from "../repositories/import-core.ts";
import { PinnedRefreshError } from "../repositories/pinned-core.ts";

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };

export async function authenticatedRead<T extends { sessions: Pick<SessionRepository, "resolveCookie"> }>(
  token: string | undefined,
  secret: string | undefined,
  services: () => Promise<T>,
  read: (runtime: T, principal: VerifiedServerPrincipal) => Promise<unknown>,
): Promise<Response> {
  if (!token) return Response.json({ error: "session_required" }, { status: 401, headers });
  try {
    if (!secret) throw Error("Missing session configuration");
    const runtime = await services();
    const session = await runtime.sessions.resolveCookie(token, secret);
    if (!session) return Response.json({ error: "session_required" }, { status: 401, headers });
    const payload = await read(runtime, session.principal);
    if (payload === null) return Response.json({ error: "not_found" }, { status: 404, headers });
    return Response.json(payload, { headers });
  } catch (error) {
    if (error instanceof RequestLimitError) {
      return Response.json({ error: "rate_limited", retryable: true, retry_after_seconds: error.retryAfterSeconds },
        { status: 429, headers: { ...headers, "Retry-After": String(error.retryAfterSeconds) } });
    }
    if (error instanceof InvalidPageQueryError || error instanceof PageCursorRestartRequiredError) {
      const body=error instanceof FamilyRequestError || error instanceof ImportRequestError || error instanceof PinnedRefreshError
        ? {error:error.message,code:error.code,retryable:false}
        : {error:error.code,retryable:false};
      return Response.json(body, { status: error.status, headers });
    }
    return Response.json({ error: "database_unavailable", retryable: true }, { status: 503, headers: { ...headers, "Retry-After": "5" } });
  }
}
