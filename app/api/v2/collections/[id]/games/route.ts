import { v2Read, v2Write, v2JsonBody } from "@/lib/v2/http/request";
import { z } from "zod";
import { InvalidPageQueryError } from "@/lib/v2/repositories/page-errors";
import { collectionQuery } from "@/lib/v2/http/collection-query";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return v2Read((services, principal) => services.collections.members(principal, id, collectionQuery(new URL(request.url).searchParams)));
}

const singleMemberSchema=z.object({game_id:z.number().int().min(1).max(2147483647),notes:z.string().trim().max(500).optional(),position:z.number().int().min(0).max(2147483647).optional()}).strict();
const memberSchema=z.union([singleMemberSchema,z.object({game_ids:z.array(z.number().int().min(1).max(2147483647)).min(1).max(1000)}).strict()]);
export async function POST(request:Request,context:{params:Promise<{id:string}>}) {
  const {id}=await context.params;
  return v2Write(request,async(services,principal)=>{
    const parsed=memberSchema.safeParse(await v2JsonBody(request));
    if(!parsed.success) throw new InvalidPageQueryError();
    if('game_ids' in parsed.data)await services.collectionMutations.addGames(principal,id,parsed.data.game_ids);
    else await services.collectionMutations.addGame(principal,id,parsed.data.game_id,parsed.data.notes,parsed.data.position);
    return {ok:true};
  });
}
