import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "What to play next",
  description: "Suggestions from your own Steam backlog, based on what you have finished, played and set aside.",
  alternates: { canonical: "/play-next" },
  openGraph: { url: "/play-next" }
};

export default function PlayNextLayout({ children }: { children: ReactNode }) {
  return children;
}
