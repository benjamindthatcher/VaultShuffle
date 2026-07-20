import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Purge",
  description: "Review neglected games safely and keep your VaultShuffle library focused.",
  alternates: { canonical: "/purge" },
  openGraph: { url: "/purge" }
};

export default function PurgeLayout({ children }: { children: ReactNode }) {
  return children;
}
