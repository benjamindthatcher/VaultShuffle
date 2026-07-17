import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell/AppShell";

export default function AuthenticatedAppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
