import "server-only";
import { cookies } from "next/headers";
import { getV2Runtime } from "./runtime.ts";
import { VAULT_SESSION_COOKIE_NAME } from "./repositories/session-core.ts";
import { DatabaseUnavailableError } from "./db/errors.ts";

export async function currentV2Session() {
  const token = (await cookies()).get(VAULT_SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new DatabaseUnavailableError();
  const runtime = await getV2Runtime();
  const resolved = await runtime.sessions.resolveCookie(token, secret);
  if (!resolved) return null;
  return { ...resolved, ...(await runtime.auth.readUser(resolved.principal)), sessionId: resolved.principal.sessionId };
}
