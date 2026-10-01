import { v2Write } from "@/lib/v2/http/request";
import { libraryGameId } from "@/lib/v2/http/library-query";

export const runtime="nodejs";
export async function DELETE(request:Request,context:{params:Promise<{id:string;gameId:string}>}) {
  const {id,gameId}=await context.params;
  return v2Write(request,async(services,principal)=>{
    await services.collectionMutations.removeGame(principal,id,libraryGameId(gameId));
    return {ok:true};
  });
}
