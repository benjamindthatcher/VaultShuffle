import { NextResponse } from "next/server";
import { clearSessionCookie, deleteCurrentSession } from "@/lib/auth";

export async function POST() {
  await deleteCurrentSession();
  return clearSessionCookie(NextResponse.json({ ok: true }));
}
