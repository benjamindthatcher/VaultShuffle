import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell/AppShell";
import styles from "./SharedInformationShell.module.css";

export function SharedInformationShell({ children }: { children: ReactNode }) {
  return (
    <AppShell headerVariant="utility">
      <div className={styles.content}>{children}</div>
    </AppShell>
  );
}
