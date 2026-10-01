import { cookies } from "next/headers";
import { bootstrapResponse } from "@/lib/v2/http/bootstrap";
import { VAULT_SESSION_COOKIE_NAME } from "@/lib/v2/repositories/session-core";
import { getV2Runtime } from "@/lib/v2/runtime";

export const runtime = "nodejs";

export async function GET() {
  const token = (await cookies()).get(VAULT_SESSION_COOKIE_NAME)?.value;
  return bootstrapResponse(token, process.env.SESSION_SECRET, getV2Runtime);
}
