import {familyWrite} from "@/lib/v2/http/family";
export const runtime='nodejs';
export async function DELETE(request:Request,context:{params:Promise<{id:string}>}) {
  const {id}=await context.params;
  return familyWrite(request,async(services,principal)=>({ok:true,...await services.family.remove(principal,id)}));
}
