import { v2Read } from "@/lib/v2/http/request";
import { dashboardQuery } from "@/lib/v2/http/dashboard-query";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return v2Read((services, principal) => {
    return services.dashboard.read(principal, dashboardQuery(new URL(request.url).searchParams));
  });
}
