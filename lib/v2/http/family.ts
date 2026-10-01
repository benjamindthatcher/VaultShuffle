import "server-only";
import {FAMILY_SHARING_ENABLED} from "../../family-flag.ts";
import {FamilyRequestError} from "../repositories/family-core.ts";
import {v2Read,v2Write} from "./request.ts";

export function familyRead(read:Parameters<typeof v2Read>[0]) {
  if(!FAMILY_SHARING_ENABLED)return Promise.resolve(Response.json({error:'Not found.'},{status:404}));
  return v2Read(read);
}
export function familyWrite(request:Request,write:Parameters<typeof v2Write>[1]) {
  if(!FAMILY_SHARING_ENABLED)return Promise.resolve(Response.json({error:'Not found.'},{status:404}));
  return v2Write(request,write);
}
export function familyProfile(value:unknown):string {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1
    ||!('profile' in value)||typeof value.profile!=='string'||value.profile.trim().length<2||value.profile.length>300)
    throw new FamilyRequestError('invalid_profile','Enter a Steam profile URL or 17-digit Steam ID.');
  return value.profile.trim();
}
