import { v2Read } from "@/lib/v2/http/request";
import { wishlistPageQuery } from "@/lib/v2/http/page-query";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return v2Read((services, principal) => {
    const { offset, limit } = wishlistPageQuery(new URL(request.url).searchParams);
    return services.wishlist.list(principal, offset, limit);
  });
}
