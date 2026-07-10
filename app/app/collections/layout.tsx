import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Collections",
  description: "Build custom shelves and automatic Smart Collections for your Steam library."
};

export default function CollectionsLayout({ children }: { children: ReactNode }) {
  return children;
}
