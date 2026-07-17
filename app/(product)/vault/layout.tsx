import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Vault",
  description: "Choose your session, mood, and goal, then let Vault Shuffle find the right Steam game to play.",
  alternates: { canonical: "/vault" },
  openGraph: { url: "/vault" }
};

export default function VaultLayout({ children }: { children: ReactNode }) {
  return children;
}
