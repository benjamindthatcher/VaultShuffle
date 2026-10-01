import { v2Write } from "@/lib/v2/http/request";
import { readJsonBody } from "@/lib/http";
import { vaultSetup, vaultDrawRequest } from "@/lib/v2/http/vault-query";
import { InvalidPageQueryError } from "@/lib/v2/repositories/page-errors";

export const runtime = "nodejs";
export async function POST(request: Request) {
  return v2Write(request, async (services, principal) => services.vault.draw(principal, vaultDrawRequest(await body(request))));
}
// A read with a bounded JSON setup, protected by the same origin/session/rate
// boundary. PATCH previews only; POST decides and records one server-side draw.
export async function PATCH(request: Request) {
  return v2Write(request, async (services, principal) => services.vault.preview(principal, vaultSetup(await body(request))));
}
async function body(request: Request) {
  try { return await readJsonBody(request, 384 * 1024); }
  catch { throw new InvalidPageQueryError(); }
}
