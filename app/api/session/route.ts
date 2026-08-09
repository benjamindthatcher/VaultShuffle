import { NextResponse } from "next/server";
import { getSessionPayload } from "@/lib/session-payload";

export async function GET() {
  return NextResponse.json(await getSessionPayload());
}
