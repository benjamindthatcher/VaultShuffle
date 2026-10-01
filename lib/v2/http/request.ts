import "server-only";
import { cookies } from "next/headers";
import { getV2Runtime } from "../runtime.ts";
import { VAULT_SESSION_COOKIE_NAME } from "../repositories/session-core.ts";
import type { VerifiedServerPrincipal } from "../db/client.ts";
import { authenticatedRead } from "./read-response.ts";
import { createHmac } from "node:crypto";
import { RequestLimitError, DatabaseUnavailableError } from "../db/errors.ts";
import { assertSameOrigin, readJsonBody } from "../../http.ts";
import { InvalidPageQueryError } from "../repositories/page-errors.ts";

export async function v2Read(read: (runtime: Awaited<ReturnType<typeof getV2Runtime>>, principal: VerifiedServerPrincipal) => Promise<unknown>) {
  const token = (await cookies()).get(VAULT_SESSION_COOKIE_NAME)?.value;
  return authenticatedRead(token, process.env.SESSION_SECRET, getV2Runtime, read);
}

export async function v2Write(request: Request, write: (runtime: Awaited<ReturnType<typeof getV2Runtime>>, principal: VerifiedServerPrincipal) => Promise<unknown>) {
  try { assertSameOrigin(request); }
  catch { return Response.json({ error: "same_origin_required" }, { status: 403, headers: { "Cache-Control": "private, no-store" } }); }
  return v2Read(async (runtime, principal) => {
    const secret = process.env.RATE_LIMIT_SECRET || process.env.SESSION_SECRET;
    if (!secret) throw new DatabaseUnavailableError();
    const digest = createHmac("sha256",secret).update(`authenticated_write\u001fuser:${principal.accountPublicId}`).digest();
    const rows = await runtime.database.withPrincipal(principal, tx => tx<{ allowed: boolean; retry_after_seconds: number }[]>`
      select allowed,retry_after_seconds from app.consume_request_limit('authenticated_write',${digest},120,60)`);
    if (!rows[0]) throw new DatabaseUnavailableError();
    if (!rows[0].allowed) throw new RequestLimitError(Math.max(1,rows[0].retry_after_seconds));
    return write(runtime,principal);
  });
}

export async function v2JsonBody(request: Request): Promise<unknown> {
  try { return await readJsonBody(request,32*1024); }
  catch { throw new InvalidPageQueryError("Invalid request body."); }
}
