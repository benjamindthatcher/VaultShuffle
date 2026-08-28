"use client";

import { useSearchParams } from "next/navigation";

/**
 * A failed Steam callback used to land on /login?error=..., where nothing ever
 * rendered it — the sign-in simply appeared to do nothing. With that page gone
 * the callback comes back here instead, and this says so.
 *
 * A client island rather than a searchParams prop on the page: reading search
 * params on the server would opt the whole landing page out of static
 * rendering, for a message almost nobody sees.
 */
export function SignInNotice({ className }: { className?: string }) {
  const message = useSearchParams().get("signin");
  if (!message) return null;

  return (
    <p className={className} role="alert">
      {message}
    </p>
  );
}
