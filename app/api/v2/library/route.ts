import { v2Read } from "@/lib/v2/http/request";
import { libraryQuery } from "@/lib/v2/http/library-query";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return v2Read((services, principal) => services.library.list(principal, libraryQuery(new URL(request.url).searchParams)));
}
