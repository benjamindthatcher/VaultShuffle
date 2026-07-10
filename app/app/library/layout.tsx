import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Library",
  description: "Search, filter, organise, and track progress across your Steam game library."
};

export default function LibraryLayout({ children }: { children: ReactNode }) {
  return children;
}
