import { z } from "zod";
import { v2Write, v2JsonBody } from "@/lib/v2/http/request";
import { InvalidPageQueryError } from "@/lib/v2/repositories/page-errors";
export const runtime = "nodejs";
const clear = z.object({ game_id:z.number().int().min(1).max(2147483647).optional() }).strict();
export async function DELETE(request: Request) {
  return v2Write(request, async (services, principal) => {
    const parsed = clear.safeParse(await v2JsonBody(request));
    if (!parsed.success) throw new InvalidPageQueryError();
    return services.vault.clearSnoozes(principal, parsed.data.game_id);
  });
}
