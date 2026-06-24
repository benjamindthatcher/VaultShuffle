import { NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/auth";

export async function GET() {
  const session = await getCurrentSession();
  return NextResponse.json({
    logged_in: Boolean(session),
    steam_id: session?.user.steam_id ?? "",
    has_steam_key: Boolean(process.env.STEAM_WEB_API_KEY)
  });
}
