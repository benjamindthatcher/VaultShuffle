import { v2Read, v2Write, v2JsonBody } from "@/lib/v2/http/request";
import type { CollectionInput } from "@/lib/v2/repositories/collection-mutations";
import { noPageQuery } from "@/lib/v2/http/page-query";

export const runtime="nodejs";
type Context={params:Promise<{id:string}>};
export async function GET(request:Request,context:Context) {
  const {id}=await context.params;
  return v2Read(async(services,principal)=>{
    noPageQuery(new URL(request.url).searchParams);
    const page=await services.collections.members(principal,id,{limit:1});
    return page?.collection??null;
  });
}
export async function PATCH(request:Request,context:Context) {
  const {id}=await context.params;
  return v2Write(request,async(services,principal)=>{
    await services.collectionMutations.update(principal,id,await v2JsonBody(request) as Partial<CollectionInput>);
    return {ok:true,collection:(await services.collections.members(principal,id,{limit:1}))?.collection};
  });
}
export async function DELETE(request:Request,context:Context) {
  const {id}=await context.params;
  return v2Write(request,async(services,principal)=>{
    await services.collectionMutations.remove(principal,id);
    return {ok:true};
  });
}
