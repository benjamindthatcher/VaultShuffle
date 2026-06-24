import { NextResponse } from "next/server";
import { siteBaseUrl, steamAuthUrl } from "@/lib/steam";

export async function GET(request: Request) {
  return NextResponse.redirect(steamAuthUrl(siteBaseUrl(request)));
}
