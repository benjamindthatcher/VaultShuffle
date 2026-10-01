import { v2Read } from "@/lib/v2/http/request";

export const runtime = "nodejs";

export async function GET() {
  return v2Read((services, principal) => services.bootstrap.read(principal));
}
