import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      error:
        "Steam API keys now belong in Vercel/Supabase environment variables. Add STEAM_WEB_API_KEY to .env.local and Vercel instead of saving it from the browser."
    },
    { status: 400 }
  );
}
