import { z } from "zod";
import { v2Read, v2Write, v2JsonBody } from "@/lib/v2/http/request";
import { collectionPageQuery } from "@/lib/v2/http/page-query";
import { InvalidPageQueryError } from "@/lib/v2/repositories/page-errors";

export const runtime = "nodejs";
const batch = z.object({
  action:z.enum(["claimed","dismissed"]),
  game_ids:z.array(z.number().int().min(1).max(2147483647)).min(1).max(500),
  request_key:z.string().uuid(),surface:z.enum(["sweep","sweep_bulk"]).default("sweep_bulk"),
}).strict();
export async function GET(request:Request) {
  return v2Read((services,principal)=>services.library.completionReview(principal,collectionPageQuery(new URL(request.url).searchParams)));
}
export async function POST(request:Request) {
  return v2Write(request,async(services,principal)=>{
    const parsed=batch.safeParse(await v2JsonBody(request));
    if(!parsed.success)throw new InvalidPageQueryError();
    const {action,game_ids,request_key,surface}=parsed.data;
    return services.mutations.completionBatch(principal,game_ids,action,request_key,surface);
  });
}
