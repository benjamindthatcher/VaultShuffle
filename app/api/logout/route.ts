import { NextResponse } from "next/server";
import { clearSessionCookie, deleteCurrentSession, getCurrentSession } from "@/lib/auth";
import { getPostHogClient } from "@/lib/posthog-server";

export async function POST() {
  const session = await getCurrentSession();
  await deleteCurrentSession();

  if (session) {
    const posthog = getPostHogClient();
    posthog.capture({
      distinctId: session.user.id,
      event: "user_signed_out",
    });
    await posthog.flush();
  }

  return clearSessionCookie(NextResponse.json({ ok: true }));
}
