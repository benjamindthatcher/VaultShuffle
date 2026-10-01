import { z } from "zod";
import { v2Write, v2JsonBody, v2Read } from "@/lib/v2/http/request";
import { InvalidPageQueryError } from "@/lib/v2/repositories/page-errors";

export const runtime = "nodejs";
const schema = z.object({ action:z.enum(["pin","unpin"]), game_id:z.number().int().min(1).max(2147483647), replace_game_id:z.number().int().min(1).max(2147483647).optional() }).strict();

export async function GET() { return v2Read(async (services,principal) => ({ pins:(await services.bootstrap.read(principal)).pins })); }

export async function POST(request: Request) {
  return v2Write(request,async (services,principal) => {
    const parsed = schema.safeParse(await v2JsonBody(request));
    if (!parsed.success || (parsed.data.action==='unpin' && parsed.data.replace_game_id!==undefined)) throw new InvalidPageQueryError();
    const data = parsed.data;
    if (data.action==='pin') await services.mutations.pin(principal,data.game_id,data.replace_game_id);
    else await services.mutations.unpin(principal,data.game_id);
    return { pins:(await services.bootstrap.read(principal)).pins };
  });
}
