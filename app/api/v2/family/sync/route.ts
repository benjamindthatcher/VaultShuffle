import {familyWrite} from "@/lib/v2/http/family";
export const runtime='nodejs';
export function POST(request:Request) {
  return familyWrite(request,async(services,principal)=>({ok:true,counts:await services.family.recheck(principal)}));
}
