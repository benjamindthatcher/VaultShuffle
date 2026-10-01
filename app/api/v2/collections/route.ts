import { v2Read, v2Write, v2JsonBody } from "@/lib/v2/http/request";
import type { CollectionInput } from "@/lib/v2/repositories/collection-mutations";
import { dashboardQuery } from "@/lib/v2/http/dashboard-query";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return v2Read(async (services, principal) => {
    return { collections: await services.collections.list(principal, dashboardQuery(new URL(request.url).searchParams)) };
  });
}

export async function POST(request:Request) {
  return v2Write(request,async(services,principal)=>{
    const id=await services.collectionMutations.create(principal,await v2JsonBody(request) as CollectionInput);
    return {ok:true,collectionId:id};
  });
}
