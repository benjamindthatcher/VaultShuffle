import {familyRead,familyWrite,familyProfile} from "@/lib/v2/http/family";
import {v2JsonBody} from "@/lib/v2/http/request";
import {addV2FamilyMember} from "@/lib/v2/family-lookup";
import {fetchSteamPlayerSummary} from "@/lib/steam";
import {MAX_FAMILY_MEMBERS} from "@/lib/family-sharing";

export const runtime='nodejs';
export const maxDuration=60;
export function GET() {
  return familyRead(async(services,principal)=>({enabled:true,max_members:MAX_FAMILY_MEMBERS,members:await services.family.list(principal)}));
}
export function POST(request:Request) {
  return familyWrite(request,async(services,principal)=>addV2FamilyMember(services.family,principal,familyProfile(await v2JsonBody(request)),{
    apiKey:process.env.STEAM_WEB_API_KEY?.trim()??'',fetch,nowEpochSeconds:()=>Math.floor(Date.now()/1000),
    profile:(id,key)=>fetchSteamPlayerSummary(id,key,true),
  }));
}
