import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in with Steam to sync your library and use Vault Shuffle across devices.",
  robots: { index: false, follow: true }
};

export default function LoginLayout({ children }: { children: ReactNode }) {
  return children;
}
