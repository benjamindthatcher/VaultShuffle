import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell/AppShell";
import { privateProductRobots } from "@/lib/site";

export const metadata: Metadata = {
  robots: privateProductRobots
};

export default function AuthenticatedAppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
